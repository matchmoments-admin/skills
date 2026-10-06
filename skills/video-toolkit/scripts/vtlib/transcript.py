"""Caption parsing and the canonical timed transcript.

The output of `build_transcript` is the contract every later stage reads:
word timings, and `breaks` — the clause boundaries a clip edge is allowed to
land on. Getting `breaks` right is most of what this module is for.
"""

from __future__ import annotations

import re

# Floor for what counts as a pause. Below this a "gap" is timing noise, not silence.
MIN_PAUSE = 0.18
SENT_END_RE = re.compile(r"[.!?]['\")\]]*$")

# Cue-level VTT timestamps: 00:01:02.345 --> 00:01:04.567
VTT_CUE_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})")


def parse_json3(data: dict) -> list[dict]:
    """YouTube's json3 caption format.

    Auto-generated captions carry per-word `tOffsetMs`, which is the whole reason
    to prefer this format over vtt — word-level timings for free, no ASR.
    """
    words: list[dict] = []
    for ev in data.get("events") or []:
        # Rolling-caption repaints duplicate earlier text; skip them.
        if ev.get("aAppend"):
            continue
        segs = ev.get("segs")
        if not segs:
            continue
        t0 = ev.get("tStartMs", 0)
        for s in segs:
            txt = (s.get("utf8") or "").strip()
            if not txt:
                continue
            words.append({
                "t": round((t0 + s.get("tOffsetMs", 0)) / 1000.0, 3),
                "w": txt,
            })
    words.sort(key=lambda x: x["t"])
    return words


def parse_vtt(text: str) -> list[dict]:
    """Fallback when json3 is unavailable. Cue-level granularity only."""
    out: list[dict] = []
    lines = text.splitlines()
    i = 0
    previous = None
    while i < len(lines):
        m = VTT_CUE_RE.search(lines[i])
        if not m:
            i += 1
            continue
        h, mi, s, ms = (int(x) for x in m.group(1, 2, 3, 4))
        start = h * 3600 + mi * 60 + s + ms / 1000
        i += 1
        buf = []
        while i < len(lines) and lines[i].strip():
            buf.append(re.sub(r"<[^>]+>", "", lines[i]).strip())
            i += 1
        line = " ".join(x for x in buf if x).strip()
        # Rolling captions repaint the *previous* cue, so only an immediate
        # repeat is a duplicate. A global set would silently delete the second
        # "Thank you." in a talk, taking its timing and its break with it.
        if line and line != previous:
            previous = line
            out.append({"t": round(start, 3), "w": line})
    return out


def looks_word_level(words: list[dict]) -> bool:
    if not words:
        return False
    sample = words[: min(300, len(words))]
    multi = sum(1 for w in sample if " " in w["w"])
    return multi / len(sample) < 0.3


def spoken_estimate(text: str) -> float:
    """Roughly how long this text takes to say.

    Needed because caption timings carry no silence: json3 word starts are
    contiguous by construction (each word's start is the previous word's end),
    and a cue's derived duration runs to the next cue. Either way the raw
    interval is zero and no pause is visible. Subtracting a plausible spoken
    duration is what makes silence appear.

    Accepts a whole caption cue as well as a single word, so segment-level
    transcripts get real pause detection instead of none.
    """
    parts = [p for p in text.split() if p]
    if not parts:
        return 0.09
    total = 0.0
    for part in parts:
        n = len(re.sub(r"[^\w']", "", part)) or 1
        total += min(0.9, max(0.09, 0.055 * n + 0.055))
    return total


def pause_breaks(words: list[dict], duration: float,
                 measured: bool = False) -> tuple[list[float], float]:
    """Clause boundaries from silence, thresholded adaptively.

    A fixed gap threshold fails badly across sources: dense auto-captions yield
    almost nothing, sparse cue timings yield a break after every cue. Instead aim
    for a usable density — roughly one candidate cut point every 8 seconds — and
    let the threshold fall where it must, floored so it stays a real pause.
    """
    gaps: list[tuple[float, float]] = []
    for i in range(len(words) - 1):
        w = words[i]
        # A measured duration (Whisper) is the truth and must win: estimating
        # over it can invent a gap where there is none, and place the break
        # before the word has finished — a cut mid-word, which is the exact
        # defect this function exists to prevent.
        spoken = w["d"] if measured else spoken_estimate(w["w"])
        gap = words[i + 1]["t"] - (w["t"] + spoken)
        if gap > 0:
            gaps.append((gap, round(w["t"] + spoken, 3)))
    if not gaps:
        return [], 0.0
    target = max(8, int((duration or 0) / 8))
    ranked = sorted(gaps, key=lambda g: -g[0])
    thr = max(MIN_PAUSE, ranked[min(target, len(ranked) - 1)][0])
    return [t for g, t in gaps if g >= thr], round(thr, 3)


def build_transcript(words: list[dict], duration: float | None,
                     measured: bool | None = None) -> dict:
    """Fill in durations, detect punctuation, and mark clause boundaries.

    Clause boundaries are what clip edges must snap to. Auto-generated captions
    have no punctuation at all, so pause detection carries the load there.

    Mutates `words` in place to add `d`, then returns the full transcript dict.
    """
    word_level = looks_word_level(words)
    # Whisper supplies true per-word durations; caption parsing does not. Decide
    # before the fill below, which would otherwise make every word look measured.
    if measured is None:
        measured = bool(words) and all("d" in w for w in words[:50])
    # A single word is never 1.2s; a caption cue routinely is. Capping cue
    # durations invents a gap after every cue and makes every cue a false break.
    cap = 1.2 if word_level else None
    for i, w in enumerate(words):
        if "d" in w:
            continue
        nxt = words[i + 1]["t"] if i + 1 < len(words) else None
        if nxt is None:
            w["d"] = 0.4 if word_level else round(len(w["w"]) / 15.0, 3)
        else:
            gap = max(0.0, nxt - w["t"])
            w["d"] = round(min(gap, cap) if cap else gap, 3)

    text_sample = " ".join(w["w"] for w in words[:400])
    punctuated = bool(re.search(r"[.!?]", text_sample)) and \
        text_sample.count(".") + text_sample.count("?") > 2

    if not duration and words:
        duration = words[-1]["t"] + words[-1]["d"]

    breaks: set[float] = set()
    if punctuated:
        for w in words:
            if SENT_END_RE.search(w["w"]):
                breaks.add(round(w["t"] + w["d"], 3))

    # Sentence ends are authoritative when they exist: a cut there starts a
    # clip on a sentence, which is what makes it watchable. Pause detection is
    # an estimate, and letting it supplement adequate punctuation introduces
    # mid-sentence cut points that outrank the real ones. So supplement only
    # when punctuation is absent or too sparse to snap against.
    punctuation_density = (duration / len(breaks)) if breaks and duration else None
    need_pauses = punctuation_density is None or punctuation_density > 12
    thr = None
    if need_pauses:
        pauses, thr = pause_breaks(words, duration or 0, measured)
        breaks.update(pauses)
    source = ("punctuation" if not need_pauses
              else "pauses" if not punctuated else "both")

    ordered = sorted(breaks)
    # Include the head and tail runs: a video whose punctuation stops at the
    # ten-minute mark has fifty minutes with no cut point, and measuring only
    # between breaks reports a small gap and hides exactly that.
    edges = [0.0] + ordered + ([duration] if duration else [])
    gaps = [b - a for a, b in zip(edges, edges[1:])]
    return {
        "duration": round(duration or 0, 3),
        "punctuated": punctuated,
        "granularity": "word" if word_level else "segment",
        "word_count": len(words),
        "durations_measured": measured,
        "break_source": source,
        # None means the pause pass did not run, which is not the same as it
        # running and finding nothing. Consumers that treat 0.0 as a threshold
        # end up splitting on every word.
        "pause_threshold": thr,
        # The average hides a long unpunctuated stretch with no snap points.
        "max_break_gap_seconds": round(max(gaps), 2) if gaps else None,
        "break_density_seconds": round((duration or 0) / len(ordered), 2)
                                 if ordered else None,
        "words": words,
        "breaks": ordered,
    }
