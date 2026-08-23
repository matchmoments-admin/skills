"""Burned-in captions: phrasing, safe areas, and the two rendering back ends.

There are two back ends because libass is not a given. A conda ffmpeg 4.x build
has `--enable-libfreetype` and no `ass`/`subtitles` filter at all, so an ASS file
cannot be burned in on that machine. `drawtext` is always present with
libfreetype, and one instance per word gives the single-word "pop" style — which
is the dominant short-form caption style anyway, not merely a fallback.

All times here are **clip-relative**. The renderer seeks with `-ss` before `-i`
and resets timestamps with `setpts=PTS-STARTPTS`, so a caption timed against the
source would drift by exactly `clip.start` seconds. `clip_words()` is the single
place that conversion happens.

Everything in this module is pure. Sidecar files are returned as values for the
caller to write.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Fractions of the frame that platform chrome covers. The bottom rail is the
# tight one: TikTok stacks the caption, handle and CTA there.
SAFE_TOP = 0.10
SAFE_BOTTOM = 0.15
SAFE_SIDE = 0.075

# Where the text block sits vertically, as a fraction of height. Low enough to
# read as a caption, high enough that two lines clear the bottom rail.
TEXT_CENTER = 0.615

# Phrasing limits. Short lines are read at a glance; long ones are not read.
MAX_WORDS_PER_LINE = 3
MAX_CHARS_PER_LINE = 22
MAX_LINES = 2
MIN_PHRASE_SECONDS = 0.35

# Characters per second used to distribute a cue's duration across its words
# when the transcript is cue-level and has no per-word timings.
CHARS_PER_SECOND = 15.0


@dataclass(frozen=True)
class Box:
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    def contains(self, x0: int, y0: int, x1: int, y1: int) -> bool:
        return (x0 >= self.x0 and y0 >= self.y0
                and x1 <= self.x1 and y1 <= self.y1)


@dataclass(frozen=True)
class TimedWord:
    t: float          # clip-relative start
    d: float          # duration
    w: str

    @property
    def end(self) -> float:
        return self.t + self.d


@dataclass(frozen=True)
class Phrase:
    lines: tuple[tuple[TimedWord, ...], ...]

    @property
    def words(self) -> tuple[TimedWord, ...]:
        return tuple(w for line in self.lines for w in line)

    @property
    def start(self) -> float:
        return self.words[0].t

    @property
    def end(self) -> float:
        return self.words[-1].end


@dataclass(frozen=True)
class CaptionStyle:
    font_size: int = 96
    outline: int = 8
    case: str = "upper"                       # upper | sentence | as-is
    active_rgb: tuple[int, int, int] = (255, 229, 0)
    base_rgb: tuple[int, int, int] = (255, 255, 255)
    highlight: bool = True                    # False => plain static cues


@dataclass(frozen=True)
class Sidecar:
    """A file the caller must write before invoking ffmpeg."""
    path: str
    content: str


@dataclass
class CaptionPlan:
    backend: str                              # "ass" | "drawtext"
    filter_chain: str
    sidecars: list[Sidecar] = field(default_factory=list)
    timing: str = "measured"                  # measured | estimated


# ------------------------------------------------------------------ geometry


def caption_box(width: int = 1080, height: int = 1920,
                top: float = SAFE_TOP, bottom: float = SAFE_BOTTOM,
                side: float = SAFE_SIDE) -> Box:
    """The rectangle captions may occupy, after platform chrome."""
    return Box(x0=int(width * side), y0=int(height * top),
               x1=int(width * (1 - side)), y1=int(height * (1 - bottom)))


def text_block_rect(n_lines: int, style: CaptionStyle, width: int = 1080,
                    height: int = 1920) -> tuple[int, int, int, int]:
    """Approximate bounds of an n-line block centred at TEXT_CENTER.

    Line height is the font size plus leading plus the outline on both sides —
    deliberately generous, because the check that matters is that the block
    stays clear of the bottom rail even when the estimate is a little large.
    """
    line_h = int(style.font_size * 1.22) + style.outline * 2
    block_h = line_h * n_lines
    cy = int(height * TEXT_CENTER)
    y0 = cy - block_h // 2
    box = caption_box(width, height)
    return box.x0, y0, box.x1, y0 + block_h


# ------------------------------------------------------------------- timing


def clip_words(words: list[dict], start: float, end: float) -> list[TimedWord]:
    """Slice the transcript to a clip and rebase times to zero.

    The renderer seeks before decoding and resets PTS, so anything still carrying
    absolute timestamps lands `start` seconds late. This is the only conversion.
    """
    out = []
    for w in words:
        t = float(w["t"])
        if t < start or t >= end:
            continue
        d = float(w.get("d") or 0.0)
        out.append(TimedWord(t=round(t - start, 3),
                             d=round(min(d, end - t), 3),
                             w=str(w["w"]).strip()))
    return [w for w in out if w.w]


def distribute_word_times(text: str, start: float, duration: float
                          ) -> list[TimedWord]:
    """Spread a cue's duration across its words, proportional to length.

    Used when the transcript is cue-level. Timing drifts within a cue but is
    exact at every cue boundary, so the error is bounded by the cue and never
    accumulates across the clip.
    """
    parts = [p for p in text.split() if p]
    if not parts:
        return []
    weights = [max(1, len(p)) for p in parts]
    total = sum(weights)
    out, t = [], start
    for i, (p, wt) in enumerate(zip(parts, weights)):
        # Give the last word whatever remains so the sum is exact.
        d = (start + duration - t) if i == len(parts) - 1 \
            else duration * (wt / total)
        out.append(TimedWord(t=round(t, 3), d=round(d, 3), w=p))
        t += d
    return out


def expand_segments(words: list[TimedWord]) -> list[TimedWord]:
    """Turn cue-level entries into per-word entries with estimated timings."""
    out: list[TimedWord] = []
    for w in words:
        if " " in w.w:
            out.extend(distribute_word_times(w.w, w.t, w.d))
        else:
            out.append(w)
    return out


# ------------------------------------------------------------------- casing


ACRONYMS = {"ai", "api", "cpu", "gpu", "url", "usa", "uk", "nasa", "ceo", "phd",
            "hd", "tv", "pc", "id", "os", "ui", "ux", "ml", "llm", "gpt"}


def apply_case(text: str, case: str) -> str:
    if case == "upper":
        return text.upper()
    if case == "sentence":
        stripped = text.strip("'\"([")
        if stripped.lower().strip(".,!?") in ACRONYMS:
            return text.upper()
        return text
    return text


def default_case(punctuated: bool) -> str:
    """Auto-captions are lowercase with no punctuation; uppercase hides that
    entirely and is the dominant short-form style. Punctuated sources are left
    alone rather than having a guess imposed on them."""
    return "upper" if not punctuated else "as-is"


# ------------------------------------------------------------------ phrasing


def group_phrases(words: list[TimedWord], breaks: list[float],
                  pause_threshold: float = 0.45,
                  max_words: int = MAX_WORDS_PER_LINE,
                  max_chars: int = MAX_CHARS_PER_LINE,
                  max_lines: int = MAX_LINES) -> list[Phrase]:
    """Group words into caption phrases.

    A `break` is a hard boundary, so captions and cuts tell the same story and
    the artifact that already governs clip edges governs caption edges too.
    Punctuation is deliberately not used: `punctuated` is false on every
    auto-captioned source, so punctuation-driven phrasing looks excellent in
    testing on a manual-caption video and collapses to one enormous phrase on
    the case that is actually the norm.

    `breaks` are clip-relative.
    """
    if not words:
        return []
    hard = sorted(breaks)
    phrases: list[Phrase] = []
    lines: list[list[TimedWord]] = [[]]

    def flush():
        filled = [tuple(ln) for ln in lines if ln]
        if filled:
            phrases.append(Phrase(lines=tuple(filled)))
        lines.clear()
        lines.append([])

    for i, w in enumerate(words):
        cur = lines[-1]
        too_many = len(cur) >= max_words
        too_wide = cur and sum(len(x.w) + 1 for x in cur) + len(w.w) > max_chars
        if too_many or too_wide:
            if len(lines) >= max_lines:
                flush()
            else:
                lines.append([])
        lines[-1].append(w)

        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt is None:
            break
        crosses_break = any(w.end <= b <= nxt.t for b in hard)
        long_gap = (nxt.t - w.end) >= pause_threshold
        if crosses_break or long_gap:
            flush()
    flush()

    return _merge_flashes(phrases)


def _merge_flashes(phrases: list[Phrase]) -> list[Phrase]:
    """Fold away phrases too brief to read — they register as flicker."""
    out: list[Phrase] = []
    for p in phrases:
        if out and (p.end - p.start) < MIN_PHRASE_SECONDS:
            prev = out.pop()
            merged = list(prev.lines)
            if len(merged) < MAX_LINES:
                merged.append(p.words)
            else:
                merged[-1] = merged[-1] + p.words
            out.append(Phrase(lines=tuple(merged)))
        else:
            out.append(p)
    return out


# ---------------------------------------------------------------- ASS output


def ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def ass_color(r: int, g: int, b: int, a: int = 0) -> str:
    """ASS colours are &HAABBGGRR — bytes reversed relative to RGB."""
    return f"&H{a:02X}{b:02X}{g:02X}{r:02X}"


def ass_escape(text: str) -> str:
    return (text.replace("\\", "\\\\").replace("{", r"\{")
                .replace("}", r"\}").replace("\r", "").replace("\n", " "))


def render_ass(phrases: list[Phrase], style: CaptionStyle, font: str,
               width: int = 1080, height: int = 1920) -> str:
    """A full ASS file with per-word karaoke.

    One Dialogue event per word rather than `\\k` tags: `\\k` fills
    Secondary->Primary progressively, which highlights everything *already said*
    — the opposite of pointing at the current word. Re-emitting the phrase with
    one word overridden gives the intended effect and degrades gracefully.
    """
    cx = width // 2
    cy = int(height * TEXT_CENTER)
    head = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "ScaledBorderAndShadow: yes",
        "WrapStyle: 2",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        (f"Style: Karaoke,{font},{style.font_size},"
         f"{ass_color(*style.base_rgb)},{ass_color(*style.active_rgb)},"
         f"{ass_color(0, 0, 0)},{ass_color(0, 0, 0, 0x80)},"
         f"-1,0,0,0,100,100,0,0,1,{style.outline},0,5,80,80,0,1"),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
        "MarginV, Effect, Text",
    ]

    active = ass_color(*style.active_rgb)
    body = []
    for phrase in phrases:
        for target in phrase.words:
            parts = []
            for li, line in enumerate(phrase.lines):
                if li:
                    parts.append(r"\N")
                for wi, w in enumerate(line):
                    if wi:
                        parts.append(" ")
                    text = ass_escape(apply_case(w.w, style.case))
                    if style.highlight and w is target:
                        parts.append(
                            "{" + rf"\c{active}&\fscx112\fscy112"
                            r"\t(0,90,\fscx100\fscy100)" + "}" + text + r"{\r}")
                    else:
                        parts.append(text)
            # Alignment 5 with explicit \pos bypasses margin arithmetic, so the
            # safe-area maths in this module is what actually places the text.
            line_text = ("{" + rf"\pos({cx},{cy})\an5" + "}" + "".join(parts))
            body.append(f"Dialogue: 0,{ass_time(target.t)},"
                        f"{ass_time(target.end)},Karaoke,,0,0,0,,{line_text}")
    return "\n".join(head + body) + "\n"


# ----------------------------------------------------------- drawtext output


def drawtext_escape_path(path: str) -> str:
    return path.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


def render_drawtext(phrases: list[Phrase], style: CaptionStyle, font: str,
                    sidecar_dir: str = ".cap", width: int = 1080,
                    height: int = 1920) -> tuple[str, list[Sidecar]]:
    """One `drawtext` per word, centred, shown only while that word is spoken.

    Text goes in a sidecar file rather than inline. Escaping caption text through
    both the filtergraph and drawtext parsers is not reliably solvable — a
    caption containing `[go], ok` gets its bracket parsed as a font name — and
    `textfile=` sidesteps the problem entirely. `expansion=none` stops a literal
    `%` being read as a format directive.
    """
    cy = int(height * TEXT_CENTER)
    font_path = drawtext_escape_path(font)
    chain: list[str] = []
    sidecars: list[Sidecar] = []
    idx = 0
    for phrase in phrases:
        for w in phrase.words:
            rel = f"{sidecar_dir}/w{idx:04d}.txt"
            sidecars.append(Sidecar(path=rel,
                                    content=apply_case(w.w, style.case)))
            chain.append(
                f"drawtext=fontfile='{font_path}'"
                f":textfile='{drawtext_escape_path(rel)}'"
                f":expansion=none"
                f":fontsize={style.font_size}"
                f":fontcolor=white"
                f":borderw={style.outline}:bordercolor=black"
                f":shadowx=0:shadowy=6:shadowcolor=black@0.55"
                f":x=(w-text_w)/2"
                f":y={cy}-text_h/2"
                f":enable='between(t,{w.t:.3f},{w.end:.3f})'")
            idx += 1
    return ",".join(chain), sidecars


# --------------------------------------------------------------------- font


def resolve_font(candidates: list[str], exists) -> str:
    """First readable font path wins. `exists` is injected so this stays pure.

    An absolute path is mandatory: without fontconfig, `drawtext=font=Arial`
    fails with "Option not found", and this repo ships no font binaries.
    """
    for path in candidates:
        if path and exists(path):
            return path
    raise ValueError(
        "no caption font found. Set $VT_FONT to a .ttf/.otf path. Tried: "
        + ", ".join(p for p in candidates if p))


FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]
