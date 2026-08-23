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
    seen = set()
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
        if line and line not in seen:
            seen.add(line)
            out.append({"t": round(start, 3), "w": line})
    return out


def looks_word_level(words: list[dict]) -> bool:
    if not words:
        return False
    sample = words[: min(300, len(words))]
    multi = sum(1 for w in sample if " " in w["w"])
    return multi / len(sample) < 0.3


def spoken_estimate(word: str) -> float:
    """Roughly how long this word takes to say.

    Needed because json3 word timings are contiguous by construction — each word's
    start is the previous word's end — so the raw intervals contain no pauses at
    all. Subtracting a plausible spoken duration is what makes silence visible.
    """
    n = len(re.sub(r"[^\w']", "", word)) or 1
    return min(0.9, max(0.09, 0.055 * n + 0.055))


def pause_breaks(words: list[dict], duration: float,
                 word_level: bool) -> tuple[list[float], float]:
    """Clause boundaries from silence, thresholded adaptively.

    A fixed gap threshold fails badly across sources: dense auto-captions yield
    almost nothing, sparse cue timings yield a break after every cue. Instead aim
    for a usable density — roughly one candidate cut point every 8 seconds — and
    let the threshold fall where it must, floored so it stays a real pause.
    """
    gaps: list[tuple[float, float]] = []
    for i in range(len(words) - 1):
        w = words[i]
        spoken = spoken_estimate(w["w"]) if word_level else w.get("d", 0.0)
        gap = words[i + 1]["t"] - (w["t"] + spoken)
        if gap > 0:
            gaps.append((gap, round(w["t"] + spoken, 3)))
    if not gaps:
        return [], 0.0
    target = max(8, int((duration or 0) / 8))
    ranked = sorted(gaps, key=lambda g: -g[0])
    thr = max(MIN_PAUSE, ranked[min(target, len(ranked) - 1)][0])
    return [t for g, t in gaps if g >= thr], round(thr, 3)


def build_transcript(words: list[dict], duration: float | None) -> dict:
    """Fill in durations, detect punctuation, and mark clause boundaries.

    Clause boundaries are what clip edges must snap to. Auto-generated captions
    have no punctuation at all, so pause detection carries the load there.

    Mutates `words` in place to add `d`, then returns the full transcript dict.
    """
    word_level = looks_word_level(words)
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
    pauses, thr = pause_breaks(words, duration or 0, word_level)
    breaks.update(pauses)

    ordered = sorted(breaks)
    return {
        "duration": round(duration or 0, 3),
        "punctuated": punctuated,
        "granularity": "word" if word_level else "segment",
        "word_count": len(words),
        "pause_threshold": thr,
        "break_density_seconds": round((duration or 0) / len(ordered), 2)
                                 if ordered else None,
        "words": words,
        "breaks": ordered,
    }
