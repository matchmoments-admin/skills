# Distribution channels — per-channel playbooks

Detailed mechanics, etiquette, and tone shifts for each distribution channel. Used by `repurpose` to generate channel-specific artefacts from a finished post.

The unifying principle: **every channel has an audience, an etiquette, and a posture.** A piece of content that works on Twitter is wrong on LinkedIn; a Reddit submission written like a LinkedIn post will get downvoted on sight. These aren't aesthetic preferences — they're the mechanics of how each channel's algorithm and community respond.

---

## X / Twitter

**Audience profile**: technical professionals, journalists, builders, hobbyists. Skews younger and more international than LinkedIn.

**Mechanical constraints**:

- 280 characters per tweet.
- Threads of 5–9 tweets perform best for technical content.
- **No link in tweet 1**: the algorithm penalises links in the first tweet of a thread (training signal: link-leading tweets are mostly spam). Put the link in the last tweet.
- Threads with media (image, GIF, chart) in tweet 1 get ~2x reach vs. text-only.
- Replies and quote-RTs drive much of the distribution; engagement in the first 30 minutes is critical.

**Tone shift**:

- More declarative than the post. Strip hedges.
- Persona's `enthusiastic_matter_of_fact` shifts ~0.1 toward enthusiastic.
- Specific numbers in tweet 1 outperform vague claims by a wide margin.

**Thread shape**:

1. **Hook** (≤ 240 chars to leave room for retweet quotes). The spike, framed as a single concrete claim. No emoji unless the persona calls for it.
2. **Setup** — one-sentence context. "Here's what we found and why it matters."
3. **3–6 body tweets** — one substantive point each, with a number, screenshot, or example.
4. **Close** — link to the post + one-line CTA: "Full breakdown:" or a single open question.

**Best times to post**:

- Weekdays 9am–11am AEST / 7am–9am PT for tech audiences.
- Avoid Friday afternoons (engagement drops sharply).

---

## LinkedIn

**Audience profile**: working professionals, recruiters, executives, B2B buyers. Older, less technical-deep on average.

**Mechanical constraints**:

- 1300 characters before "see more" cutoff. The first 200 words must hook.
- **Don't put clickable links in the first 3 lines**: the algorithm penalises (training signal: external-link spam).
- 3–5 hashtags at the end (more than 5 is noise).
- Native video and image carousels outperform link posts by ~3x.
- Engagement in the first 60–90 minutes drives all subsequent reach.

**Tone shift**:

- Warmer than the post. LinkedIn rewards lived experience and "I learned" framings.
- `formal_casual` shifts ~0.1 toward casual.
- Use "I" and "we" liberally. First-person beats third-person on LinkedIn by a wide margin.
- Avoid: management-consulting register, motivational platitudes, generic "leadership lessons".

**Post shape**:

1. **Opening line** — single short sentence with the spike. No emojis, no setup.
2. **2–3 paragraph body** — the post's core argument condensed. Lived experience, specific details.
3. **One question** to drive comments.
4. **P.S. with link** at the bottom (so it doesn't trip the algorithm).
5. **Hashtags** — 3–5 industry-relevant; avoid #motivation, #leadership, #growth (tropes).

**Best times to post**:

- Tue/Wed/Thu 8am–10am local time of the target audience.
- Avoid Mondays before 9am and weekends.

---

## Reddit

**Audience profile**: domain-deep, sceptical of self-promo, hostile to anything that smells like marketing.

**Mechanical constraints**:

- Each subreddit has its own self-promo rules. Always read the sidebar.
- Submissions with the "self-post" format (text + link in body) often outperform direct link submissions in technical subreddits.
- The first comment by the submitter (within 5 minutes) is critical — it's where you disclose authorship and add value beyond the headline.
- Most subreddits ban accounts that submit only their own links. Maintain a 9-to-1 ratio of comments-on-others'-content to your own submissions.

**Subreddit etiquette tiers**:

| Tier | Examples | Self-promo rule | Strategy |
| ---- | -------- | --------------- | -------- |
| Strict | /r/programming, /r/cybersecurity, /r/webdev | Outright ban on most self-promo | Only submit if the post genuinely meets the bar; first comment must add substantial value |
| Moderate | /r/sysadmin, /r/devops | Tolerated if rare and high-value | Disclose authorship, lead with technical content |
| Permissive | small niche subs (e.g. /r/sre, hobby-specific) | Welcomed if relevant | Direct submission OK |

**Tone shift**:

- Most neutral and technical of any channel. Strip first-person cheerleading.
- `funny_serious` shifts ~0.1 toward serious.
- Acknowledge limitations and tradeoffs prominently — Reddit rewards epistemic humility.

**Submission shape**:

1. **Title** — declarative, specific, no clickbait. ≤ 100 chars. If the post has a contrarian angle, lead with it.
2. **Body / first comment** (within 5 minutes of submission):
   - 200–400 words restating the post's argument in subreddit-appropriate vocabulary.
   - "Author here — happy to answer questions on the [topic] decision."
   - Anticipate the top critique and address it ("Yes, this approach has the X drawback; we mitigated it by Y").

**Best times to post**:

- Highly subreddit-dependent. /r/programming peaks at 8am-10am ET on weekdays.
- /r/cybersecurity peaks late morning ET.
- Use subreddit-specific tools (e.g. later.com / Reddit's own analytics) if running this regularly.

---

## Hacker News

**Audience profile**: technical, sceptical, hostile to marketing. Demanding on substance, forgiving on writing style.

**Mechanical constraints**:

- Front page entry typically requires 4–6 upvotes within 30–60 minutes of submission.
- "Show HN: " and "Ask HN: " prefixes have separate algorithms; use them when applicable.
- No images, no media — title + URL + (optional) submission text.
- Comments are the value; the link is the gateway. Strong content with weak comment-thread will drop off the front page.

**When to submit**:

- The post has working code, original benchmarks, a specific contrarian take, or a "we built X and learned Y" story. Otherwise it'll get downvoted.
- Avoid: pure marketing announcements, generic listicles, AI-citation-optimised content (HN sniffs this out).

**Tone shift**:

- Most plain-prose of any channel. No hedging, no marketing register.
- `funny_serious` to 0.85+. Hedge less, but support every claim.

**Submission shape**:

- **Title**: the post's title, lightly edited. Strip clickbait. HN prefers descriptive titles with the technical hook embedded.
- **Submission text** (only for "Show HN" / "Ask HN" / posts that benefit from framing): 100–200 words explaining the value, written in HN's plain technical register.

**Best times to post**:

- Weekday mornings 8am-10am PT (HN's peak audience is West Coast US).
- Avoid weekends — HN has weekend traffic but the algorithm favours Tue–Thu submissions.

**Etiquette**:

- Don't ask for upvotes. HN bans accounts for vote manipulation.
- Don't submit your own content more than ~once a month.
- Engage with comments — top-voted comments get the most reply visibility, so a substantive author reply early can drive thread growth.

---

## YouTube short

**Audience profile**: heterogeneous — depends on what your channel and the specific topic attract.

**When to make**:

- The post has visual / demo-able content (a UI, a chart, a code-running animation).
- The post's spike is short enough to land in 60 seconds.

**Mechanical constraints**:

- 60 seconds max for shorts.
- 9:16 aspect ratio.
- First 3 seconds must hook (algorithm watches for retention curves).
- Captions / on-screen text are critical — many viewers watch without sound.

**Script shape**:

- 8 voiceover lines numbered 1–8.
- Visual cue per line: B-roll suggestion, screenshot to overlay, on-screen text.
- End-screen CTA — link to the post in the description, plus one-line on-screen text.

This skill produces the script; video production happens elsewhere.

---

## Newsletter blurb

For an email newsletter (the user's own or one they're guesting in):

**Length**: 50–100 words plus subject + link.

**Shape**:

- **Subject line** — 50–60 chars. Concrete, no clickbait. Best: a single specific number or claim.
- **3 sentences**: hook, payoff, link.
- **Optional P.S.** with a personal aside related to the post.

**Tone shift**: warmer than the post. Newsletter readers opted in; you can be more conversational than on cold channels.

---

## Email outreach (cold)

For emailing specific people about the post (researchers cited, peers in the space, journalists who cover the topic):

**Mechanical constraints**:

- ≤ 100 words.
- No attachments. No tracking pixels (these get filtered).
- No "did you get my last email?" follow-ups within 7 days.
- Send from a real personal email address, not a marketing-automation domain.

**Shape**:

- **Subject** — specific, references one thing from the post. ≤ 60 chars.
- **Body** — three sentences:
  1. Why I'm writing (the connection to the recipient).
  2. What's in the post that they specifically would care about.
  3. Single low-friction CTA: "happy to chat about X if interesting" / "open to feedback if you spot anything off."

**Don't**:

- BCC mass lists.
- Follow up automatically.
- Ask for a share or a backlink in the first email; ask for a conversation.

---

## Cross-channel sequencing

A typical launch sequence for a substantive post:

1. **T+0**: Publish the post. Verify schema, links, images.
2. **T+15min**: Twitter thread. Pin to profile.
3. **T+30min**: LinkedIn post.
4. **T+1h**: Newsletter (if you have one).
5. **T+2h**: Hacker News (only if it's a Show HN / strong contrarian / original-data post).
6. **T+1d**: Reddit (one targeted subreddit, with a strong first-comment seed).
7. **T+2-7d**: Email outreach to 5–10 named individuals (only if there's a specific reason each cares).

Don't compress this into one hour. The channels have overlapping audiences, and posting everywhere simultaneously trains your followers that you're spamming. Spreading over a day or two reaches different time zones and reads as more deliberate.

## What gets skipped

If the post:

- Doesn't have a spike → don't repurpose. Rewrite to find one.
- Is internal-only / engineering notes → only repurpose to internal channels.
- Is announcement-shaped and boring → small Twitter post + LinkedIn, skip everything else.

The cost of a weak distribution attempt isn't zero; it spends a slot in your followers' attention on something that doesn't reward them.
