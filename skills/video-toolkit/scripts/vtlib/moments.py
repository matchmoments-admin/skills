"""Validating a moments.json before anything tries to render it.

`moments.json` is declared as the contract every downstream stage reads, but it
is written freehand by a model following prose. The invariants that prose asks
for — edges on clause breaks, sane lengths, no overlaps — are cheap to check and
expensive to violate: a bad edge surfaces later as a clip that sounds chopped,
or an opaque ffmpeg error, neither of which points at the cause.

Everything here is pure. The caller loads the files and decides what to do with
the result.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field

from .candidates import containment, iou

# Both measures, matching `find_candidates` exactly. IoU alone misses nesting:
# a 17s window inside a 51s window scores 0.34 and would validate clean while
# the candidate stage had already rejected it — so a moments.json could contain
# a pair that the generator refuses to produce, and render it twice.
MAX_OVERLAP_IOU = 0.35
MAX_CONTAINMENT = 0.6

# How wide a window of alternative breaks to offer in an error message.
SUGGEST_WINDOW = 10.0


@dataclass(frozen=True)
class ClipConstraints:
    min_len: float = 15.0
    max_len: float = 90.0
    # Breaks are stored rounded to 3dp. A model writing "9764.9" freehand will
    # essentially never hit 9764.897 exactly, so membership means "within tol"
    # and the repaired output carries the exact break value. --strict demands
    # equality and is what fixtures use.
    tol: float = 0.05
    strict: bool = False

    def hits(self, value: float, target: float) -> bool:
        return value == target if self.strict else abs(value - target) <= self.tol


@dataclass(frozen=True)
class Violation:
    rank: int
    field: str          # start | end | duration | order | bounds | rank | source
    code: str
    message: str
    value: float | None = None
    suggestion: float | None = None


@dataclass
class Warning_:
    code: str
    message: str


@dataclass
class Report:
    violations: list[Violation] = field(default_factory=list)
    warnings: list[Warning_] = field(default_factory=list)
    repaired: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.violations


def bracket(value: float, breaks: list[float]) -> tuple[float | None, float | None]:
    """Nearest break at or below, and at or above. O(log n)."""
    if not breaks:
        return None, None
    i = bisect.bisect_left(breaks, value)
    if i < len(breaks) and breaks[i] == value:
        return breaks[i], breaks[i]
    below = breaks[i - 1] if i > 0 else None
    above = breaks[i] if i < len(breaks) else None
    return below, above


def nearest_break(value: float, breaks: list[float]) -> float | None:
    below, above = bracket(value, breaks)
    if below is None:
        return above
    if above is None:
        return below
    return below if (value - below) <= (above - value) else above


def _fmt(v: float) -> str:
    return f"{v:.2f}"


def _break_options(value: float, breaks: list[float]) -> str:
    near = [b for b in breaks if abs(b - value) <= SUGGEST_WINDOW]
    if not near:
        return ""
    return "    breaks within ±%gs: %s" % (
        SUGGEST_WINDOW, " ".join(_fmt(b) for b in near))


def _not_a_break_message(rank: int, which: str, value: float, other_edge: float,
                         breaks: list[float], c: ClipConstraints) -> str:
    """Name both neighbours and what each does to the clip length.

    The reader's next action is to *pick* a break, so give them the options and
    the consequence of each rather than a single number to copy blindly.
    """
    below, above = bracket(value, breaks)
    lines = [f"moment {rank}: {which}={_fmt(value)} is not a break "
             f"(tolerance {c.tol}s)."]
    for label, b in (("nearest below", below), ("nearest above", above)):
        if b is None:
            continue
        delta = b - value
        dur = abs(other_edge - b)
        fits = "ok" if c.min_len <= dur <= c.max_len else "OUT OF RANGE"
        lines.append(f"    {label}: {_fmt(b)}  ({delta:+.2f}s, "
                     f"duration would be {_fmt(dur)}s {fits})")
    opts = _break_options(value, breaks)
    if opts:
        lines.append(opts)
    return "\n".join(lines)


def validate_moments(moments: dict, transcript: dict,
                     c: ClipConstraints | None = None,
                     source_key: str | None = None) -> Report:
    """Check a moments.json against the transcript it claims to describe.

    Never raises and never writes. `report.repaired` is always produced, so the
    repair path is exercised on every call rather than only when --fix is used.
    """
    c = c or ClipConstraints()
    rep = Report()
    breaks: list[float] = sorted(transcript.get("breaks") or [])
    duration = float(transcript.get("duration") or 0)
    entries = moments.get("moments") or []

    # A moments.json validated against the wrong video's breaks fails silently
    # and completely — every edge looks wrong for reasons that make no sense.
    tkey = transcript.get("key")
    if source_key and tkey and source_key != tkey:
        rep.violations.append(Violation(
            rank=0, field="source", code="wrong_source",
            message=(f"moments source resolves to {source_key!r} but the "
                     f"transcript is for {tkey!r} — these are different videos"),
        ))

    if not entries:
        rep.violations.append(Violation(
            rank=0, field="source", code="empty",
            message="moments.json contains no moments"))

    repaired_entries = []
    for idx, m in enumerate(entries, 1):
        rank = m.get("rank", idx)
        out = dict(m)
        snapped = False
        try:
            start = float(m["start"])
            end = float(m["end"])
        except (KeyError, TypeError, ValueError):
            rep.violations.append(Violation(
                rank=rank, field="start", code="missing",
                message=f"moment {rank}: start and end must both be numbers"))
            repaired_entries.append(out)
            continue

        if start < 0 or (duration and end > duration):
            rep.violations.append(Violation(
                rank=rank, field="bounds", code="out_of_bounds",
                message=(f"moment {rank}: {_fmt(start)}–{_fmt(end)} falls outside "
                         f"the video (0–{_fmt(duration)}s)"),
                value=start))

        if start >= end:
            rep.violations.append(Violation(
                rank=rank, field="order", code="reversed",
                message=(f"moment {rank}: start {_fmt(start)} is not before "
                         f"end {_fmt(end)}"),
                value=start))
            repaired_entries.append(out)
            continue

        length = end - start
        if length < c.min_len:
            rep.violations.append(Violation(
                rank=rank, field="duration", code="too_short",
                message=(f"moment {rank}: {_fmt(length)}s is shorter than the "
                         f"{c.min_len}s minimum"),
                value=length))
        elif length > c.max_len:
            rep.violations.append(Violation(
                rank=rank, field="duration", code="too_long",
                message=(f"moment {rank}: {_fmt(length)}s exceeds the "
                         f"{c.max_len}s maximum"),
                value=length))

        for which, value, other in (("start", start, end), ("end", end, start)):
            exact = nearest_break(value, breaks)
            if exact is not None and c.hits(value, exact):
                if value != exact:
                    out[which] = exact
                    snapped = True
                continue
            rep.violations.append(Violation(
                rank=rank, field=which, code="not_a_break",
                message=_not_a_break_message(rank, which, value, other, breaks, c),
                value=value, suggestion=exact))

        if snapped:
            out["snapped"] = True
        repaired_entries.append(out)

    _check_ranks(entries, rep)
    _check_overlaps(entries, rep)
    _collect_warnings(moments, transcript, entries, c, rep)

    rep.repaired = {**moments, "moments": repaired_entries}
    return rep


def _check_ranks(entries: list[dict], rep: Report) -> None:
    ranks = [m.get("rank") for m in entries if isinstance(m.get("rank"), int)]
    if len(ranks) != len(entries):
        return  # some ranks missing; not worth a second complaint
    if sorted(ranks) != list(range(1, len(entries) + 1)):
        rep.violations.append(Violation(
            rank=0, field="rank", code="bad_ranks",
            message=(f"ranks must be 1..{len(entries)} with no gaps or "
                     f"duplicates, got {sorted(ranks)}")))


def _check_overlaps(entries: list[dict], rep: Report) -> None:
    spans = []
    for m in entries:
        try:
            spans.append((m.get("rank"), float(m["start"]), float(m["end"])))
        except (KeyError, TypeError, ValueError):
            continue
    for i, (ra, sa, ea) in enumerate(spans):
        for rb, sb, eb in spans[i + 1:]:
            overlap = iou((sa, ea), (sb, eb))
            nested = containment((sa, ea), (sb, eb))
            if overlap > MAX_OVERLAP_IOU or nested > MAX_CONTAINMENT:
                rep.violations.append(Violation(
                    rank=ra or 0, field="start", code="overlaps",
                    message=(f"moments {ra} and {rb} are near-duplicates "
                             f"(IoU {overlap:.0%}, {nested:.0%} of the shorter "
                             f"clip sits inside the longer)"),
                    value=sa))


def _collect_warnings(moments: dict, transcript: dict, entries: list[dict],
                      c: ClipConstraints, rep: Report) -> None:
    density = transcript.get("break_density_seconds")
    if density and density > 10:
        rep.warnings.append(Warning_(
            "coarse_breaks",
            f"breaks average one per {density}s — clip edges are coarse and a "
            f"cut may land up to ~{density}s from the intended phrase"))

    if transcript.get("granularity") == "segment":
        rep.warnings.append(Warning_(
            "segment_timing",
            "transcript is cue-level, not word-level: caption timings will be "
            "estimated within each cue"))

    if transcript.get("punctuated") is False:
        rep.warnings.append(Warning_(
            "unpunctuated",
            "transcript came from auto-captions — the `transcript` field is an "
            "ASR guess, not a quotation"))

    rights = moments.get("rights")
    if rights and rights != "owned":
        over = [m.get("rank") for m in entries
                if _length(m) is not None and _length(m) > 60]
        if over:
            rep.warnings.append(Warning_(
                "content_id_risk",
                f"rights={rights!r} and moments {over} exceed 60s — a Short over "
                f"60s carrying a Content ID claim is blocked globally"))


def _length(m: dict) -> float | None:
    try:
        return float(m["end"]) - float(m["start"])
    except (KeyError, TypeError, ValueError):
        return None
