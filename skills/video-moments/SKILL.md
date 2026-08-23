---
name: video-moments
description: Find and rank the highlight moments in a video — the clippable bits of a podcast, talk or stream — and emit a moments.json with timestamps, scores and drafted hooks. Use when the user wants viral moments, clip candidates, the best bits, chapter highlights, or a shortlist of what to cut from a long video.
---

# Video moments

Long video in, a ranked shortlist of self-contained moments out, as `moments.json`.

**`moments.json` is the contract.** Clip rendering, social copy, a newsletter, a
LinkedIn post — everything downstream consumes this one file. Getting it right is
most of the value; everything after it is plumbing.

Depends on [video-toolkit](../video-toolkit/SKILL.md). Read its contract first.

## Before anything: whose video is it?

Ask if it isn't obvious, and record the answer in the output.

**This skill is built for content the user owns or has permission to use.** That is
a deliberate scope decision, not caution for its own sake:

- Republishing clips of someone else's video is a copyright-strike risk, and three
  strikes in 90 days terminates a channel.
- YouTube's reused-content policy makes unedited clips of others' work ineligible
  for monetisation regardless.
- A Short over 60 seconds carrying a Content ID claim is blocked globally — it won't
  play at all.

Finding moments in someone else's video for **private** purposes — research, notes,
studying what worked, drafting a comment — is fine, and this skill will do it. Set
`"rights": "third-party"` in the output and say plainly that the clips are not
publishable. Don't refuse the analysis; do refuse to pretend it's publishable.

## Flow

```bash
VT=~/.claude/skills/video-toolkit/scripts/vt.py
python3 $VT fetch      "<url>" --comments     # comments are a strong signal — worth the wait
python3 $VT transcript "<url>"
python3 $VT signals    "<url>"
python3 $VT candidates "<url>" --count 15
```

Add `--audio` to the fetch when ffmpeg is available; it unlocks the energy signal,
which is the best laughter and applause detector you have. Skip it if ffmpeg isn't
installed — the pipeline degrades rather than fails.

`candidates` gives you a **shortlist, not a ranking you can ship**. It knows where
attention went. It has no idea whether the content is any good, whether the clip
opens mid-sentence, or whether it's a sponsor read. That's your job.

## Then do the work the signals can't

### 1. Fix the boundaries

Most shortlisted windows open mid-thought. Each candidate carries `context_before`,
`context_after`, `breaks_near_start` and `breaks_near_end` precisely so you can fix
this without re-reading the transcript.

For every candidate you keep:

- Read `context_before`. If the clip's first sentence started earlier, move `start`
  back to a break from `breaks_near_start`.
- Read `context_after`. If the point lands a beat later, extend `end`.
- **Only ever move an edge to a value present in the breaks arrays.** Inventing a
  timestamp puts the cut mid-word, which is the most audible defect there is.
- Re-check the length budget after moving.

A clip must work for someone who joined at second zero. If fixing the opener would
need 40 seconds of setup, the moment isn't clippable — drop it and say why.

### 2. Score on the rubric

Score each surviving candidate on the seven dimensions in [scoring.md](scoring.md):
hook, self-containment, payoff, quotability, tension, emotional charge, actionability.

Do this as a **structured pass over all candidates at once**, not one at a time —
the scores are only meaningful relative to each other.

### 3. Re-rank, combining signal with judgement

The fused signal score and your rubric score measure different things and both
matter. Signal says "people came back to this". Rubric says "this works as a
standalone clip". A moment strong on both is the real find; strong on signal alone
is usually an intro or a chapter marker; strong on rubric alone is a guess.

Weight them roughly evenly, and **say when they disagree** — that disagreement is
information, not noise.

### 4. Draft the hook and title

For each kept moment write a hook line (the first three seconds, which is what
decides whether anyone watches) and a working title. Keep them factual — a hook that
oversells is how a clip gets ratioed.

## Output

Write `moments.json` next to wherever the user is working (or to the cache dir if
they haven't said). Structure:

```jsonc
{
  "source": { "url": "…", "title": "…", "channel": "…", "duration": 18900 },
  "rights": "owned",              // owned | licensed | third-party
  "generated": "2026-08-23",
  "signals_available": ["comments", "density", "heatmap"],
  "confidence": "medium",         // see below
  "moments": [
    {
      "rank": 1,
      "start": 9764.9,            // must be a value from breaks
      "end":   9812.4,
      "duration": 47.5,
      "chapter": "Amanda Askell - Philosophy",
      "signal_score": 0.31,       // from candidates.json
      "rubric":  { "hook": 4, "self_contained": 5, "payoff": 4,
                   "quotable": 3, "tension": 2, "emotion": 2, "actionable": 4 },
      "rubric_score": 3.4,
      "final_score": 0.78,
      "why": "One-sentence reason this works as a clip.",
      "hook": "Drafted first line.",
      "title": "Working title.",
      "transcript": "…",
      "boundary_moved": true,     // did you move an edge from the candidate?
      "flags": []                 // e.g. "needs_context", "names_a_person", "boilerplate"
    }
  ],
  "rejected": [
    { "start": 174.0, "reason": "sponsor read" }
  ]
}
```

Keep `rejected` with reasons. It's how the ranking gets better later, and it stops
the next run rediscovering the same junk.

## Say how confident you actually are

Set `confidence` honestly and explain it in your reply:

| | When |
|---|---|
| **high** | heatmap present, comments present, >100k views — you have real revealed engagement |
| **medium** | one strong signal missing, or a modest view count |
| **low** | no heatmap (new video, low views, unlisted, or the user's own upload) — the ranking is essentially the rubric alone, which is a prediction, not evidence |

**Low confidence is the normal case for the user's own new uploads**, which is
exactly the case this skill is built for. Don't dress a rubric score up as data. Say
"no heatmap yet on this video, so this is my judgement rather than your audience's",
and suggest re-running once it has views.

## Scope

Finds and ranks. Does **not** render clips, write platform captions, or post
anything. Hand `moments.json` to whatever does that.

If the user wants copy for a specific platform from these moments, that's a
different job — the `linkedin-writing` skill takes a moment pack happily.
