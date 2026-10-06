---
name: video-toolkit
description: Shared fetch/transcript/signal layer for the video skills. Use when setting up or repairing the video toolchain (yt-dlp, ffmpeg, whisper), when a video skill reports a missing binary, or when you need a transcript, caption timings, YouTube heatmap data, or comment-timestamp signals for a video.
---

# Video toolkit

The deterministic half of the video pipeline. `video-digest` and `video-moments` both
sit on this; it exists so neither of them re-derives a yt-dlp or ffmpeg invocation
from memory on every run.

**Claude Code cannot watch a video.** There is no video content block in the model —
only text, images and PDFs. Everything here works by turning a video into things the
model *can* read: a timed transcript, extracted frames, and numeric signal series.
Anyone claiming Claude Code natively ingests MP4 is describing a different product.

## Layout

`scripts/vt.py` owns every side effect — argparse, the filesystem, yt-dlp, ffmpeg.
The algorithms live in `scripts/vtlib/`, which imports no I/O module at all (a
test enforces this). That split is why the pipeline can be tested without a
network or a media file, and why the signals and candidates stages will port to a
Worker where the cache is R2 rather than a directory.

Anticipated failures raise `VtError`; `main()` is the only place that turns one
into the `{"ok": false, "error": …}` envelope and an exit code.

## The tool

`scripts/vt.py` — one CLI, five commands, all idempotent, all writing into a
content-keyed cache at `~/.cache/video-toolkit/<key>/`. Every command prints a small
JSON summary to stdout and leaves the bulky artifacts on disk. Re-running is cheap;
never re-fetch to "make sure".

```
vt.py info       <src>                              what's cached, what's missing
vt.py fetch      <src> [--comments] [--audio] [--video]
vt.py transcript <src> [--whisper] [--model M]
vt.py signals    <src> [--weights JSON]
vt.py candidates <src> [--count N] [--min S] [--max S]
vt.py validate-moments <moments.json> [--src URL] [--fix OUT] [--strict]
```

`<src>` is a URL (anything yt-dlp handles) or a local media path. Invoke as
`python3 ~/.claude/skills/video-toolkit/scripts/vt.py …`.

Run `vt.py info <src>` first. It tells you what's already cached and what the next
command should be, which is almost always cheaper than guessing.

## Setup

`scripts/preflight.sh` reports what's present and what's missing. It changes nothing
without `--install`.

| Tool | Needed for | Install |
|---|---|---|
| **yt-dlp** | metadata, captions, heatmap, comments | `pip install yt-dlp` |
| **ffmpeg** | audio energy signal, frame extraction, rendering | brew / conda / apt |
| **mlx-whisper** or **faster-whisper** | only when a video has *no* captions | `--with-whisper` |

Whisper is genuinely optional. Most YouTube videos have captions, and captions are
free and instant. Don't install an ASR stack pre-emptively.

## Transcripts: captions first, ASR second

`vt.py transcript` prefers, in order:

1. **Manual captions, json3** — punctuated, cue-level timing. Best quality.
2. **Auto captions, json3** — YouTube's `json3` format carries per-word `tOffsetMs`,
   so you get **word-level timings for free with zero compute**. This is the single
   most useful thing in the toolkit and the reason not to reach for Whisper.
3. **vtt** — cue-level only, used when json3 isn't offered.
4. **Whisper** — only when there are no captions at all, or `--whisper` is forced.
   Requires `fetch --audio` first.

The output `transcript.json` is the contract:

```jsonc
{
  "source": "youtube-auto:json3",   // or youtube-manual:json3 | vtt | whisper-mlx:<repo>
  "granularity": "word",            // or "segment" — cue-level, not per word
  "punctuated": false,              // auto captions have NO punctuation
  "durations_measured": false,      // true only for Whisper's real word times
  "duration": 7412.5,
  "break_source": "pauses",         // punctuation | pauses | both
  "pause_threshold": 0.52,          // null when the pause pass did not run
  "break_density_seconds": 7.99,    // one cut point roughly every 8s
  "max_break_gap_seconds": 41.2,    // the worst stretch with no cut point
  "words":  [{"t": 12.34, "d": 0.31, "w": "network"}, …],
  "breaks": [15.2, 19.8, …]         // clause boundaries — where a cut can land
}
```

Two fields decide how you treat it downstream:

- **`punctuated: false`** means auto captions. There is no punctuation *and* no
  capitalisation. Say so when you hand the text to a model, or it will read run-on
  text as incoherence rather than as a formatting artifact. Never quote auto-caption
  text verbatim as if it were someone's exact words — the wording is an ASR guess.
- **`granularity: "segment"`** means you have cue timings, not word timings. Clip
  edges will be coarser; a 2–4 second cue is the finest cut you can make.

`breaks` are clause boundaries: sentence-final punctuation when the transcript is
punctuated, plus silence. **Clip edges must land on a break** — a cut mid-phrase is
the single most audible defect in an auto-generated clip.

Sentence ends win when there are enough of them. Pause detection is an estimate,
and letting it supplement adequate punctuation introduces mid-sentence cut points
that outrank the real ones — on a real video that moved the top candidate from a
sentence start to the middle of a clause. So pauses supplement only when
punctuation is absent or sparser than one per 12s, and `break_source` records
which happened.

`break_density_seconds` is a whole-video average, so check
`max_break_gap_seconds` too: a mostly-punctuated transcript with one long
unpunctuated stretch has no cut points in that stretch, and a clip landing there
will report `edges_on_breaks: [_, false]`.

Silence detection is subtler than it looks. json3 word timings are *contiguous* —
each word's start is the previous word's end — so raw intervals contain no pauses at
all. `vt.py` subtracts an estimated spoken duration per word to make silence visible,
then picks the gap threshold **adaptively**, targeting roughly one cut point every
8 seconds. A fixed threshold fails badly in both directions: dense auto-captions
yield almost nothing, sparse cue timings yield a break after every cue. Check
`break_density_seconds` — if it is far above 10, snapping will be coarse and you
should say so rather than trusting the edges.

## Signals

`vt.py signals` builds per-second series over the timeline and fuses them. Whatever
is unavailable is dropped and the remaining weights renormalise, so it degrades
rather than fails.

| Series | Source | Default weight | Notes |
|---|---|---|---|
| `heatmap` | YouTube most-replayed, 100 buckets | 0.40 | **Revealed** engagement, not predicted. Only on public videos with enough views. The strongest signal by far when present. Stored as *prominence over a local baseline*, not the raw curve — see below. The raw curve is kept under `diagnostics` in `signals.json`, deliberately outside the fusable set. |
| `comments` | timestamp mentions in top comments, weighted by likes | 0.30 | Needs `fetch --comments`. Viewers literally timestamp the good bits. Gaussian-blurred ±5s. |
| `energy` | per-second RMS above a 60s rolling median | 0.20 | Needs ffmpeg + `fetch --audio`. Spikes ≈ laughter, applause, raised voice. |
| `density` | words per second, blurred | 0.10 | Weak on its own; a useful tiebreak. |

Override with `--weights '{"heatmap":0.6,"comments":0.4}'`. Set a weight to 0 to
drop a series. Naming a signal that isn't fusable is an error rather than a
silent no-op — `heatmap_raw` lives under `diagnostics` precisely so weighting it
cannot double-count the heatmap.

**The heatmap needs two corrections before it is usable.** Raw, its global maximum
is essentially always at t=0 — it measures "pressed play", not "rewatched this" — and
it decays from there. So `vt.py` stores prominence against a wide local baseline,
which removes the decay trend, and `candidates` additionally excludes a head and tail
window, which removes the structural t=0 spike that no detrending can fix. Without
both, every candidate lands in the first three minutes on top of the intro and the
sponsor read. This is the single most common way a clip pipeline produces
confidently wrong output.

**When there is no heatmap** (new video, low view count, or your own unlisted
upload) the fusion leans on comments and energy, and its confidence genuinely drops.
Say so rather than presenting the ranking as authoritative.

## Candidates

`vt.py candidates` turns the fused signal into snapped, self-contained windows:

1. Local maxima above the 75th percentile of the fused score.
2. For each peak, the window placement maximising mean fused score, tried at three
   lengths within `[--min, --max]`.
3. Edges snapped outward to the nearest `breaks`, then pulled back in if snapping
   blew the length budget.
4. Windows opening on a dangling pronoun or conjunction (`and`, `so`, `it`, `this`,
   `they`…) get their start pushed to the next break — a clip has to work for
   someone who joined at second zero.
5. Overlapping windows deduped at IoU > 0.35, stronger one wins.
6. A head and tail window is excluded entirely (default 2% / 1% of duration, clamped
   to 30–180s and 15–120s). Override with `--skip-head` / `--skip-tail`.
7. Windows matching podcast furniture — "thanks for listening", "check out our
   sponsors", "the following is a conversation with" — are flagged `boilerplate` and
   scored down, not dropped. Check the flag rather than trusting it blindly.

Each candidate also carries **`edges_on_breaks: [bool, bool]`**. A `false` means
the length budget beat the break list and that edge is an invented timestamp —
it will cut mid-word. Move it to a nearby break or drop the clip; do not ship it.

Each candidate carries `context_before` and `context_after` (±25s of transcript) plus
`breaks_near_start` / `breaks_near_end`. **Use them.** Most shortlisted windows still
open mid-thought — the signals cannot tell that "NYU and then switching over to…" is
the back half of a sentence. Moving the edge to a nearby break using that context is
the ranking pass's job, and it is where most of the quality comes from.

This is a *shortlist generator*, not a judge. It finds where attention went; it has
no opinion on whether the content is any good. The ranking pass in `video-moments`
is what supplies judgement.

## Cache

`~/.cache/video-toolkit/<key>/` where key is `yt-<video_id>`, or a content hash for
local files and non-YouTube URLs. Override the root with `$VT_CACHE`.

```
src.info.json      full yt-dlp metadata: chapters, heatmap, comments
src.en.json3       captions as fetched
media.*            audio or video, only if requested
transcript.json    canonical timed transcript
signals.json       per-second series + diagnostics + fused
candidates.json    ranked windows
media-kind.txt     "audio" or "video" — what was fetched, not guessed
comments-state.json  attempts + count, so one 429 does not cost the signal
```

Nothing is ever auto-deleted. `du -sh ~/.cache/video-toolkit` occasionally; media
files are the only large ones.

## Failure modes worth recognising

- **HTTP 429 on captions.** YouTube rate-limits caption endpoints hard. `vt.py`
  already backs off and restricts to `en-orig,en,en-US,en-GB` — never widen this to
  `en.*`, which matches every auto-*translated* track and triggers dozens of
  requests. If it still 429s, wait a few minutes.
- **"Sign in to confirm you're not a bot".** You're egressing from a datacenter IP.
  This works from a residential connection and largely doesn't from cloud compute —
  which is why any hosted version of this pipeline must not do the downloading.
- **No captions and no audio cached.** `fetch --audio` then retry; ASR needs a file.
- **Empty heatmap.** Normal for videos under roughly 50k views, and for unlisted or
  private ones. Not an error.

## Validating a moments.json

`vt.py validate-moments <file>` is the front door for anything that renders. It
checks what the prose asks for and nothing can enforce by hand: edges on breaks,
lengths in range, ranks a permutation, no near-duplicates, and — the failure that
is otherwise invisible — that the file's `source.url` is the video the transcript
actually describes.

Membership is **within `--tol` (default 0.05s)**, not exact: breaks are stored to
three decimals, so a model writing `9764.9` would fail exact equality on almost
every real file and the check would be ignored within a week. Inside tolerance
the moment passes and `--fix` writes a copy carrying the exact break value.
`--strict` demands equality and is what fixtures use.

Exit status is non-zero on any violation, so `validate-moments && render` chains.
Warnings — coarse breaks, estimated caption timing, unpunctuated ASR, a
third-party clip over 60s — are reported but do not fail the run.

## Scope

This skill fetches, transcribes and scores. It does not summarise, render clips, or
post anything — that's `video-digest`, `video-moments`, and whatever publishes.
