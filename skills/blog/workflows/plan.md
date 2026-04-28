# /blog plan — strategy & positioning

Build a strategy doc for one or more blog posts: who reads them, what intent they serve, where the AI-citation gaps are, and how each post fits into a topic-cluster architecture. Run this **before** any drafting if the user is starting on a new content area or revisiting positioning.

## Inputs

- `<topic>` (free-form) — the area the user wants to cover. Could be a single post (`"how we cut latency"`) or a content area (`"phone scams in Australia"`).
- `--audience <name>` — optional; if given, skip step 2.
- `--cluster <name>` — optional; if given, the new content is positioned within an existing cluster instead of starting one.
- `--mode collab|auto` — default `collab`.

## Workflow

### 1. Discovery

If the user has a project in the cwd, scan for context first:

- `CLAUDE.md` for product / domain / positioning hints.
- `package.json` / `pyproject.toml` for tech stack signals.
- Existing blog directory (`docs/blog`, `content/`, `_posts/`, `apps/web/app/blog`, etc.) — read any existing posts for voice and topic coverage.
- If a `blog.config.json` exists at the project root, load it (fields: `topic_pillars`, `audience`, `competitors`, `cta_targets`, `forbidden_phrases`).

Print a one-line summary of what you found. Then ask the user (collab) or assume sensible defaults (auto) for anything missing:

- What problem does this content solve for the reader?
- Who is the reader? (role, experience level, what they already know)
- What's the publishing cadence — one-off post, monthly series, weekly cluster?
- What's the goal — traffic, leads, AI-citation visibility, recruiting, authority?

### 2. Audience mapping

Define **at most 3** audience segments. Two is usually plenty for a single blog. Each segment needs:

```
### Audience: <name>
- **Role**: ...
- **Experience level**: beginner | mid | senior | expert
- **What they already know**: ...
- **What they want from this content**: ...
- **What they search for**: 3–5 example queries
- **Where they hang out**: HN, lobste.rs, /r/sre, /r/cybersecurity, LinkedIn, X, etc.
- **Trust signals that matter**: code snippets, named sources, post-mortems, public dashboards, …
```

The "where they hang out" line drives `repurpose` later — if they're on HN, distribution writes a Show HN-flavoured comment seed; if they're on LinkedIn, distribution writes a long-form LinkedIn post. Don't list more than 2–3 channels per segment; long lists dilute the plan.

### 3. Search-intent + AI-citation map

For each priority topic the user named, list:

```
### Topic: <topic>
- **Primary keyword**: <exact-match target>
- **Search intent**: informational | commercial | transactional | navigational
- **Top 3 ranking pages** (use WebSearch): URL + a one-line summary of each
- **Common gap across all 3**: what they all miss
- **AI-citation status** (use WebSearch on perplexity.ai-formatted queries when possible):
  - ChatGPT: who's cited, if anyone
  - Perplexity: who's cited
  - Google AI Overview: who's cited
  - Gap?: yes/no
```

The AI-citation gap is the single most valuable signal in this stage. If no competitor is cited for a keyword the user's audience asks AI assistants about, that's a bookable opportunity. Aim to identify **2–4 such gaps** before moving on.

Reference doc to load if you need depth on AI-citation tactics: `~/.claude/skills/blog/references/ai-citation-playbook.md`.

### 4. Topic-cluster architecture (if multi-post)

If the user wants more than one post, sketch a hub-and-spoke:

```
HUB (pillar page, 3000+ words): <broad keyword>
├── SPOKE 1: <specific subtopic>     (1500–2000 words)
├── SPOKE 2: <specific subtopic>
├── SPOKE 3: <specific subtopic>
├── SPOKE 4: <specific subtopic>     ← AI-citation gap target
└── SPOKE 5: <specific subtopic>
```

Pillar links to all spokes; spokes link to the pillar and to siblings. **5–8 spokes per cluster** is the sweet spot — fewer and you don't establish topical authority; more and the maintenance overhead defeats the purpose.

If `--cluster <name>` was passed, position the new post(s) as additional spokes under an existing pillar instead of building a new cluster.

### 5. Differentiation

For each planned post, name **one specific thing** that no competitor has. This is the post's reason to exist. Generic options:

- **First-hand experience** — "we ran X in production for 18 months and here's what broke"
- **Original data** — "we analysed N of our own records and found Y"
- **Counterintuitive take** — "everyone says X; we tried it and X is wrong because Y"
- **Synthesis** — "the X literature is fragmented; here's the unified view"
- **Tooling** — "here's the open-source script we used to run this analysis"

If you can't name a differentiator, the post should not exist. Tell the user.

### 6. Output

Write the strategy doc to `<output>/blog-plan-<slug>.md` (default `<cwd>/blog-plan-<topic-slug>.md`). The file should be readable on its own — a colleague should be able to pick up just this doc and write the posts.

In `--mode collab`, surface the doc and ask:

> "Plan written to <path>. Want to run `/blog brief <topic>` for one of these posts now? (suggest the highest-leverage one — the AI-citation gap with the strongest differentiation.)"

In `--mode auto`, just print the path and exit.

### 7. Persona suggestion

At the bottom of the plan doc, recommend 1–2 personas from `~/.claude/skills/blog/personas/` that match the audience + intent combination. Heuristics:

- Senior engineers, deep technical content, opinionated → `patio11-deep-dive` or `dan-luu-analysis`
- Security / pragmatic / data-rich / accessible → `troy-hunt`
- "How we built X" engineering retrospective → `cloudflare-engineering`
- Investigative reporting on an external event → `krebs-investigative`
- Mix of audiences / unsure → recommend the user fork `house-template` and define their own

Don't auto-set the active persona from `plan` — that's `/blog persona use <name>`'s job, and it should be a deliberate choice.
