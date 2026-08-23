#!/usr/bin/env python3
"""
vt — video toolkit.

Deterministic fetch / transcript / signal extraction for the video skills, so the
LLM half of the pipeline never re-derives a yt-dlp or ffmpeg invocation. Every
command is idempotent and writes into a content-keyed cache; re-running is cheap.

    vt.py info       <src>                     what's cached, what's missing
    vt.py fetch      <src> [--comments] [--audio] [--video]
    vt.py transcript <src> [--whisper] [--model M]
    vt.py signals    <src> [--weights JSON]
    vt.py candidates <src> [--count N] [--min S] [--max S]
    vt.py validate-moments <moments.json> [--fix OUT] [--strict]

<src> is a URL (anything yt-dlp handles) or a local media path.

Cache: $VT_CACHE or ~/.cache/video-toolkit/<key>/
Every command prints a small JSON summary to stdout. Big artifacts stay on disk.

This file owns all I/O — argparse, the filesystem, yt-dlp and ffmpeg. The actual
algorithms live in `vtlib/`, which touches none of those and is therefore
testable without a network or a media file, and portable to a Worker where the
cache is R2 rather than a directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

# install.sh symlinks the skill directory, so resolve before adding to the path —
# otherwise `import vtlib` looks in the symlink's parent on some Python versions.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from vtlib.candidates import CandidateParams, find_candidates  # noqa: E402
from vtlib.errors import VtError  # noqa: E402
from vtlib.moments import ClipConstraints, validate_moments  # noqa: E402
from vtlib.signals import build_signals, rms_to_spike  # noqa: E402
from vtlib.transcript import build_transcript, parse_json3, parse_vtt  # noqa: E402

YT_ID_RE = re.compile(r"(?:v=|/shorts/|/embed/|youtu\.be/|/live/)([0-9A-Za-z_-]{11})")

DEFAULT_CACHE = Path.home() / ".cache" / "video-toolkit"


# ---------------------------------------------------------------- infrastructure


def cache_root() -> Path:
    # Read at call time, not import time, so tests and callers can redirect it.
    return Path(os.environ.get("VT_CACHE") or DEFAULT_CACHE)


def ytdlp_cmd() -> list[str]:
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        raise VtError("yt-dlp not found. Run scripts/preflight.sh --install")
    return [sys.executable, "-m", "yt_dlp"]


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


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


def is_local(src: str) -> bool:
    return Path(src).expanduser().exists()


def cache_dir(src: str, create: bool = True) -> Path:
    d = cache_root() / video_key(src)
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
                info["duration"] = float(
                    pj.get("format", {}).get("duration", 0)) or None
            except (ValueError, KeyError, TypeError, AttributeError):
                pass
    return info


def cmd_fetch(args) -> dict:
    d = cache_dir(args.src)
    src = args.src

    if is_local(src):
        p = Path(src).expanduser().resolve()
        ip = d / "src.info.json"
        if not ip.exists() or args.force:
            save_json(ip, probe_local(p))
        # Point the audio/video slots at the original rather than copying it.
        (d / "source.link").write_text(str(p), encoding="utf-8")
        return {"ok": True, "key": video_key(src), "dir": str(d),
                "local": True, "info": "src.info.json"}

    ip = info_path(d)
    need_meta = ip is None or args.force
    need_comments = args.comments and not _comments_attempted(d, ip)

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
            raise VtError(f"yt-dlp failed: {(r.stderr or r.stdout).strip()[-800:]}")
        if args.comments:
            ip = info_path(d)
            got = len((load_json(ip).get("comments") or [])) if ip else 0
            state = _comment_state(d)
            save_json(d / COMMENT_STATE,
                      {"attempts": state.get("attempts", 0) + 1, "count": got})
        ip = info_path(d)

    if ip is None:
        raise VtError("no info.json produced")

    if args.audio or args.video:
        fetch_media(d, src, want_video=args.video, force=args.force)

    info = load_json(ip)
    return {
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
    }


# yt-dlp exits 0 having extracted nothing when the comment endpoint rate-limits,
# so one attempt is not proof the video has no comments. Two is enough to stop
# re-fetching captions forever on a video that genuinely has comments disabled.
MAX_COMMENT_ATTEMPTS = 2
COMMENT_STATE = "comments-state.json"


def _comment_state(d: Path) -> dict:
    p = d / COMMENT_STATE
    if p.exists():
        try:
            return load_json(p)
        except (ValueError, OSError):
            pass
    return {"attempts": 0, "count": 0}


def _comments_attempted(d: Path, ip: Path | None) -> bool:
    """Whether pulling comments again would be pointless.

    Inferring purely from `comments` being non-empty means a video with comments
    disabled re-runs the whole yt-dlp invocation — captions included — on every
    call, which contradicts the idempotence the CLI advertises and walks into
    the caption-endpoint 429 this file works hard to avoid. Inferring purely
    from a marker means one transient 429 permanently costs a documented signal.
    """
    if ip is not None and ip.exists():
        try:
            if load_json(ip).get("comments"):
                return True
        except (ValueError, OSError):
            pass
    state = _comment_state(d)
    return state.get("attempts", 0) >= MAX_COMMENT_ATTEMPTS


# What we asked yt-dlp for, recorded rather than inferred. Extension sniffing
# cannot work: `bestaudio` yields media.webm (opus) when m4a is unavailable, and
# .webm is equally a video container, so the same suffix means both things.
KIND_MARKER = "media-kind.txt"


def has_video_stream(path: Path) -> bool:
    """Probe a media file for a video stream. Requires ffprobe."""
    probe = shutil.which("ffprobe")
    if not probe:
        return False
    r = run([probe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path)])
    return r.returncode == 0 and "video" in r.stdout


def cached_media_kind(d: Path, existing: list[Path]) -> str | None:
    """"video" | "audio" | None. Reads the marker, probing once to backfill it
    for cache entries written before the marker existed."""
    marker = d / KIND_MARKER
    if marker.exists():
        value = marker.read_text(encoding="utf-8").strip()
        if value in ("audio", "video"):
            return value
    if not existing:
        return None
    if shutil.which("ffprobe"):
        kind = "video" if has_video_stream(existing[0]) else "audio"
        marker.write_text(kind, encoding="utf-8")
        return kind
    return None


def fetch_media(d: Path, src: str, want_video: bool, force: bool) -> Path | None:
    existing = [p for p in sorted(d.glob("media.*"))]
    # `fetch --audio` then `fetch --video` share a cache key, so returning
    # whatever is cached made the second call a silent no-op — and the very next
    # documented step, extracting a frame, then failed on a missing file.
    if existing and not force:
        kind = cached_media_kind(d, existing)
        if not want_video or kind == "video":
            return existing[0]
        if kind is None:
            raise VtError(
                f"{existing[0].name} is cached but its type is unknown (no "
                f"ffprobe on PATH). Install ffmpeg, or re-run with --force to "
                f"replace it.")
    # Prefer H.264: YouTube increasingly serves AV1 as "best", and plenty of
    # ffmpeg builds (conda's 4.x among them) have no AV1 decoder, so frames and
    # renders fail with "Decoder (codec av1) not found".
    fmt = ("bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/"
           "bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4]/"
           "bestvideo[height<=1080]+bestaudio/best") if want_video \
        else "bestaudio[ext=m4a]/bestaudio/best"
    # Download into a staging directory first. Replacing the cache before the
    # new file lands means a throttled or failed fetch destroys a working one.
    stage = d / ".media-staging"
    if stage.exists():
        for old in stage.iterdir():
            old.unlink()
    cmd = ytdlp_cmd() + ["-f", fmt, "--no-warnings", "--no-progress",
                         "-P", str(stage), "-o", "media.%(ext)s", src]
    r = run(cmd)
    fetched = sorted(stage.glob("media.*")) if stage.exists() else []
    if r.returncode != 0 or not fetched:
        for partial in fetched:
            partial.unlink()
        raise VtError(
            f"yt-dlp media download failed: {(r.stderr or r.stdout).strip()[-800:]}")

    for stale in existing:
        stale.unlink()
    landed = fetched[0].replace(d / fetched[0].name)
    for extra in fetched[1:]:
        extra.replace(d / extra.name)
    stage.rmdir()
    (d / KIND_MARKER).write_text("video" if want_video else "audio",
                                 encoding="utf-8")
    return landed


def media_file(d: Path) -> Path | None:
    """The playable source for this cache entry, downloaded or linked."""
    link = d / "source.link"
    if link.exists():
        p = Path(link.read_text(encoding="utf-8").strip())
        if p.exists():
            return p
    hits = sorted(d.glob("media.*"))
    return hits[0] if hits else None


# ------------------------------------------------------------------ transcript


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
    except ImportError:
        raise VtError("no whisper backend. pip install mlx-whisper (Apple Silicon) "
                      "or faster-whisper")
    m = WhisperModel(model or "large-v3-turbo", compute_type="int8")
    segs, info = m.transcribe(str(audio), word_timestamps=True)
    words = [{"t": round(w.start, 3), "w": w.word.strip(),
              "d": round(w.end - w.start, 3)}
             for seg in segs for w in (seg.words or []) if w.word.strip()]
    return words, f"whisper-faster:{model or 'large-v3-turbo'}", info.language


def cmd_transcript(args) -> dict:
    d = cache_dir(args.src)
    tp = d / "transcript.json"
    if tp.exists() and not args.force:
        t = load_json(tp)
        return {"ok": True, "cached": True, "path": str(tp),
                "source": t.get("source"), "words": t.get("word_count"),
                "punctuated": t.get("punctuated"),
                "granularity": t.get("granularity"),
                "breaks": len(t.get("breaks") or [])}

    ip = info_path(d)
    if ip is None:
        raise VtError("no metadata cached — run `vt.py fetch` first")
    info = load_json(ip)
    duration = info.get("duration")

    words: list[dict] = []
    source = ""
    language = info.get("language") or ""

    if not args.whisper:
        sub, source = pick_sub_file(d, info)
        if sub:
            words = (parse_json3(load_json(sub)) if sub.suffix == ".json3"
                     else parse_vtt(sub.read_text(encoding="utf-8", errors="replace")))
            parts = sub.name.split(".")
            language = parts[-2] if len(parts) >= 3 else language

    if not words:
        audio = media_file(d)
        if audio is None:
            raise VtError("no captions available and no media cached — "
                          "run `vt.py fetch <src> --audio` then retry")
        words, source, language = whisper_transcribe(audio, args.model)

    if not words:
        raise VtError("transcript came back empty")

    t = {"key": video_key(args.src), "source": source, "language": language,
         **build_transcript(words, duration)}
    save_json(tp, t)
    return {"ok": True, "cached": False, "path": str(tp), "source": source,
            "words": t["word_count"], "punctuated": t["punctuated"],
            "granularity": t["granularity"], "breaks": len(t["breaks"])}


# --------------------------------------------------------------------- signals


def decode_rms(media: Path, sample_rate: int = 8000) -> list[float] | None:
    """Per-second RMS of the audio track, via ffmpeg. I/O half of the energy signal."""
    cmd = ["ffmpeg", "-v", "error", "-i", str(media), "-ac", "1",
           "-ar", str(sample_rate), "-f", "s16le", "-"]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
    except OSError:
        return None

    import array
    rms: list[float] = []
    chunk_bytes = sample_rate * 2
    assert proc.stdout is not None
    with proc.stdout:
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
    if proc.wait() != 0:
        # A truncated decode would be zero-padded to full length, and the
        # rolling median would then read that fabricated silence as baseline —
        # distorting spike detection across the whole timeline. Better no
        # energy signal than a quietly wrong one.
        return None
    return rms or None


def cmd_signals(args) -> dict:
    d = cache_dir(args.src)
    ip = info_path(d)
    tp = d / "transcript.json"
    if ip is None:
        raise VtError("no metadata cached — run `vt.py fetch` first")
    if not tp.exists():
        raise VtError("no transcript cached — run `vt.py transcript` first")

    info = load_json(ip)
    t = load_json(tp)
    n = int(math.ceil(t.get("duration") or info.get("duration") or 0))

    media = media_file(d)
    energy = None
    note = None
    if not have_ffmpeg():
        note = "ffmpeg not installed"
    elif media is None:
        note = "no media cached (fetch --audio)"
    else:
        rms = decode_rms(media)
        if rms:
            energy = rms_to_spike(rms, n)
        else:
            note = "audio decode produced no samples"

    weights_override = None
    if args.weights:
        try:
            weights_override = json.loads(args.weights)
        except json.JSONDecodeError as e:
            raise VtError(f"--weights is not valid JSON: {e}")
        if not isinstance(weights_override, dict):
            raise VtError("--weights must be a JSON object, "
                          'e.g. \'{"heatmap": 0.5}\'')

    out = {"key": video_key(args.src),
           **build_signals(info, t, energy, weights_override, note)}
    save_json(d / "signals.json", out)
    return {"ok": True, "path": str(d / "signals.json"),
            "duration": out["duration"], "available": out["available"],
            "weights_used": out["weights_used"], "meta": out["meta"]}


# ------------------------------------------------------------------ candidates


def cmd_candidates(args) -> dict:
    d = cache_dir(args.src)
    sp, tp = d / "signals.json", d / "transcript.json"
    if not sp.exists():
        raise VtError("no signals cached — run `vt.py signals` first")
    if not tp.exists():
        raise VtError("no transcript cached — run `vt.py transcript` first")
    sig = load_json(sp)
    t = load_json(tp)
    ip = info_path(d)
    chapters = (load_json(ip).get("chapters") or []) if ip else []

    params = CandidateParams(count=args.count, min_len=args.min,
                             max_len=args.max, skip_head=args.skip_head,
                             skip_tail=args.skip_tail)
    out = {"key": video_key(args.src),
           **find_candidates(sig, t, chapters, params)}
    save_json(d / "candidates.json", out)

    kept = out["candidates"]
    return {"ok": True, "path": str(d / "candidates.json"),
            "count": len(kept),
            "signals_available": out["signals_available"],
            "punctuated_transcript": out["punctuated_transcript"],
            "candidates": [
                {k: c[k] for k in
                 ("rank", "start", "end", "duration", "fused_mean",
                  "signals", "opener_ok", "boilerplate", "chapter", "text")}
                for c in kept]}


# ------------------------------------------------------------ validate-moments


def cmd_validate_moments(args) -> dict:
    mpath = Path(args.moments).expanduser()
    if not mpath.exists():
        raise VtError(f"{mpath} not found")
    try:
        moments = load_json(mpath)
    except ValueError as e:
        raise VtError(f"{mpath} is not valid JSON: {e}")

    claimed = (moments.get("source") or {}).get("url")
    src = args.src or claimed
    if not src:
        raise VtError("no --src given and moments.json has no source.url — "
                      "one of them must say which video these times belong to")

    # Check the file's own claim, not the override. Deriving both from --src
    # would make the mismatch undetectable, which is the whole point of it.
    claimed_key = video_key(claimed) if claimed else video_key(src)

    tp = cache_dir(src, create=False) / "transcript.json"
    if not tp.exists():
        raise VtError(f"no transcript cached for {src} — "
                      f"run `vt.py transcript <src>` first")

    report = validate_moments(
        moments, load_json(tp),
        ClipConstraints(min_len=args.min, max_len=args.max,
                        tol=args.tol, strict=args.strict),
        source_key=claimed_key)

    if args.fix:
        save_json(Path(args.fix).expanduser(), report.repaired)

    return {
        "ok": report.ok,
        "moments": len(moments.get("moments") or []),
        "violations": [asdict(v) for v in report.violations],
        "warnings": [asdict(w) for w in report.warnings],
        "fixed": args.fix or None,
        # The violation messages are multi-line and meant to be read; JSON
        # escaping them makes that hard, so hand over a rendered copy too.
        "report": "\n".join([v.message for v in report.violations]
                            + [f"warning: {w.message}" for w in report.warnings]),
    }


# -------------------------------------------------------------------- info


def cmd_info(args) -> dict:
    d = cache_dir(args.src, create=False)
    if not d.exists():
        return {"ok": True, "key": video_key(args.src), "dir": str(d),
                "cached": False, "next": "vt.py fetch <src>"}
    ip = info_path(d)
    info = load_json(ip) if ip else {}
    return {
        "ok": True, "key": video_key(args.src), "dir": str(d), "cached": True,
        "title": info.get("title"), "duration": info.get("duration"),
        "have": {
            "metadata": ip is not None,
            "heatmap": bool(info.get("heatmap")),
            "comments": bool(info.get("comments")),
            "chapters": bool(info.get("chapters")),
            "subtitles": bool(list(d.glob("src.*.json3"))
                              or list(d.glob("src.*.vtt"))),
            "media": media_file(d) is not None,
            "transcript": (d / "transcript.json").exists(),
            "signals": (d / "signals.json").exists(),
            "candidates": (d / "candidates.json").exists(),
        },
        "tools": {"yt_dlp": bool(shutil.which("yt-dlp")) or _module("yt_dlp"),
                  "ffmpeg": have_ffmpeg(),
                  "ffprobe": shutil.which("ffprobe") is not None},
    }


def _module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except ImportError:
        return False


# --------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="vt.py", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info")
    p.add_argument("src")
    p.set_defaults(fn=cmd_info)

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

    p = sub.add_parser("validate-moments")
    p.add_argument("moments", help="path to a moments.json")
    p.add_argument("--src", default=None,
                   help="video URL or path (default: moments.json's source.url)")
    p.add_argument("--min", type=float, default=15.0)
    p.add_argument("--max", type=float, default=90.0)
    p.add_argument("--tol", type=float, default=0.05,
                   help="how close to a break counts as on it (default 0.05s)")
    p.add_argument("--strict", action="store_true",
                   help="require exact equality with a break")
    p.add_argument("--fix", default=None,
                   help="write a copy with edges snapped to exact break values")
    p.set_defaults(fn=cmd_validate_moments)

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

    return ap


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.fn(args)
    except VtError as e:
        # The only place an anticipated failure becomes output. A Worker swaps
        # this handler for a 400 and everything below it stays unchanged.
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1
    print(json.dumps(result, indent=2))
    # A command that reports ok:false must not exit 0, so it can gate a chain
    # like `validate-moments && render`.
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
