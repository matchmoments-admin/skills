---
name: video-digest
description: Turn a video into a structured, timestamped summary — recipe, tutorial, SOP, podcast notes, lecture notes or meeting notes. Use when the user pastes a video URL and wants it summarised, wants the recipe or steps extracted, wants notes from a talk or podcast, or asks what a video says.
---

# Video digest

A video URL in, a structured Markdown note out, with a **timestamp and a confidence
on every extracted claim** so the user can jump back and check.

Depends on [video-toolkit](../video-toolkit/SKILL.md) for fetching and transcription.
Read that skill's contract before doing anything here.

## The rule that matters most

**Flag, don't invent.**

Auto-generated captions mangle numbers, units and proper nouns constantly — "two
cups" becomes "to cups", "180 degrees" becomes "one 80 degrees", a name becomes a
different name. The failure mode is not that the model refuses; it is that the model
quietly produces a plausible, confident, wrong quantity, and the user cooks it.

So, for anything a person will act on:

- Write `[not stated]` when a quantity was never given. Never interpolate a
  "sensible" amount.
- Write `[unclear: heard "to cups"]` when the caption is garbled, rather than
  silently picking the likely reading.
- Attach a timestamp to every quantity, step and claim. That is the user's escape
  hatch, and it costs nothing.
- When `transcript.json` reports `"punctuated": false`, you are reading an ASR guess.
  Do not present any of it as a verbatim quote.

A digest that says "I couldn't tell how much butter" is useful. One that guesses
"2 tablespoons" is worse than nothing.

## Flow

```bash
VT=~/.claude/skills/video-toolkit/scripts/vt.py
python3 $VT info       "<url>"    # what's cached already
python3 $VT fetch      "<url>"    # metadata, chapters, captions
python3 $VT transcript "<url>"    # canonical timed transcript
```

Then read `transcript.json` and write the note. Comments and audio are **not**
needed for a digest — don't pass `--comments` or `--audio`, they're slow and only
`video-moments` uses them.

Check `source` in the transcript output before you start:

| `source` | What it means |
|---|---|
| `youtube-manual:*` | Human captions. Punctuated, reliable wording. Best case. |
| `youtube-auto:*` | ASR. No punctuation, no capitals, numbers unreliable. Flag aggressively. |
| `whisper-*` | Local ASR. Punctuated and usually better than YouTube's, still a guess on proper nouns. |

Use `chapters` from `src.info.json` as the note's skeleton when the video has them —
the author already did the segmentation, and it is nearly always better than yours.

## Modes

Detect from the content; the user can override. Schemas are in [modes.md](modes.md).

| Mode | For | Watch out for |
|---|---|---|
| `recipe` | cooking | Quantities shown on screen but never spoken — see below |
| `tutorial` | how-to, software walkthroughs | Exact commands, versions, settings, URLs |
| `sop` | a process to be repeated | Decision points and failure branches, not just the happy path |
| `podcast` | interviews, conversations | Who said what; don't merge two speakers into one view |
| `lecture` | teaching content | Definitions and the worked examples that anchor them |
| `meeting` | recorded calls | Decisions and owners, separated from discussion |

## Frames are not optional

The transcript-only weakness is **information that is shown but not said**. This is
not an edge case — it is where the important numbers live.

Instructional creators routinely put the real prescription on a card and say
"screenshot this". The spoken track is the loose version; the card is the spec. On a
real 5-minute fitness tutorial the narrator said "around three to four sets" while
the on-screen card said **X3-5 sets** — and the card is what the creator told viewers
to save. A captions-only digest captures the wrong number and has no idea. Same story
for discount codes, recipe cards, terminal commands, and settings panels.

**So: every `[not stated]` or `[unclear]` in your first pass is a trigger, not an
answer.** Before writing the file, resolve them:

```bash
python3 $VT fetch "<url>" --video

# Contact sheet first — one image, scans a whole segment cheaply
ffmpeg -ss <start> -to <end> -i <cache>/media.mp4 \
  -vf "fps=1,scale=440:-1,tile=6x7" -frames:v 1 -q:v 3 sheet.jpg

# Then a full-resolution frame only where the sheet shows something readable
ffmpeg -ss <t> -i <cache>/media.mp4 -frames:v 1 -q:v 2 -vf scale=1280:-1 frame.jpg
```

The contact sheet is the trick. A 6×7 tile at 1fps covers 42 seconds in a single
image, which is enough to *locate* on-screen text; then you spend one full-res frame
actually reading it. Scanning a whole promo segment this way costs two images.

Sweep the timestamps around each gap, not just the exact second — cards fade in and
build line by line, so the complete version is often several seconds after the
narration moved on.

Mark anything read from a frame as `[from screen at 3:42]`. When the card and the
narration disagree, **record both and say which is which** — the card usually wins,
but the reader deserves to know there was a conflict.

Skip frames only when the first pass has no unresolved flags at all. Downloading
video is the expensive step (~50 MB for 5 minutes), so batch every gap into one
fetch rather than going back repeatedly.

**Codec note:** always let `vt.py fetch --video` pick the format. YouTube serves AV1
as "best" and many ffmpeg builds — conda's 4.x included — have no AV1 decoder, which
fails with `Decoder (codec av1) not found`. `vt.py` forces H.264 for this reason.

## Output

Write a Markdown file. Match the repo's existing note convention if there is one;
otherwise ask where it should go, or default to the current directory.

Front-matter carries the provenance so the note is traceable later:

```yaml
---
title: <video title>
source: <url>
channel: <channel>
duration: 18m40s
transcript_source: youtube-auto:json3   # be honest about this
digested: 2026-08-23
mode: recipe
---
```

End every digest with a short **Confidence notes** section listing what was
unclear, what was inferred from frames, and what was never stated. Do not bury
this — it is the part that makes the rest trustworthy.

An entry there should mean "I looked and it genuinely isn't in the video", never
"I only read the captions". If you have not swept frames for it, you have not
established that it's missing.

Echo a condensed version to the terminal. Don't paste the whole note back; the user
has the file.

## Scope

This skill summarises. It does not find highlight moments (`video-moments`), render
clips, or post anything. If the user wants clips, hand off rather than improvising a
cut list here.

If the user's goal is to post the summary as a YouTube comment: draft it, hand it to
them, and let them post it themselves. Automated commenting is against YouTube's
spam policy and risks the account for no real gain.
