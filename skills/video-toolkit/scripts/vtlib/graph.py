"""Turning a plan into an ffmpeg filter graph and argv.

Pure: it produces strings. The caller writes the graph to a file and runs it.
That split is what lets the whole render surface be tested without ffmpeg, and
what makes `--dry-run` the primary debugging tool — you can read exactly what
would run before anything is encoded.

Every filter used here exists in ffmpeg 4.x.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .errors import VtError
from .reframe import TARGET_H, TARGET_W, ReframePlan

# Loudness targets. -14 LUFS integrated is the streaming-normalisation
# convention; -1 dBTP leaves headroom for lossy re-encoding downstream.
TARGET_LUFS = -14.0
TARGET_TP = -1.0
TARGET_LRA = 11.0


@dataclass(frozen=True)
class TargetSpec:
    width: int = TARGET_W
    height: int = TARGET_H
    fps: int = 30
    crf: int = 19
    preset: str = "slow"
    audio_bitrate: str = "192k"
    lufs: float = TARGET_LUFS
    true_peak: float = TARGET_TP
    lra: float = TARGET_LRA


@dataclass(frozen=True)
class Measured:
    """Pass-1 loudnorm measurements, fed back into pass 2."""
    input_i: float
    input_tp: float
    input_lra: float
    input_thresh: float
    target_offset: float


@dataclass
class RenderCommand:
    graph: str
    argv: list[str]
    sidecars: list = field(default_factory=list)


# ------------------------------------------------------------------- loudnorm


def parse_loudnorm_json(stderr: str) -> Measured:
    """Pull the measurement block out of a pass-1 loudnorm run.

    ffmpeg prints it to stderr after the usual log noise, as the last JSON
    object. Every value is a *string*, and `input_tp` is "-inf" on silence, so
    plain float() on the raw dict is not enough.
    """
    matches = re.findall(r"\{[^{}]*\}", stderr, re.DOTALL)
    for blob in reversed(matches):
        try:
            data = json.loads(blob)
        except ValueError:
            continue
        if "input_i" not in data:
            continue
        try:
            return Measured(
                input_i=float(data["input_i"]),
                input_tp=float(data["input_tp"]),
                input_lra=float(data["input_lra"]),
                input_thresh=float(data["input_thresh"]),
                target_offset=float(data.get("target_offset", 0.0)),
            )
        except (KeyError, ValueError) as e:
            raise VtError(f"loudnorm measurement block is malformed: {e}")
    raise VtError("no loudnorm measurement block found on stderr — "
                  "the analysis pass probably failed")


def loudnorm_filter(target: TargetSpec, measured: Measured | None) -> str:
    """Pass 1 measures; pass 2 corrects with those numbers.

    Single-pass loudnorm is a *dynamic* normaliser: it pumps audibly on speech
    that contains laughter, which is exactly the material this pipeline selects
    for. Two passes cost one extra decode and are worth it.
    """
    base = (f"loudnorm=I={target.lufs}:TP={target.true_peak}:LRA={target.lra}")
    if measured is None:
        return base + ":print_format=json"
    # A measured true peak of -inf (pure silence) is not a usable input.
    tp = measured.input_tp if measured.input_tp > -99 else -99.0
    return (f"{base}:measured_I={measured.input_i}:measured_TP={tp}"
            f":measured_LRA={measured.input_lra}"
            f":measured_thresh={measured.input_thresh}"
            f":offset={measured.target_offset}:linear=true")


# ---------------------------------------------------------------- video chain


def _tail(target: TargetSpec, captions: str) -> str:
    parts = [f"setsar=1", f"fps={target.fps}", "format=yuv420p"]
    if captions:
        parts.append(captions)
    return ",".join(parts)


def compile_video_graph(plan: ReframePlan, target: TargetSpec,
                        captions: str = "") -> str:
    """The `[0:v] … [v]` half of the filter graph."""
    tail = _tail(target, captions)
    scale = f"scale={target.width}:{target.height}:flags=lanczos"

    if plan.layout == "fit":
        # Crops nothing, so it can never decapitate an off-centre subject.
        return (
            f"[0:v]setpts=PTS-STARTPTS,split=2[bg][fg];"
            f"[bg]scale={target.width}:{target.height}"
            f":force_original_aspect_ratio=increase,"
            f"crop={target.width}:{target.height},gblur=sigma=40,"
            f"eq=brightness=-0.08[bgb];"
            f"[fg]scale={target.width}:-2[fgs];"
            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,{tail}[v]")

    if plan.layout == "split":
        if len(plan.panes) != 2:
            raise VtError("split layout needs exactly two panes")
        top, bottom = plan.panes
        half = target.height // 2
        return (
            f"[0:v]setpts=PTS-STARTPTS,split=2[l][r];"
            f"[l]{top.as_crop()},scale={target.width}:{half}:flags=lanczos[t];"
            f"[r]{bottom.as_crop()},scale={target.width}:{half}:flags=lanczos[b];"
            f"[t][b]vstack=inputs=2,{tail}[v]")

    if plan.layout == "path":
        if not plan.crop_expr or not plan.crop_size:
            raise VtError("path layout needs a crop expression and size")
        cw, ch = plan.crop_size
        y = plan.rect.y if plan.rect else 0
        return (
            f"[0:v]setpts=PTS-STARTPTS,"
            f"crop={cw}:{ch}:x='{plan.crop_expr}':y={y},"
            f"{scale},{tail}[v]")

    if plan.rect is None:
        raise VtError(f"{plan.layout} layout produced no crop rectangle")
    return (f"[0:v]setpts=PTS-STARTPTS,{plan.rect.as_crop()},{scale},{tail}[v]")


def compile_audio_graph(target: TargetSpec, measured: Measured | None,
                        has_audio: bool = True) -> str:
    if not has_audio:
        return ""
    return (f"[0:a]asetpts=PTS-STARTPTS,aresample=48000,"
            f"{loudnorm_filter(target, measured)},"
            f"aformat=sample_fmts=fltp:sample_rates=48000"
            f":channel_layouts=stereo[a]")


def compile_graph(plan: ReframePlan, target: TargetSpec, captions: str = "",
                  measured: Measured | None = None,
                  has_audio: bool = True) -> str:
    video = compile_video_graph(plan, target, captions)
    audio = compile_audio_graph(target, measured, has_audio)
    return f"{video};{audio}" if audio else video


# --------------------------------------------------------------------- argv


def ffmpeg_argv(source: str, out_path: str, graph_path: str, start: float,
                duration: float, target: TargetSpec,
                has_audio: bool = True) -> list[str]:
    """The encode command.

    `-ss` goes **before** `-i`: it is fast, and accurate since ffmpeg 2.1.
    Combined with `setpts=PTS-STARTPTS` it means every caption and crop
    timestamp in the graph is clip-relative. Getting that pairing wrong is the
    classic "captions drift by `start` seconds" bug.
    """
    argv = [
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{start:.3f}", "-i", source, "-t", f"{duration:.3f}",
        "-filter_complex_script", graph_path,
        "-map", "[v]",
    ]
    if has_audio:
        argv += ["-map", "[a]"]
    argv += [
        "-sn", "-dn", "-map_metadata", "-1",
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-preset", target.preset, "-crf", str(target.crf),
        "-maxrate", "12M", "-bufsize", "24M",
        "-g", str(target.fps * 2), "-keyint_min", str(target.fps),
        "-sc_threshold", "0", "-r", str(target.fps),
        # Untagged 1080x1920 is the usual cause of "why is my clip washed out".
        "-color_primaries", "bt709", "-color_trc", "bt709",
        "-colorspace", "bt709",
    ]
    if has_audio:
        argv += ["-c:a", "aac", "-b:a", target.audio_bitrate,
                 "-ar", "48000", "-ac", "2"]
    argv += ["-movflags", "+faststart", out_path]
    return argv


def loudnorm_probe_argv(source: str, graph_filter: str, start: float,
                        duration: float) -> list[str]:
    """Pass 1: measure only, decode no video, write no file."""
    return ["ffmpeg", "-hide_banner", "-nostats",
            "-ss", f"{start:.3f}", "-i", source, "-t", f"{duration:.3f}",
            "-vn", "-af", graph_filter, "-f", "null", "-"]
