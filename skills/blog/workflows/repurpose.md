# /blog repurpose — distribution artefacts

Take a published post and produce the per-channel content needed to actually get readers: Twitter/X thread, LinkedIn long-form, Reddit submission, HN comment seed, YouTube short script, newsletter blurb, email outreach.

The posts that travel are the ones whose distribution has been thought about. This workflow makes that work explicit instead of an afterthought.

## Inputs

- `<post-path>` — required. The published or near-final article.
- `--channels <list>` — comma-separated subset of `twitter,linkedin,reddit,hn,youtube,newsletter,email`. Default: `twitter,linkedin` (most universally applicable).
- `--audience <name>` — if multiple audience segments exist in the strategy doc, target this one.
- `--mode collab|auto` — default `collab`.
- `--output-dir <path>` — where to write artefacts. Default `<post-dir>/distribution/`.

## Pre-flight

1. **Read the post.** Extract: title, slug, primary keyword, top 3 statistics, top 3 sections, conclusion, author byline, post URL (from frontmatter or ask the user).
2. **Read the active persona.** Distribution copy should match the persona's voice, just compressed.
3. **Read `references/distribution-channels.md`** for per-channel rules (character limits, tone shifts, etiquette).
4. **Detect the post's "spike"** — the single most quotable, sharable, or contrarian thing. Often it's:
   - The most surprising statistic.
   - The strongest claim ("we cut latency by 80% by removing a feature").
   - The visual ("here's the architecture diagram that kept us up for a week").
   - The reversal ("everyone says X; we tried it and it's wrong because Y").

The spike is the hook for every channel. If the post has no spike, repurpose will produce weak distribution copy — flag this back to the user and recommend re-reading the post for what it could lead with.

## Per-channel playbooks

### Twitter / X thread

Constraints: 280 chars per tweet, 5–9 tweets per thread is the sweet spot for engagement, no link in tweet 1 (algorithm penalty), link in the last tweet.

Structure:

1. **Hook tweet** — the spike, ≤ 240 chars (leave room for retweet quotes). No link, no thread emoji.
2. **Setup tweet** — one-sentence context. "Here's what we found and why it matters."
3. **3–6 body tweets** — one substantive point each, with a number or example. Bold beats bulleted.
4. **Closing tweet** — link to the post + a one-line CTA ("Full breakdown:") or single-question close.

Generate 2 variants of the hook tweet. Surface them side-by-side so the user picks.

Tone shift from the post: less hedging, more declarative. Persona dimension `enthusiastic_matter_of_fact` shifts ~0.1 toward `enthusiastic` for Twitter — the platform rewards confidence.

### LinkedIn

Constraints: 1300 chars before "see more" cutoff (so the first 200 words must hook), no clickable links in the first 3 lines (algorithm penalty), 3–5 hashtags at the end.

Structure:

1. **Opening line** — single short sentence with the spike. No emojis.
2. **2–3 paragraph body** — the post's core argument condensed. First-person, conversational.
3. **One question to drive comments** — "Curious if anyone's tried [the alternative approach]"
4. **Link** at the bottom in a P.S. line.
5. **Hashtags**: 3–5 industry-relevant. Avoid #motivation, #leadership, #growth — they're noise.

Tone shift: warmer than the post. LinkedIn rewards lived experience. Lean into "we" and "I" sentences. `formal_casual` shifts ~0.1 toward casual.

### Reddit

Reddit is hostile to self-promo. The submission must have value before the link.

Per-subreddit etiquette varies; default playbook for subreddits with strict self-promo rules (`/r/programming`, `/r/cybersecurity`, `/r/webdev`):

1. **Submission title** — declarative, specific, no clickbait. ≤ 100 chars. Include the contrarian or surprising angle if there is one.
2. **First comment** (the submitter posts this immediately after the link) — 200–400 words containing the post's argument in the user's own words, written for the subreddit's vocabulary. Disclose that you wrote the post: "Author here — happy to answer questions on the [topic] decision."
3. **Targeted subreddits** — suggest 1–2 (no more), based on the post's topic and the audience segment.

For permissive subreddits (`/r/sysadmin`, smaller niches), the title can be the post title and the first-comment seed can be shorter.

Tone shift: neutral, technical, no marketing voice. `funny_serious` shifts ~0.1 toward serious. Reddit smells corporate from a mile away.

### Hacker News

Only generate this if the post has working code, original benchmarks, a specific contrarian take, or a "we built X and learned Y" story. Otherwise it'll get downvoted and waste the submission slot.

1. **Title** — the post's title, lightly edited. Strip clickbait. HN prefers descriptive titles.
2. **Submission text** (only for `Show HN:` or `Ask HN:` style — most posts are link-only): 100–200 word framing, written in HN's plain technical register.

Tone shift: most neutral and technical of any channel. `funny_serious` to 0.85+. Hedge less, but support every claim.

### YouTube short

If the post has visual / demo-able content. Default to declining if it doesn't.

1. **60-second script** — voiceover lines numbered 1–8.
2. **Visual cue** for each line: B-roll suggestion, screenshot to overlay, etc.
3. **End-screen CTA** — link to the post in the description, plus one-line on-screen text.

Don't generate video. Just the script + cue list.

### Newsletter blurb

For an email newsletter (the user's own or one they're guesting in):

- **Subject line** — 50–60 chars.
- **3 sentences**: hook, payoff, link.
- **Optional**: a P.S. with a personal aside related to the post.

### Email outreach (cold)

If the user wants to email specific people about the post (e.g. researchers cited, peers in the space):

- **Subject** — specific, no clickbait. Reference one thing from the post.
- **Body** — ≤ 100 words, three sentences:
  1. Why I'm writing.
  2. What's in the post that they specifically would care about.
  3. Single low-friction CTA: "happy to chat about X if interesting" / "open to feedback if you spot anything off."

Don't bcc. Don't auto-attach. Don't follow up automatically.

## Output

For each channel selected, write a file:

```
<output-dir>/
├── twitter-thread.md
├── linkedin-post.md
├── reddit-/r-cybersecurity.md
├── hn-submission.md
├── youtube-short-script.md
├── newsletter-blurb.md
└── email-outreach.md
```

Each file has the artefact + a "publishing notes" section at the bottom (best time to post, what to monitor, expected lifecycle).

In `--mode collab`, surface a one-line summary per artefact and ask if the user wants to review any in detail.

## When NOT to use repurpose

- The post hasn't been audited / polished yet — distribute a weak post and you waste the channel's audience.
- The post has no spike — generate the spike first (rewrite to find one) before distributing.
- The post is internal (engineering notes, decision log) — don't repurpose internal-only content for public channels by default.
