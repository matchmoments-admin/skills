"""Per-second signal series and their fusion.

Each series answers a different question about where attention went. They are
normalised to 0-1, weighted, and summed. Whatever is unavailable is dropped and
the remaining weights renormalise, so the fusion degrades rather than fails.
"""

from __future__ import annotations

import math
import re
import statistics

from .errors import VtError

# mm:ss or hh:mm:ss, not part of a longer run of digits/colons
COMMENT_TS_RE = re.compile(r"(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])")

DEFAULT_WEIGHTS = {
    "heatmap": 0.40,
    "comments": 0.30,
    "energy": 0.20,
    "density": 0.10,
}


# ------------------------------------------------------------------ primitives


def normalize(series: list[float]) -> list[float]:
    if not series:
        return series
    lo, hi = min(series), max(series)
    if hi - lo < 1e-9:
        return [0.0] * len(series)
    return [(v - lo) / (hi - lo) for v in series]


def box_blur(series: list[float], radius: int) -> list[float]:
    """O(n) moving average via prefix sums."""
    n = len(series)
    if radius < 1 or n == 0:
        return list(series)
    pre = [0.0] * (n + 1)
    for i, v in enumerate(series):
        pre[i + 1] = pre[i] + v
    out = []
    for i in range(n):
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        out.append((pre[hi] - pre[lo]) / (hi - lo))
    return out


def gaussian_blur(series: list[float], sigma: float) -> list[float]:
    """Three box passes approximate a gaussian closely and stay O(n) — which
    matters when the timeline is a five-hour podcast at one sample per second."""
    if sigma <= 0 or not series:
        return list(series)
    radius = max(1, int(sigma * 0.85))
    out = list(series)
    for _ in range(3):
        out = box_blur(out, radius)
    return out


def prominence(series: list[float], baseline_sigma: float) -> list[float]:
    """How far a point rises above its own local baseline.

    YouTube heatmaps always spike hardest in the opening seconds — everyone
    watches the start — and decay from there. Using the raw curve therefore ranks
    the intro and the sponsor read above every actual moment in the episode.
    Prominence against a wide baseline removes that trend and surfaces genuine
    local peaks anywhere in the timeline.
    """
    base = gaussian_blur(series, baseline_sigma)
    return normalize([max(0.0, v - b) for v, b in zip(series, base)])


def rolling_median(series: list[float], win: int) -> list[float]:
    n = len(series)
    half = max(1, win // 2)
    out = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        out.append(statistics.median(series[lo:hi]))
    return out


# --------------------------------------------------------------------- series


def heatmap_series(info: dict, n: int) -> tuple[list[float], list[float]] | None:
    """Returns (prominence, raw). Prominence is what the fusion uses; raw is
    carried separately as a diagnostic and must never reach the weights."""
    hm = info.get("heatmap")
    if not hm:
        return None
    out = [0.0] * n
    for b in hm:
        s = int(b.get("start_time") or 0)
        e = int(b.get("end_time") or s + 1)
        v = float(b.get("value") or 0)
        for i in range(max(0, s), min(n, max(e, s + 1))):
            out[i] = v
    raw = normalize(out)
    # Baseline wide enough to span several heatmap buckets (each is ~1% of the
    # video) so it tracks the decay trend rather than the peaks themselves.
    return prominence(raw, baseline_sigma=max(30.0, n / 12.0)), raw


def comment_series(info: dict, n: int) -> tuple[list[float] | None, int]:
    """Viewers timestamp the good bits. Weight each mention by comment likes."""
    comments = info.get("comments")
    if not comments:
        return None, 0
    raw = [0.0] * n
    hits = 0
    for c in comments:
        text = c.get("text") or ""
        likes = c.get("like_count") or 0
        weight = math.log1p(max(0, likes)) + 1.0
        for m in COMMENT_TS_RE.finditer(text):
            h, mi, s = m.group(1), m.group(2), m.group(3)
            secs = (int(h) * 3600 if h else 0) + int(mi) * 60 + int(s)
            if 0 <= secs < n:
                raw[secs] += weight
                hits += 1
    if hits == 0:
        return None, 0
    return normalize(gaussian_blur(raw, sigma=5.0)), hits


def density_series(words: list[dict], n: int) -> list[float]:
    raw = [0.0] * n
    for w in words:
        i = int(w["t"])
        if 0 <= i < n:
            raw[i] += 1
    return normalize(gaussian_blur(raw, sigma=7.0))


def rms_to_spike(rms: list[float], n: int) -> list[float]:
    """Per-second loudness above its own rolling baseline.

    The spike is the useful part, not the absolute level: laughter and applause
    show up as a burst over the local baseline, whereas absolute RMS just tracks
    who is talking and how close the mic is.
    """
    padded = (list(rms) + [0.0] * n)[:n]
    base = rolling_median(padded, win=60)
    spike = [max(0.0, r - b) for r, b in zip(padded, base)]
    return normalize(gaussian_blur(spike, sigma=2.0))


# --------------------------------------------------------------------- fusion


def build_signals(info: dict, transcript: dict, energy: list[float] | None,
                  weights_override: dict | None = None,
                  energy_note: str | None = None) -> dict:
    """Build every available series and fuse them. Pure.

    `energy` is passed in rather than computed here because producing it needs
    ffmpeg; `vt.py` decodes the audio and hands over the RMS-derived series.
    """
    duration = transcript.get("duration") or info.get("duration") or 0
    n = int(math.ceil(duration))
    if n <= 0:
        raise VtError("could not determine duration")

    # Fusable series carry weights. Diagnostics are for humans reading the file
    # and must never enter the fusion — otherwise `--weights '{"heatmap_raw":…}'`
    # silently double-counts the heatmap.
    series: dict[str, list[float]] = {}
    diagnostics: dict[str, list[float]] = {}
    meta: dict = {}

    hm = heatmap_series(info, n)
    if hm:
        series["heatmap"], diagnostics["heatmap_raw"] = hm
        meta["heatmap"] = {"buckets": len(info.get("heatmap") or []),
                           "transform": "prominence over local baseline"}

    cs, hits = comment_series(info, n)
    if cs:
        series["comments"] = cs
        meta["comments"] = {"timestamp_mentions": hits,
                            "comments_scanned": len(info.get("comments") or [])}

    series["density"] = density_series(transcript.get("words") or [], n)

    if energy:
        series["energy"] = energy
    elif energy_note:
        meta["energy_skipped"] = energy_note

    weights = dict(DEFAULT_WEIGHTS)
    if weights_override:
        unknown = set(weights_override) - set(DEFAULT_WEIGHTS)
        if unknown:
            raise VtError(
                f"unknown signal(s) in --weights: {', '.join(sorted(unknown))}. "
                f"Valid: {', '.join(sorted(DEFAULT_WEIGHTS))}")
        weights.update(weights_override)

    active = {k: v for k, v in weights.items() if k in series and v > 0}
    if not active:
        raise VtError("no usable signals")
    total = sum(active.values())
    fused = [
        sum(series[k][i] * (w / total) for k, w in active.items())
        for i in range(n)
    ]

    return {
        "duration": duration,
        "grid_seconds": 1,
        "weights_used": {k: round(v / total, 4) for k, v in active.items()},
        "available": sorted(series.keys()),
        "meta": meta,
        "series": series,
        "diagnostics": diagnostics,
        "fused": [round(v, 5) for v in fused],
    }
