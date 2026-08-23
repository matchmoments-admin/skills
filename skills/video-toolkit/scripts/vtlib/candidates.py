"""Turning a fused signal into snapped, self-contained candidate windows.

This is a shortlist generator, not a judge. It finds where attention went; it has
no opinion on whether the content is any good. The ranking pass in `video-moments`
supplies the judgement.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# A clip that opens on one of these has no antecedent and reads as mid-thought.
BAD_OPENERS = {
    "and", "but", "so", "because", "which", "that", "then", "also", "however",
    "it", "this", "they", "he", "she", "them", "him", "her", "these", "those",
    "or", "yeah", "right", "okay", "ok", "um", "uh", "well", "anyway", "plus",
}

# Podcast furniture. These windows score well — the heatmap loves an intro and
# viewers timestamp chapter transitions — but nobody wants them as a clip.
BOILERPLATE_RE = re.compile(
    r"thanks? for listening|check out our sponsors?|brought to you by|"
    r"now,? dear friends|here'?s the episode|subscribe to|"
    r"like and subscribe|this episode is sponsored|use code |"
    r"follow me on|link in the (?:description|bio)|"
    r"the following is a conversation with|support (?:this|the) (?:podcast|channel)",
    re.I)
BOILERPLATE_PENALTY = 0.6

# How far either side of an edge to carry transcript context and nearby breaks,
# so the ranking pass can move a boundary without re-reading the transcript.
CONTEXT_SECONDS = 25.0


@dataclass(frozen=True)
class CandidateParams:
    count: int = 12
    min_len: float = 20.0
    max_len: float = 58.0
    skip_head: float | None = None
    skip_tail: float | None = None

    def resolved_head(self, duration: float) -> float:
        if self.skip_head is not None:
            return self.skip_head
        return max(30.0, min(180.0, duration * 0.02))

    def resolved_tail(self, duration: float) -> float:
        if self.skip_tail is not None:
            return self.skip_tail
        return max(15.0, min(120.0, duration * 0.01))


def snap_window(start: float, end: float, breaks: list[float],
                min_len: float, max_len: float) -> tuple[float, float]:
    """Pull edges out to clause boundaries without blowing the length budget."""
    before = [b for b in breaks if b <= start]
    after = [b for b in breaks if b >= end]
    s = before[-1] if before else max(0.0, start)
    e = after[0] if after else end

    if e - s > max_len:
        # Too long after snapping: walk the start forward, then the end back.
        inner_starts = [b for b in breaks if s < b <= start + (max_len * 0.5)]
        for b in inner_starts:
            if e - b <= max_len:
                s = b
                break
        if e - s > max_len:
            inner_ends = [b for b in breaks if end <= b <= s + max_len]
            e = inner_ends[-1] if inner_ends else s + max_len
    if e - s < min_len:
        later = [b for b in breaks if b >= s + min_len]
        if later and later[0] - s <= max_len:
            e = later[0]
    return round(s, 3), round(e, 3)


def words_in(words: list[dict], s: float, e: float) -> list[dict]:
    return [w for w in words if s <= w["t"] < e]


def opener_ok(words: list[dict]) -> tuple[bool, str]:
    """A clip has to work for someone who joined at second zero."""
    if not words:
        return False, ""
    first = re.sub(r"[^\w']", "", words[0]["w"]).lower()
    return first not in BAD_OPENERS, first


def iou(a: tuple[float, float], b: tuple[float, float]) -> float:
    lo = max(a[0], b[0])
    hi = min(a[1], b[1])
    inter = max(0.0, hi - lo)
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / union if union > 0 else 0.0


def chapter_at(chapters: list[dict], t: float) -> str | None:
    for c in chapters:
        if (c.get("start_time") or 0) <= t < (c.get("end_time") or 0):
            return c.get("title")
    return None


def mask_head_tail(fused: list[float], skip_head: float,
                   skip_tail: float) -> list[float]:
    """Zero the opening and closing windows.

    The first heatmap bucket is the global max on essentially every video — it
    measures "pressed play", not "rewatched this" — and it sits on top of the
    intro and the sponsor read. Detrending cannot fix a curve whose maximum is
    structurally at t=0, so the head is excluded outright.
    """
    out = list(fused)
    n = len(out)
    for i in range(min(n, int(skip_head))):
        out[i] = 0.0
    for i in range(max(0, n - int(skip_tail)), n):
        out[i] = 0.0
    return out


def find_peaks(fused: list[float], count: int, radius: int = 10,
               percentile: float = 0.75) -> list[int]:
    """Local maxima over a +/-radius neighbourhood, above a percentile floor."""
    n = len(fused)
    ordered = sorted(fused)
    floor = ordered[int(len(ordered) * percentile)] if ordered else 0.0
    peaks = []
    for i in range(n):
        if fused[i] < floor:
            continue
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        if fused[i] >= max(fused[lo:hi]):
            peaks.append(i)
    if not peaks:
        peaks = sorted(range(n), key=lambda i: -fused[i])[: count * 3]
    return peaks


def place_window(fused: list[float], peak: int, min_len: float,
                 max_len: float) -> tuple[float, float, float] | None:
    """The window containing `peak` with the highest mean fused score."""
    n = len(fused)
    best = None
    for length in (min_len, (min_len + max_len) / 2, max_len):
        L = int(length)
        for offset in range(0, L, max(1, L // 6)):
            s = peak - offset
            e = s + L
            if s < 0 or e > n:
                continue
            score = sum(fused[s:e]) / L
            if best is None or score > best[0]:
                best = (score, float(s), float(e))
    return best


def find_candidates(signals: dict, transcript: dict, chapters: list[dict],
                    params: CandidateParams) -> dict:
    """Fused signal in, ranked candidate windows out. Pure."""
    fused_full = signals["fused"]
    n = len(fused_full)
    words = transcript.get("words") or []
    breaks = transcript.get("breaks") or []
    duration = signals.get("duration") or n
    min_len, max_len = params.min_len, params.max_len

    skip_head = params.resolved_head(duration)
    skip_tail = params.resolved_tail(duration)
    fused = mask_head_tail(fused_full, skip_head, skip_tail)

    series = signals.get("series") or {}
    available = signals.get("available") or sorted(series.keys())

    raw: list[dict] = []
    for pk in find_peaks(fused, params.count):
        best = place_window(fused, pk, min_len, max_len)
        if best is None:
            continue
        score, s, e = best
        s, e = snap_window(s, e, breaks, min_len, max_len)
        # Snapping can drag an edge back into the excluded head/tail.
        if s < skip_head or e > n - skip_tail:
            continue
        if e - s < min_len * 0.6:
            continue
        ws = words_in(words, s, e)
        ok, first = opener_ok(ws)
        if not ok:
            later = [b for b in breaks if s < b < e - min_len * 0.6]
            if later:
                s = later[0]
                ws = words_in(words, s, e)
                ok, first = opener_ok(ws)
        text = " ".join(w["w"] for w in ws).strip()
        boilerplate = bool(BOILERPLATE_RE.search(text))
        raw.append({
            "start": s, "end": e, "duration": round(e - s, 2),
            "fused_mean": round(
                score * (BOILERPLATE_PENALTY if boilerplate else 1.0), 5),
            "fused_raw": round(score, 5),
            "peak_at": pk,
            "signals": {
                k: round(sum(series[k][int(s):int(e)])
                         / max(1, int(e) - int(s)), 4)
                for k in available if k in series
            },
            "opener": first,
            "opener_ok": ok,
            "boilerplate": boilerplate,
            "chapter": chapter_at(chapters, s),
            "text": text,
            # So the ranking pass can move an edge without re-reading the
            # transcript. Most shortlisted windows still open mid-thought;
            # fixing that is a judgement call the signals cannot make.
            "context_before": " ".join(
                w["w"] for w in words_in(words, s - CONTEXT_SECONDS, s)).strip(),
            "context_after": " ".join(
                w["w"] for w in words_in(words, e, e + CONTEXT_SECONDS)).strip(),
            "breaks_near_start": [b for b in breaks
                                  if s - CONTEXT_SECONDS <= b <= s + 15],
            "breaks_near_end": [b for b in breaks
                                if e - 15 <= b <= e + CONTEXT_SECONDS],
        })

    # Dedupe overlaps, keeping the stronger window.
    raw.sort(key=lambda c: -c["fused_mean"])
    kept: list[dict] = []
    for c in raw:
        if any(iou((c["start"], c["end"]), (k["start"], k["end"])) > 0.35
               for k in kept):
            continue
        kept.append(c)
        if len(kept) >= params.count:
            break

    for i, c in enumerate(kept, 1):
        c["rank"] = i

    return {
        "duration": signals["duration"],
        "signals_available": available,
        "weights_used": signals["weights_used"],
        "constraints": {"min_len": min_len, "max_len": max_len,
                        "skip_head": round(skip_head, 1),
                        "skip_tail": round(skip_tail, 1)},
        "punctuated_transcript": transcript.get("punctuated"),
        "candidates": kept,
    }
