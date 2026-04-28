# /blog brief — full content brief

Heavier than `outline`: produce a doc that contains everything the writer needs to draft without further research — keyword set, competitive analysis, statistics already sourced (with citations), heading structure, FAQ targets, internal-linking plan, distribution plan, persona pick.

A brief is the right artifact when you're delegating drafting (to another writer or to the same agent in a separate session) or when the topic is research-heavy enough that gathering data and drafting in one pass would blow the context window.

## Inputs

- `<topic>` — required.
- Same flags as `outline` plus:
  - `--depth quick|standard|deep` — default `standard`. `quick` skips per-section statistic gathering; `deep` runs WebFetch on every top-10 SERP result instead of just the top 3.
  - `--no-distribution` — skip the distribution-plan section.

## Workflow

### 1–4: same as `outline`

Reuse `outline.md` steps 1–4 for topic / intent / template / SERP analysis, then continue.

### 5. Keyword research

Using WebSearch:

- **Primary keyword**: exact match target.
- **Secondary keywords**: 3–5 related terms that should appear naturally in the post.
- **Question queries**: 3–5 People-Also-Ask-style questions. These become the FAQ section.
- **AI-citation queries**: 2–4 phrasings a user might type into ChatGPT / Perplexity. These shape the answer-first formatting and citation capsules.

### 6. Competitive analysis

For each of the top 3 SERP results, compile:

- Word count.
- Heading structure (full, not just snippets — WebFetch if needed).
- Visual elements: images, charts, videos, tables, code blocks.
- Author info: byline? bio? credentials?
- Schema usage: visible schema.org markup? FAQ schema?
- External citations: how many tier-1 sources (academic, government, primary)?
- Tone: formal, conversational, expert, beginner-friendly?
- **Gap**: one specific thing missing that we'll add.

Roll up into a comparison table.

### 7. Statistics-finding (the differentiator)

For each H2 section in the outline, find **1–3 specific statistics** with full provenance:

```
- Statistic: <number + claim>
- Source: <name + URL>
- Date: <year, ideally within last 24 months>
- Methodology: <one sentence — survey of N, dataset of N records, government registry, …>
- Tier: 1 (academic / government / primary) | 2 (major media / industry-standard reports) | 3 (vendor research / blog with disclosed methodology)
```

Aim for **8–12 sourced statistics across the post**. Tier 1+2 only if possible; tier 3 fine if marked as such. **Never invent statistics**, and never cite a number without naming the source — both are E-E-A-T poison and AI-citation poison.

If `--depth quick`, find 4–6 instead of 8–12.

If the user has original data of their own (logs, dashboards, customer base) that's relevant, flag in the brief which statistics it could replace — original first-party data is the strongest E-E-A-T signal there is.

### 8. Internal linking plan

Scan the project's blog directory (`docs/blog/`, `content/blog/`, etc.) for related existing posts. For each H2, suggest:

- One **inbound link** target (a related existing post that should link to this new one).
- Up to two **outbound link** targets (related existing posts this new post should link to).

If there are no existing posts (greenfield blog), note that and suggest a pillar page to build first.

Reference doc to load if needed: `~/.claude/skills/blog/references/internal-linking.md`.

### 9. Distribution plan (skip with `--no-distribution`)

For each audience segment from the active strategy doc (or inferred from the topic), draft seed content for the channels that segment uses:

- **X / Twitter thread** — 5–7 tweets, hook tweet first.
- **LinkedIn post** — 1 long-form (~250 words) angled to professionals.
- **HN Show / Ask seed** — title + one-paragraph submission text, only if the post has working code or original data.
- **Reddit angle** — subreddit + first-comment seed (Reddit hates self-promo; the post must lead with value).
- **YouTube short script** — 60-second cut-down if the topic is visual or demo-able.
- **Newsletter blurb** — 3 sentences for an email send.

Don't write the final copy yet — that's `repurpose`'s job. The brief just lists which channels are in scope and what angle each takes.

Reference doc: `~/.claude/skills/blog/references/distribution-channels.md`.

### 10. Output

Write the brief to `<output-dir>/brief-<slug>.md` (default `<cwd>/brief-<slug>.md`).

The brief should be **self-contained** — a writer should be able to open just the brief and produce a draft without going back to the user for more info.

In `--mode collab`, ask:

> "Brief written to <path>. Run `/blog write <path>` now? (recommended.) Or do you want to review the brief and tweak it first?"

If `--mode auto`, also run `/blog write <path>` immediately and chain through.
