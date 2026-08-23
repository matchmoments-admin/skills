#!/usr/bin/env python3
"""
vt — video toolkit.

Deterministic fetch / transcript / signal extraction for the video skills, so the
LLM half of the pipeline never re-derives a yt-dlp or ffmpeg invocation. Every
command is idempotent and writes into a content-keyed cache; re-running is cheap.

    vt.py info       <src>                     what's cached, what's missing
    vt.py fetch      <src> [--comments] [--audio] [--video]
    vt.py transcript <src> [--whisper] [--model M]
    vt.py signals    <src>
    vt.py candidates <src> [--count N] [--min S] [--max S] [--weights JSON]

<src> is a URL (anything yt-dlp handles) or a local media path.

Cache: $VT_CACHE or ~/.cache/video-toolkit/<key>/
Every command prints a small JSON summary to stdout. Big artifacts stay on disk.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("VT_CACHE", Path.home() / ".cache" / "video-toolkit"))

YT_ID_RE = re.compile(r"(?:v=|/shorts/|/embed/|youtu\.be/|/live/)([0-9A-Za-z_-]{11})")

# mm:ss or hh:mm:ss, not part of a longer run of digits/colons
COMMENT_TS_RE = re.compile(r"(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])")

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

DEFAULT_WEIGHTS = {
    "heatmap": 0.40,
    "comments": 0.30,
    "energy": 0.20,
    "density": 0.10,
}

# Floor for what counts as a pause. Below this a "gap" is timing noise, not silence.
MIN_PAUSE = 0.18
SENT_END_RE = re.compile(r"[.!?]['\")\]]*$")


# ---------------------------------------------------------------- infrastructure


def die(msg: str, code: int = 1):
    print(json.dumps({"ok": False, "error": msg}), file=sys.stdout)
    sys.exit(code)


def emit(obj):
    print(json.dumps(obj, indent=2))


def ytdlp_cmd() -> list[str]:
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        die("yt-dlp not found. Run scripts/preflight.sh")


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def is_local(src: str) -> bool:
    return Path(src).expanduser().exists()


def video_key(src: str) -> str:
    p = Path(src).expanduser()
    if p.exists():
        st = p.stat()
        h = hashlib.sha1(
            f"{p.resolve()}|{st.st_size}|{int(st.st_mtime)}".encode()
        ).hexdigest()[:12]
        return f"local-{h}"
    m = YT_ID_RE.search(src)
    if m:
        return f"yt-{m.group(1)}"
    return "url-" + hashlib.sha1(src.encode()).hexdigest()[:12]


def cache_dir(src: str, create: bool = True) -> Path:
    d = CACHE_ROOT / video_key(src)
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def load_json(p: Path):
    with p.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(p: Path, obj):
    tmp = p.with_suffix(p.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    tmp.replace(p)


def info_path(d: Path) -> Path | None:
    for name in ("src.info.json", "info.json"):
        p = d / name
        if p.exists():
            return p
    hits = sorted(d.glob("*.info.json"))
    return hits[0] if hits else None


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------------- fetch


def probe_local(path: Path) -> dict:
    """Minimal info dict for a local file, via ffprobe when available."""
    info = {"id": video_key(str(path)), "title": path.stem, "_local_path": str(path)}
    probe = shutil.which("ffprobe")
    if probe:
        r = run([probe, "-v", "error", "-show_format", "-show_streams",
                 "-of", "json", str(path)])
        if r.returncode == 0:
            try:
                pj = json.loads(r.stdout)
                info["duration"] = float(pj.get("format", {}).get("duration", 0)) or None
            except (ValueError, KeyError):
                pass
    return info


def cmd_fetch(args):
    d = cache_dir(args.src)
    src = args.src

    if is_local(src):
        p = Path(src).expanduser().resolve()
        ip = d / "src.info.json"
        if not ip.exists() or args.force:
            save_json(ip, probe_local(p))
        # Point the audio/video slots at the original rather than copying it.
        (d / "source.link").write_text(str(p), encoding="utf-8")
        return emit({"ok": True, "key": video_key(src), "dir": str(d),
                     "local": True, "info": "src.info.json"})

    ip = info_path(d)
    need_meta = ip is None or args.force
    need_comments = args.comments and not _has_comments(ip)

    if need_meta or need_comments:
        cmd = ytdlp_cmd() + [
            "--skip-download", "--write-info-json",
            "--write-subs", "--write-auto-subs",
            "--sub-langs", args.langs,
            "--sub-format", "json3/srv3/vtt/best",
            "--no-warnings", "--no-progress",
            # YouTube 429s readily on caption endpoints; back off rather than fail.
            "--retries", "5", "--retry-sleep", "http:exp=1:30",
            "--sleep-requests", "0.75",
            "-P", str(d), "-o", "src.%(ext)s",
        ]
        if args.comments:
            # Top-level comments only, sorted by top. Replies rarely carry timestamps.
            cmd += ["--write-comments", "--extractor-args",
                    "youtube:comment_sort=top;max_comments=800,800,0,0"]
        cmd.append(src)
        r = run(cmd)
        if r.returncode != 0:
            die(f"yt-dlp failed: {(r.stderr or r.stdout).strip()[-800:]}")
        ip = info_path(d)

    if ip is None:
        die("no info.json produced")

    if args.audio or args.video:
        _fetch_media(d, src, want_video=args.video, force=args.force)

    info = load_json(ip)
    return emit({
        "ok": True,
        "key": video_key(src),
        "dir": str(d),
        "title": info.get("title"),
        "duration": info.get("duration"),
        "channel": info.get("channel") or info.get("uploader"),
        "view_count": info.get("view_count"),
        "chapters": len(info.get("chapters") or []),
        "heatmap_buckets": len(info.get("heatmap") or []),
        "comments": len(info.get("comments") or []),
        "subtitle_files": sorted(p.name for p in d.glob("src.*.json3"))
                          or sorted(p.name for p in d.glob("src.*.vtt")),
        "media": sorted(p.name for p in d.glob("media.*")),
    })


def _has_comments(ip: Path | None) -> bool:
    if ip is None or not ip.exists():
        return False
    try:
        return bool(load_json(ip).get("comments"))
    except (ValueError, OSError):
        return False


def _fetch_media(d: Path, src: str, want_video: bool, force: bool):
    existing = sorted(d.glob("media.*"))
    if existing and not force:
        return existing[0]
    # Prefer H.264: YouTube increasingly serves AV1 as "best", and plenty of
    # ffmpeg builds (conda's 4.x among them) have no AV1 decoder, so frames and
    # renders fail with "Decoder (codec av1) not found".
    fmt = ("bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/"
           "bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4]/"
           "bestvideo[height<=1080]+bestaudio/best") if want_video \
        else "bestaudio[ext=m4a]/bestaudio/best"
    cmd = ytdlp_cmd() + ["-f", fmt, "--no-warnings", "--no-progress",
                         "-P", str(d), "-o", "media.%(ext)s", src]
    r = run(cmd)
    if r.returncode != 0:
        die(f"yt-dlp media download failed: {(r.stderr or r.stdout).strip()[-800:]}")
    hits = sorted(d.glob("media.*"))
    return hits[0] if hits else None


def _media_file(d: Path) -> Path | None:
    link = d / "source.link"
    if link.exists():
        p = Path(link.read_text(encoding="utf-8").strip())
        if p.exists():
            return p
    hits = sorted(d.glob("media.*"))
    return hits[0] if hits else None


# ------------------------------------------------------------------ transcript


def parse_json3(path: Path) -> list[dict]:
    """YouTube's json3 caption format. Auto-generated captions carry per-word
    tOffsetMs, which is the whole reason to prefer this format over vtt."""
    data = load_json(path)
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


def parse_vtt(path: Path) -> list[dict]:
    """Fallback when json3 is unavailable. Cue-level granularity only."""
    out: list[dict] = []
    cue_re = re.compile(
        r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})")
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    i = 0
    seen = set()
    while i < len(lines):
        m = cue_re.search(lines[i])
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
        text = " ".join(x for x in buf if x).strip()
        if text and text not in seen:
            seen.add(text)
            out.append({"t": round(start, 3), "w": text})
    return out


def pick_sub_file(d: Path, info: dict) -> tuple[Path | None, str]:
    """Prefer manual captions (punctuated) over auto (not), json3 over vtt."""
    manual_langs = set((info.get("subtitles") or {}).keys())
    j3 = sorted(d.glob("src.*.json3"))
    vtt = sorted(d.glob("src.*.vtt"))

    def lang_of(p: Path) -> str:
        parts = p.name.split(".")
        return parts[-2] if len(parts) >= 3 else ""

    for group, fmt in ((j3, "json3"), (vtt, "vtt")):
        for p in group:
            if lang_of(p) in manual_langs:
                return p, f"youtube-manual:{fmt}"
        if group:
            return group[0], f"youtube-auto:{fmt}"
    return None, ""


def whisper_transcribe(audio: Path, model: str | None) -> tuple[list[dict], str, str]:
    """Returns (words, source_label, language). Tries mlx first on Apple Silicon."""
    try:
        import mlx_whisper  # type: ignore
        repo = model or "mlx-community/whisper-large-v3-turbo"
        r = mlx_whisper.transcribe(str(audio), path_or_hf_repo=repo,
                                   word_timestamps=True)
        words = [{"t": round(w["start"], 3), "w": w["word"].strip(),
                  "d": round(w["end"] - w["start"], 3)}
                 for seg in r["segments"] for w in seg.get("words", [])
                 if w.get("word", "").strip()]
        return words, f"whisper-mlx:{repo}", r.get("language", "")
    except ImportError:
        pass

    try:
        from faster_whisper import WhisperModel  # type: ignore
        m = WhisperModel(model or "large-v3-turbo", compute_type="int8")
        segs, info = m.transcribe(str(audio), word_timestamps=True)
        words = [{"t": round(w.start, 3), "w": w.word.strip(),
                  "d": round(w.end - w.start, 3)}
                 for seg in segs for w in (seg.words or []) if w.word.strip()]
        return words, f"whisper-faster:{model or 'large-v3-turbo'}", info.language
    except ImportError:
        die("no whisper backend. pip install mlx-whisper (Apple Silicon) "
            "or faster-whisper")


def _spoken_estimate(word: str) -> float:
    """Roughly how long this word takes to say.

    Needed because json3 word timings are contiguous by construction — each word's
    start is the previous word's end — so the raw intervals contain no pauses at
    all. Subtracting a plausible spoken duration is what makes silence visible."""
    n = len(re.sub(r"[^\w']", "", word)) or 1
    return min(0.9, max(0.09, 0.055 * n + 0.055))


def _pause_breaks(words: list[dict], duration: float,
                  word_level: bool) -> tuple[list[float], float]:
    """Clause boundaries from silence, thresholded adaptively.

    A fixed gap threshold fails badly across sources: dense auto-captions yield
    almost nothing, sparse cue timings yield a break after every cue. Instead aim
    for a usable density — roughly one candidate cut point every 8 seconds — and
    let the threshold fall where it must, floored so it stays a real pause."""
    gaps: list[tuple[float, float]] = []
    for i in range(len(words) - 1):
        w = words[i]
        spoken = _spoken_estimate(w["w"]) if word_level else w.get("d", 0.0)
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
    have no punctuation at all, so pause detection carries the load there."""
    word_level = _looks_word_level(words)
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
    pauses, thr = _pause_breaks(words, duration or 0, word_level)
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


def _looks_word_level(words: list[dict]) -> bool:
    if not words:
        return False
    sample = words[: min(300, len(words))]
    multi = sum(1 for w in sample if " " in w["w"])
    return multi / len(sample) < 0.3


def cmd_transcript(args):
    d = cache_dir(args.src)
    tp = d / "transcript.json"
    if tp.exists() and not args.force:
        t = load_json(tp)
        return emit({"ok": True, "cached": True, "path": str(tp),
                     "source": t.get("source"), "words": t.get("word_count"),
                     "punctuated": t.get("punctuated"),
                     "granularity": t.get("granularity"),
                     "breaks": len(t.get("breaks") or [])})

    ip = info_path(d)
    if ip is None:
        die("no metadata cached — run `vt.py fetch` first")
    info = load_json(ip)
    duration = info.get("duration")

    words: list[dict] = []
    source = ""
    language = info.get("language") or ""

    if not args.whisper:
        sub, source = pick_sub_file(d, info)
        if sub:
            words = parse_json3(sub) if sub.suffix == ".json3" else parse_vtt(sub)
            parts = sub.name.split(".")
            language = parts[-2] if len(parts) >= 3 else language

    if not words:
        audio = _media_file(d)
        if audio is None:
            die("no captions available and no media cached — "
                "run `vt.py fetch <src> --audio` then retry")
        words, source, language = whisper_transcribe(audio, args.model)

    if not words:
        die("transcript came back empty")

    t = build_transcript(words, duration)
    t.update({"key": video_key(args.src), "source": source, "language": language})
    save_json(tp, t)
    return emit({"ok": True, "cached": False, "path": str(tp), "source": source,
                 "words": t["word_count"], "punctuated": t["punctuated"],
                 "granularity": t["granularity"], "breaks": len(t["breaks"])})


# --------------------------------------------------------------------- signals


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
    local peaks anywhere in the timeline."""
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


def heatmap_series(info: dict, n: int) -> tuple[list[float], list[float]] | None:
    """Returns (prominence, raw). Prominence is what the fusion uses."""
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


def energy_series(media: Path, n: int) -> list[float] | None:
    """Per-second RMS, then the spike above a rolling median. The spike is the
    useful part: laughter and applause show up as a burst over local baseline."""
    if not have_ffmpeg() or media is None:
        return None
    sr = 8000
    cmd = ["ffmpeg", "-v", "error", "-i", str(media), "-ac", "1",
           "-ar", str(sr), "-f", "s16le", "-"]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        return None

    import array
    rms: list[float] = []
    chunk_bytes = sr * 2
    assert proc.stdout is not None
    while True:
        buf = proc.stdout.read(chunk_bytes)
        if not buf:
            break
        if len(buf) % 2:
            buf = buf[:-1]
        a = array.array("h")
        a.frombytes(buf)
        if not a:
            continue
        rms.append(math.sqrt(sum(float(v) * v for v in a) / len(a)))
    proc.wait()
    if not rms:
        return None

    rms = (rms + [0.0] * n)[:n]
    base = rolling_median(rms, win=60)
    spike = [max(0.0, r - b) for r, b in zip(rms, base)]
    return normalize(gaussian_blur(spike, sigma=2.0))


def cmd_signals(args):
    d = cache_dir(args.src)
    ip = info_path(d)
    tp = d / "transcript.json"
    if ip is None:
        die("no metadata cached — run `vt.py fetch` first")
    if not tp.exists():
        die("no transcript cached — run `vt.py transcript` first")

    info = load_json(ip)
    t = load_json(tp)
    duration = t.get("duration") or info.get("duration") or 0
    n = int(math.ceil(duration))
    if n <= 0:
        die("could not determine duration")

    series: dict[str, list[float]] = {}
    meta: dict = {}

    hm = heatmap_series(info, n)
    if hm:
        series["heatmap"], series["heatmap_raw"] = hm
        meta["heatmap"] = {"buckets": len(info.get("heatmap") or []),
                           "transform": "prominence over local baseline"}

    cs, hits = comment_series(info, n)
    if cs:
        series["comments"] = cs
        meta["comments"] = {"timestamp_mentions": hits,
                            "comments_scanned": len(info.get("comments") or [])}

    series["density"] = density_series(t.get("words") or [], n)

    es = energy_series(_media_file(d), n)
    if es:
        series["energy"] = es
    elif not have_ffmpeg():
        meta["energy_skipped"] = "ffmpeg not installed"
    else:
        meta["energy_skipped"] = "no media cached (fetch --audio)"

    weights = dict(DEFAULT_WEIGHTS)
    if args.weights:
        weights.update(json.loads(args.weights))
    active = {k: v for k, v in weights.items() if k in series and v > 0}
    if not active:
        die("no usable signals")
    total = sum(active.values())
    fused = [
        sum(series[k][i] * (w / total) for k, w in active.items())
        for i in range(n)
    ]

    out = {
        "key": video_key(args.src), "duration": duration, "grid_seconds": 1,
        "weights_used": {k: round(v / total, 4) for k, v in active.items()},
        "available": sorted(series.keys()), "meta": meta,
        "series": series, "fused": [round(v, 5) for v in fused],
    }
    save_json(d / "signals.json", out)
    return emit({"ok": True, "path": str(d / "signals.json"),
                 "duration": duration, "available": out["available"],
                 "weights_used": out["weights_used"], "meta": meta})


# ------------------------------------------------------------------ candidates


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


def cmd_candidates(args):
    d = cache_dir(args.src)
    sp, tp = d / "signals.json", d / "transcript.json"
    if not sp.exists():
        die("no signals cached — run `vt.py signals` first")
    sig = load_json(sp)
    t = load_json(tp)
    ip = info_path(d)
    chapters = (load_json(ip).get("chapters") or []) if ip else []
    fused = list(sig["fused"])
    n = len(fused)
    words = t.get("words") or []
    breaks = t.get("breaks") or []
    min_len, max_len = args.min, args.max

    # The first heatmap bucket is the global max on essentially every video —
    # it measures "pressed play", not "rewatched this" — and it sits on top of
    # the intro and sponsor read. Excluding the head is more honest than trying
    # to detrend a curve whose maximum is structurally at t=0.
    duration = sig.get("duration") or n
    skip_head = args.skip_head if args.skip_head is not None \
        else max(30.0, min(180.0, duration * 0.02))
    skip_tail = args.skip_tail if args.skip_tail is not None \
        else max(15.0, min(120.0, duration * 0.01))
    for i in range(min(n, int(skip_head))):
        fused[i] = 0.0
    for i in range(max(0, n - int(skip_tail)), n):
        fused[i] = 0.0

    # Peaks: local maxima over a +/-10s neighbourhood, above the 75th percentile.
    ordered = sorted(fused)
    floor = ordered[int(len(ordered) * 0.75)] if ordered else 0.0
    peaks = []
    r = 10
    for i in range(n):
        if fused[i] < floor:
            continue
        lo, hi = max(0, i - r), min(n, i + r + 1)
        if fused[i] >= max(fused[lo:hi]):
            peaks.append(i)
    if not peaks:
        peaks = sorted(range(n), key=lambda i: -fused[i])[: args.count * 3]

    # For each peak, place the window that maximises mean fused score.
    raw: list[dict] = []
    for pk in peaks:
        best = None
        for length in (min_len, (min_len + max_len) / 2, max_len):
            L = int(length)
            for offset in range(0, L, max(1, L // 6)):
                s = pk - offset
                e = s + L
                if s < 0 or e > n:
                    continue
                score = sum(fused[s:e]) / L
                if best is None or score > best[0]:
                    best = (score, float(s), float(e))
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
            "fused_mean": round(score * (BOILERPLATE_PENALTY if boilerplate else 1.0), 5),
            "fused_raw": round(score, 5),
            "peak_at": pk,
            "signals": {
                k: round(sum(sig["series"][k][int(s):int(e)]) / max(1, int(e) - int(s)), 4)
                for k in sig["available"]
            },
            "opener": first,
            "opener_ok": ok,
            "boilerplate": boilerplate,
            "chapter": chapter_at(chapters, s),
            "text": text,
            # So the ranking pass can move an edge without re-reading the
            # transcript. Most shortlisted windows still open mid-thought;
            # fixing that is a judgement call the signals cannot make.
            "context_before": " ".join(w["w"] for w in words_in(words, s - 25, s)).strip(),
            "context_after": " ".join(w["w"] for w in words_in(words, e, e + 25)).strip(),
            "breaks_near_start": [b for b in breaks if s - 25 <= b <= s + 15],
            "breaks_near_end": [b for b in breaks if e - 15 <= b <= e + 25],
        })

    # Dedupe overlaps, keeping the stronger window.
    raw.sort(key=lambda c: -c["fused_mean"])
    kept: list[dict] = []
    for c in raw:
        if any(iou((c["start"], c["end"]), (k["start"], k["end"])) > 0.35 for k in kept):
            continue
        kept.append(c)
        if len(kept) >= args.count:
            break

    for i, c in enumerate(kept, 1):
        c["rank"] = i

    out = {
        "key": video_key(args.src),
        "duration": sig["duration"],
        "signals_available": sig["available"],
        "weights_used": sig["weights_used"],
        "constraints": {"min_len": min_len, "max_len": max_len,
                        "skip_head": round(skip_head, 1),
                        "skip_tail": round(skip_tail, 1)},
        "punctuated_transcript": t.get("punctuated"),
        "candidates": kept,
    }
    save_json(d / "candidates.json", out)
    return emit({"ok": True, "path": str(d / "candidates.json"),
                 "count": len(kept),
                 "signals_available": sig["available"],
                 "punctuated_transcript": t.get("punctuated"),
                 "candidates": [
                     {k: c[k] for k in
                      ("rank", "start", "end", "duration", "fused_mean",
                       "signals", "opener_ok", "boilerplate", "chapter", "text")}
                     for c in kept]})


# -------------------------------------------------------------------- info


def cmd_info(args):
    d = cache_dir(args.src, create=False)
    if not d.exists():
        return emit({"ok": True, "key": video_key(args.src), "dir": str(d),
                     "cached": False, "next": "vt.py fetch <src>"})
    ip = info_path(d)
    info = load_json(ip) if ip else {}
    return emit({
        "ok": True, "key": video_key(args.src), "dir": str(d), "cached": True,
        "title": info.get("title"), "duration": info.get("duration"),
        "have": {
            "metadata": ip is not None,
            "heatmap": bool(info.get("heatmap")),
            "comments": bool(info.get("comments")),
            "chapters": bool(info.get("chapters")),
            "subtitles": bool(list(d.glob("src.*.json3")) or list(d.glob("src.*.vtt"))),
            "media": _media_file(d) is not None,
            "transcript": (d / "transcript.json").exists(),
            "signals": (d / "signals.json").exists(),
            "candidates": (d / "candidates.json").exists(),
        },
        "tools": {"yt_dlp": bool(shutil.which("yt-dlp")) or _module("yt_dlp"),
                  "ffmpeg": have_ffmpeg(),
                  "ffprobe": shutil.which("ffprobe") is not None},
    })


def _module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except ImportError:
        return False


# --------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(prog="vt.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info"); p.add_argument("src"); p.set_defaults(fn=cmd_info)

    p = sub.add_parser("fetch")
    p.add_argument("src")
    p.add_argument("--comments", action="store_true",
                   help="also pull top comments (slow, but a strong signal)")
    p.add_argument("--audio", action="store_true")
    p.add_argument("--video", action="store_true")
    # Deliberately NOT "en.*" — that matches en-de, en-ar and every other
    # auto-translated track, which is dozens of pointless requests and a fast 429.
    p.add_argument("--langs", default="en-orig,en,en-US,en-GB")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_fetch)

    p = sub.add_parser("transcript")
    p.add_argument("src")
    p.add_argument("--whisper", action="store_true", help="skip captions, force ASR")
    p.add_argument("--model", default=None)
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_transcript)

    p = sub.add_parser("signals")
    p.add_argument("src")
    p.add_argument("--weights", default=None, help='JSON, e.g. \'{"heatmap":0.5}\'')
    p.set_defaults(fn=cmd_signals)

    p = sub.add_parser("candidates")
    p.add_argument("src")
    p.add_argument("--count", type=int, default=12)
    p.add_argument("--min", type=float, default=20.0)
    p.add_argument("--max", type=float, default=58.0)
    p.add_argument("--skip-head", type=float, default=None, dest="skip_head",
                   help="seconds to exclude at the start (default: 2%% of "
                        "duration, 30-180s). Intros and sponsor reads live here.")
    p.add_argument("--skip-tail", type=float, default=None, dest="skip_tail",
                   help="seconds to exclude at the end (default: 1%%, 15-120s)")
    p.set_defaults(fn=cmd_candidates)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
