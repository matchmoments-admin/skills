"""Choosing what part of a wide frame becomes a 9:16 clip.

The renderer never calls a detector. It consumes an optional `speaker_track.json`
produced by a separate step, so the hard part — smoothing, hysteresis, pane
assignment — ships and is tested now, against hand-written fixtures, while the
detector itself can arrive later without changing a single caller.

Everything here is pure.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .errors import VtError
from .signals import gaussian_blur

TARGET_W = 1080
TARGET_H = 1920
TARGET_ASPECT = TARGET_W / TARGET_H          # 0.5625

# A talking head sways constantly. Below this fraction of frame width the crop
# should simply not move — jitter on a crop is nauseating to watch.
DEADZONE_FRAC = 0.06
# Hard ceiling on how fast the frame may travel, in source pixels per second.
SLEW_PX_PER_SECOND = 220.0
# Smoothing width. Wide enough to absorb detector noise, short enough to keep up.
SMOOTH_SECONDS = 0.75
# How long one speaker must dominate before the crop follows them. Without this
# a two-second "mm-hm" whips the frame across and back.
SWITCH_HOLD_SECONDS = 0.6

LAYOUTS = ("center", "split", "fit", "path", "auto")


@dataclass(frozen=True)
class SourceInfo:
    width: int
    height: int
    fps: float = 30.0
    codec: str = "h264"
    rotation: int = 0
    duration: float = 0.0
    has_audio: bool = True

    @property
    def displayed(self) -> tuple[int, int]:
        """ffmpeg auto-rotates on decode, but ffprobe reports coded dimensions.
        Crop rects must be computed against what the decoder actually emits."""
        if abs(self.rotation) % 180 == 90:
            return self.height, self.width
        return self.width, self.height

    @property
    def aspect(self) -> float:
        w, h = self.displayed
        return w / h if h else 0.0


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    def as_crop(self) -> str:
        return f"crop={self.w}:{self.h}:{self.x}:{self.y}"


@dataclass(frozen=True)
class ReframePlan:
    layout: str
    rect: Rect | None = None
    panes: tuple[Rect, ...] = ()
    crop_expr: str | None = None
    crop_size: tuple[int, int] | None = None
    reason: str = ""


@dataclass(frozen=True)
class Face:
    x: int
    y: int
    w: int
    h: int
    speaking: float = 0.0
    id: str = "A"

    @property
    def cx(self) -> float:
        return self.x + self.w / 2


@dataclass(frozen=True)
class TrackSample:
    t: float
    faces: tuple[Face, ...]


@dataclass(frozen=True)
class SpeakerTrack:
    fps: float
    frame_w: int
    frame_h: int
    samples: tuple[TrackSample, ...]

    def between(self, start: float, end: float) -> list[TrackSample]:
        return [s for s in self.samples if start <= s.t < end]

    def scale_to(self, source_width: int) -> float:
        """Factor mapping track coordinates onto the source frame.

        Detectors normally run on a downscaled copy — that is why the schema
        carries frame_w at all. Applying its coordinates raw puts every crop at
        roughly half the correct x, silently.
        """
        if not self.frame_w or not source_width:
            return 1.0
        return source_width / self.frame_w


def parse_track(data: dict) -> SpeakerTrack:
    """Build a SpeakerTrack from the on-disk JSON shape."""
    samples = []
    for s in data.get("samples") or []:
        faces = tuple(
            Face(x=int(f["x"]), y=int(f["y"]), w=int(f["w"]), h=int(f["h"]),
                 speaking=float(f.get("speaking") or 0.0),
                 id=str(f.get("id") or "A"))
            for f in (s.get("faces") or []))
        samples.append(TrackSample(t=float(s["t"]), faces=faces))
    return SpeakerTrack(fps=float(data.get("fps") or 2.0),
                        frame_w=int(data.get("frame_w") or 0),
                        frame_h=int(data.get("frame_h") or 0),
                        samples=tuple(samples))


# ------------------------------------------------------------------ geometry


def even(v: float) -> int:
    """Largest even value at or below v. For offsets, where overshooting the
    frame is worse than losing a pixel.

    yuv420p needs even coordinates, and `crop` rounds down to even itself unless
    exact=1 — quantising here keeps the plan honest about what ffmpeg will do.
    """
    return int(v) - (int(v) % 2)


def even_round(v: float) -> int:
    """Nearest even value. For crop *dimensions*, where flooring skews aspect:
    a 9:16 crop of 1080p wants 607.5px, and taking 606 stretches faces by 0.25%
    on the way to 1080 wide. 608 does not."""
    return int(round(v / 2.0)) * 2


def portrait_crop(source: SourceInfo, cx: float | None = None) -> Rect:
    """The largest 9:16 rectangle available, centred on `cx` if given."""
    w, h = source.displayed
    if w / h > TARGET_ASPECT:
        cw, ch = int(h * TARGET_ASPECT), h
    else:
        cw, ch = w, int(w / TARGET_ASPECT)
    cw, ch = min(cw, w), min(ch, h)
    cw, ch = even_round(cw), even_round(ch)
    cw, ch = min(cw, even(w)), min(ch, even(h))
    centre = w / 2 if cx is None else cx
    x = even(max(0, min(w - cw, centre - cw / 2)))
    y = even(max(0, (h - ch) / 2))
    return Rect(x=x, y=y, w=cw, h=ch)


def split_panes(source: SourceInfo, centres: tuple[float, float] | None = None
                ) -> tuple[Rect, Rect]:
    """Two panes stacked vertically, each 1080x960 after scaling.

    Better than reframing for a two-shot: both speakers stay on screen, so a
    conversation reads as a conversation and no cut is ever wrong.
    """
    w, h = source.displayed
    pane_aspect = TARGET_W / (TARGET_H / 2)          # 1.125
    pw = even_round(min(w / 2, h * pane_aspect))
    ph = even_round(min(h, pw / pane_aspect))
    pw, ph = min(pw, even(w)), min(ph, even(h))
    y = even(max(0, (h - ph) / 2))
    if centres is None:
        left, right = w * 0.25, w * 0.75
    else:
        left, right = centres
    return (
        Rect(x=even(max(0, min(w - pw, left - pw / 2))), y=y, w=pw, h=ph),
        Rect(x=even(max(0, min(w - pw, right - pw / 2))), y=y, w=pw, h=ph),
    )


# ----------------------------------------------------------------- smoothing


def dominant_speaker(samples: list[TrackSample], fps: float,
                     hold: float = SWITCH_HOLD_SECONDS) -> list[str]:
    """Who the crop should follow at each sample, with switching hysteresis."""
    if not samples:
        return []
    # Round up, and never accept a single sample: at a 2fps track 0.6s is 1.2
    # samples, and flooring that to 1 lets exactly the blip this guards against
    # move the crop.
    need = max(2, math.ceil(hold * fps))
    out: list[str] = []
    current = _loudest(samples[0])
    streak_id, streak = current, 0
    for s in samples:
        loudest = _loudest(s)
        if not loudest:
            # No face this sample — a head turn, a cutaway, a dropped
            # detection. Hold, rather than letting "nobody" claim the streak
            # and reset the crop to per-sample jitter.
            out.append(current)
            continue
        if loudest == streak_id:
            streak += 1
        else:
            streak_id, streak = loudest, 1
        if streak_id != current and streak >= need:
            current = streak_id
        out.append(current)
    return out


def _loudest(sample: TrackSample) -> str:
    if not sample.faces:
        return ""
    return max(sample.faces, key=lambda f: f.speaking).id


def apply_deadzone(values: list[float], threshold: float) -> list[float]:
    """Hold position until movement is worth making."""
    if not values:
        return []
    out = [values[0]]
    held = values[0]
    for v in values[1:]:
        if abs(v - held) > threshold:
            held = v
        out.append(held)
    return out


def limit_slew(values: list[float], max_step: float) -> list[float]:
    if not values:
        return []
    out = [values[0]]
    for v in values[1:]:
        prev = out[-1]
        delta = max(-max_step, min(max_step, v - prev))
        out.append(prev + delta)
    return out


def smooth_path(values: list[float], fps: float, frame_width: int,
                deadzone_frac: float = DEADZONE_FRAC,
                slew: float = SLEW_PX_PER_SECOND,
                sigma_seconds: float = SMOOTH_SECONDS) -> list[float]:
    """Deadzone, then blur, then slew-limit. Order matters.

    Deadzone first so the blur is not fed jitter it will smear across
    neighbours; slew last so it is the hard ceiling nothing can exceed.
    """
    if not values:
        return []
    out = apply_deadzone(values, deadzone_frac * frame_width)
    out = gaussian_blur(out, max(1.0, sigma_seconds * fps))
    return limit_slew(out, slew / max(fps, 1e-6))


# ------------------------------------------------------------- crop compiler


def compile_crop_expr(keyframes: list[tuple[float, float]],
                      precision: int = 2) -> str:
    """A piecewise-linear ffmpeg expression for a moving crop.

    Written as a flat sum of clamped ramps rather than nested `if(lt(t,..))`,
    which would grow O(N) deep and become unreadable and slow. `sendcmd` is the
    obvious alternative and is wrong here: it only does step changes, so the
    crop would teleport between keyframes instead of travelling.
    """
    if not keyframes:
        raise VtError("cannot compile a crop path with no keyframes")
    pts = sorted(keyframes)
    terms = [f"{pts[0][1]:.{precision}f}"]
    for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
        # Guard the rounded value, not the raw one: a 4ms interval passes
        # `dt > 0` but prints as "/0.00", and ffmpeg then divides by zero and
        # the crop x becomes nan for the whole clip.
        dt = round(t1 - t0, precision)
        dx = round(x1 - x0, precision)
        if dt <= 0 or abs(dx) < 10 ** -precision:
            continue
        terms.append(
            f"({dx:.{precision}f})*clip((t-{t0:.{precision}f})"
            f"/{dt:.{precision}f},0,1)")
    return "+".join(terms)


def evaluate_crop_expr(keyframes: list[tuple[float, float]], t: float,
                       precision: int = 2) -> float:
    """The same maths in Python, so a test can check ffmpeg's expression.

    Must skip exactly the terms `compile_crop_expr` skips, or the two drift
    apart on a long path made of sub-0.01px steps and the check is worthless.
    """
    pts = sorted(keyframes)
    value = pts[0][1]
    for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
        dt = round(t1 - t0, precision)
        dx = round(x1 - x0, precision)
        if dt <= 0 or abs(dx) < 10 ** -precision:
            continue
        value += dx * min(1.0, max(0.0, (t - t0) / dt))
    return value


# -------------------------------------------------------------------- plan


def plan_reframe(layout: str, start: float, end: float, source: SourceInfo,
                 track: SpeakerTrack | None = None) -> ReframePlan:
    """Decide the framing for one clip. Signature does not change when a
    detector starts supplying `track`."""
    if layout not in LAYOUTS:
        raise VtError(f"unknown layout {layout!r}. "
                      f"Choose from: {', '.join(LAYOUTS)}")

    samples = track.between(start, end) if track else []
    # Detectors normally run on a downscaled copy of the video.
    scale = track.scale_to(source.displayed[0]) if track else 1.0

    if layout == "auto":
        layout, reason = _auto_layout(source, samples)
    else:
        reason = "requested"

    if layout == "fit":
        return ReframePlan(layout="fit", reason=reason)

    if layout == "split":
        centres = _pane_centres(samples, scale)
        return ReframePlan(layout="split",
                           panes=split_panes(source, centres),
                           reason=reason)

    if layout == "path":
        if not samples:
            return ReframePlan(layout="center", rect=portrait_crop(source),
                               reason="no speaker track for this clip")
        return _plan_path(start, source, track, samples, reason, scale)

    cx = _mean_face_centre(samples, scale)
    return ReframePlan(layout="center", rect=portrait_crop(source, cx),
                       reason=reason)


def _auto_layout(source: SourceInfo, samples: list[TrackSample]) -> tuple[str, str]:
    """Without a track this is an honest guess, which is why `--preview` exists:
    a contact sheet turns the choice into something a reader can actually judge."""
    if samples:
        ids = {f.id for s in samples for f in s.faces}
        if len(ids) >= 2:
            return "split", "two speakers detected in this clip"
        return "path", "one speaker detected in this clip"
    if source.aspect <= 1.4:
        return "center", "no track; source is not wide, centre crop is safe"
    return "split", "no track; wide source, keeping both halves on screen"


def _mean_face_centre(samples: list[TrackSample],
                      scale: float = 1.0) -> float | None:
    faces = [f for s in samples for f in s.faces]
    if not faces:
        return None
    return scale * sum(f.cx for f in faces) / len(faces)


def _pane_centres(samples: list[TrackSample],
                  scale: float = 1.0) -> tuple[float, float] | None:
    """Centre each pane on a real face rather than a blind half."""
    by_id: dict[str, list[float]] = {}
    for s in samples:
        for f in s.faces:
            by_id.setdefault(f.id, []).append(f.cx)
    if len(by_id) < 2:
        return None
    means = sorted(scale * sum(v) / len(v) for v in by_id.values())
    return means[0], means[-1]


def _plan_path(start: float, source: SourceInfo, track: SpeakerTrack,
               samples: list[TrackSample], reason: str,
               scale: float = 1.0) -> ReframePlan:
    rect = portrait_crop(source)
    w, _ = source.displayed
    speakers = dominant_speaker(samples, track.fps)
    centres: list[float] = []
    for sample, who in zip(samples, speakers):
        face = next((f for f in sample.faces if f.id == who), None)
        if face is None:
            face = max(sample.faces, key=lambda f: f.speaking, default=None)
        centres.append(scale * face.cx if face else w / 2)

    xs = [max(0.0, min(w - rect.w, c - rect.w / 2)) for c in centres]
    xs = smooth_path(xs, track.fps, w)
    keyframes = [(round(s.t - start, 3), float(even(x)))
                 for s, x in zip(samples, xs)]
    return ReframePlan(layout="path",
                       crop_expr=compile_crop_expr(keyframes),
                       crop_size=(rect.w, rect.h),
                       rect=rect,
                       reason=reason)
