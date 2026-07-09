# Blog skill — improvements plan

Working notes for the next pass on `~/.claude/skills/blog/`. Synthesised from
`github.com/maun11/claude-blog-engine` and Aaron Held's Hugo+Claude workflow,
filtered against this skill's actual purpose.

## Framing

This skill is an **authoring assistant for narrative content** — engineering
deep-dives, consumer scam explainers, regulatory analysis, founder-voice B2B
pieces. It optimises for "ship one piece I'd put my name on."

`claude-blog-engine` is a different tool — a **content-marketing factory for
B2B SaaS** optimised for "ship 10 keyword-targeted posts/week" against
DataForSEO-driven keyword universes.

Both are legitimate. The right move is to borrow **engineering patterns**
(deterministic scripts, parallel research, schema generation, packaging
hygiene) without borrowing **strategy patterns** (keyword universe
construction, funnel scoring, weekly cadence, paid-API lock-in).

## Changes — by priority

### HIGH

#### H1. Replace LLM-estimated audit metrics with a deterministic Python script

**Files:**
- New: `~/.claude/skills/blog/scripts/audit_metrics.py`
- Edit: `workflows/audit.md`, `workflows/write.md` (Pass 3 burstiness check, Pass 4 self-audit)

**Why:** `audit.md` currently asks the LLM to compute burstiness std-dev,
type-token ratio, AI-phrase density, paragraph-length distribution,
contraction frequency. LLMs ballpark these; they don't measure them. The
scoring rubric weights are fine-grained (≥6 → 6 pts, 4–6 → 3 pts, <4 → 0 pts)
so estimation error directly distorts scores.

**Script contract:**
- Input: path to a markdown/MDX/HTML file
- Output: JSON to stdout with `{burstiness, type_token_ratio, ai_phrase_hits, paragraph_lengths, contraction_freq, sentence_length_mean, sentence_length_std, reading_grade}`
- Reads `references/ai-phrase-scrubber.json` for the AI-phrase list
- Pure stdlib + pinned `textstat` for Flesch-Kincaid

**Audit changes:** every metric-based score line in `audit.md` becomes "shell
out to `audit_metrics.py`, read the JSON, compare to thresholds." LLM still
does the qualitative parts (E-E-A-T markers, signature-move presence, voice
fit narrative).

**Acceptance:** running audit twice on the same file returns identical
scores. Currently it doesn't.

---

#### H2. Reframe the "constrained product plug" rule for this content mix

**Files:** `workflows/write.md` (Pass 2), `workflows/audit.md` (new check),
`personas/askarthur-house.md` (do/dont addition)

**Why:** The repo's rule (one product mention, after pain established) only
fits B2B SaaS posts. Consumer/regulatory content has no product to plug; the
founder voice IS the credibility. Importing literally would be wrong.

**Reframed rule:**
- **Consumer/regulatory posts** (uses `troy-hunt` or `krebs-investigative`
  persona, OR matches `references/askarthur-consumer-explainer.md` template):
  zero commercial CTA. Closing should be reader-action ("if this happened to
  you, here's the report-it link") not platform-promo.
- **B2B/founder-voice posts** (uses `askarthur-house` or `patio11-deep-dive`
  persona): max one product mention, placed after the pain section
  establishes why the reader needs the solution. The "if you want to talk
  about X, here's how" close from the existing `askarthur-house`
  signature_moves already encodes this — make it a hard rule, not a soft
  suggestion.
- **Engineering deep-dives**: no product plug at all unless the post IS the
  product launch (then use the `announcement` template, which has different
  rules).

**Audit check:** count product/CTA mentions. Flag if commercial-tier persona
+ >1 mention OR mention before the first "pain" / "problem" / "what went
wrong" section.

**Acceptance:** the rule reads as natural for AskArthur's actual content,
not as a SaaS retrofit.

---

#### H3. Schema generation as a separate post-write pass

**Files:** `workflows/write.md` (new Pass 5)

**Why:** AI-citation odds rise meaningfully when both `BlogPosting` and
`FAQPage` JSON-LD ship with the post. The audit gives 4 pts for FAQ schema +
3 pts for Article schema (15 pts total in Technical Elements category), but
`write.md` doesn't currently produce them — only checks for them.

**Pass 5 contract:**
- Input: the finished article markdown + persona + brief metadata (title,
  slug, author, published date)
- Output: `schema.json` next to the article, containing both `BlogPosting`
  and `FAQPage` JSON-LD objects
- FAQPage is built from the article's existing FAQ section (Pass 3 step 6
  already produces this); if no FAQ section, skip FAQPage and note it
- BlogPosting includes `headline`, `author`, `datePublished`, `dateModified`,
  `description` (the meta description from Pass 3 step 7), `keywords` (from
  the brief or outline), `articleSection`

**Acceptance:** every `/blog write` invocation produces `schema.json`
alongside the article unless `--no-schema` is passed.

---

### MEDIUM

#### M1. `--output-mode folder` for CMS-ready handoff

**Files:** `workflows/write.md`

Single .md works for `apps/web/app/blog/`, but a folder layout
(`<slug>/article.md`, `<slug>/schema.json`, `<slug>/meta.json`,
`<slug>/images/`) is cleaner for non-Next CMSes (Ghost, WordPress, Hashnode)
or multi-channel distribution.

- `--output-mode single` (default — current behaviour): one .md file
- `--output-mode folder`: directory with article.md + schema.json +
  meta.json + images/ subdir
- `meta.json`: `{title, slug, meta_description, primary_keyword, persona,
  published_at, audit_score}`

---

#### M2. Parallel multi-source research in `brief.md`

**Files:** `workflows/brief.md` (Step 7 — Statistics-finding)

Currently statistics-finding runs sequentially per H2. The repo runs SERP
top-3 + Tavily + YouTube in parallel for one keyword. Same shape works with
WebSearch + top-3 WebFetch + (optional) YouTube transcript fetches, no paid
APIs needed.

- One parallel batch per H2 section (or one batch for the whole post if
  `--depth quick`):
  - WebSearch for the H2's topic + year qualifier
  - WebFetch on the top 3 results
  - Optional: WebSearch for `<topic> youtube` and fetch one transcript
- Results land in `<H2-slug>-research.md` under `<output-dir>/research/`
- Drafting reads from the scratch files instead of doing live research

---

#### M3. New `/blog hub` overview command

**Files:** New `workflows/hub.md`

Skill produces a lot of artifacts per project (plans, briefs, outlines,
drafts, `.audit.md` reports, `distribution/` folders). After 5+ posts,
"what's queued, what's drafted, what's audited but not shipped, what's the
latest score" becomes the bottleneck.

- Scans cwd (or `--dir`) for `blog-plan-*.md`, `outline-*.md`, `brief-*.md`,
  drafts in the project's blog dir, `*.audit.md`, `distribution/` folders
- Renders single-screen table: per slug, show stage
  (planned/briefed/drafted/audited/shipped), last-modified, audit score if
  present, distribution coverage
- Suggests next action: "3 drafts have audit < 70 — run `/blog rewrite` on
  each. 1 post is shipped without distribution — run `/blog repurpose`."

---

### LOW

#### L1. Standardise frontmatter on every workflow

All 8 `workflows/*.md` get `description:`, `argument-hint:`, `allowed-tools:`
frontmatter. Surfaces in Claude Code's slash-command picker; `allowed-tools`
is a real safety property (`audit.md` doesn't need Write outside its report
path).

#### L2. Optional funnel-stage reference for B2B posts

New `references/funnel-stages.md`, gated additions to `plan.md` and
`audit.md` behind a `--funnel-aware` flag. TOFU/MOFU/BOFU definitions, CTA
conventions per stage. Useful for B2B-targeted posts (SPF pillar,
founder-voice for telco buyers); irrelevant for consumer/regulatory content.

---

### DROPPED

| Original proposal | Why dropped |
|---|---|
| `/blog onboard` workflow | The repo's onboarding is a SaaS business-profile builder, not voice extraction. `persona create` does voice better (interactive, NNGroup-dimensional). |
| `claude-blog-engine-style` persona | That voice exists to optimise SERP CTR, not to express a perspective. Would dilute what makes existing personas useful. |
| TaskCreate suggestions in plan/brief Step 1 | Cosmetic. |
| `references/model-allocation.md` | Claude Code currently runs one model per session. Hint would be advisory at best. |
| New "content-aware image prompts" workflow | `gemini-diagram-illustration` skill already does this in spirit. Just add a one-line cross-skill hint to `write.md`. |

---

## Preserve deliberately

- **Persona system with measurable drift** (sentence-length distribution,
  contraction frequency, reading grade, do/don't/forbidden phrases). Neither
  reference has anything comparable.
- **5-category 100-pt audit + diff-style rewrite loop.** Unique to this
  skill. H1 strengthens it without changing shape.
- **`repurpose.md` per-channel playbooks.** This skill is the only one of
  the three that takes distribution seriously.
- **`references/askarthur-consumer-explainer.md` as a locked structural
  exemplar.** Don't let an SEO retrofit dilute it.
- **No paid-API hard dependencies.** WebSearch + WebFetch + Claude is enough
  for ~95% of what this skill does. Resist any change that would lock to
  DataForSEO, Tavily, Firecrawl, or DALL-E. **Why:** AskArthur's whole
  user-facing pipeline runs at ~$0.005/scan on Haiku 4.5 (verified from
  `cost_telemetry`, 2026-05). DataForSEO at ~$0.05/SERP query × multiple
  queries per post would 10–50× the marginal research cost for marginal
  authoring benefit.

---

## Phasing

| Phase | Scope | Effort | When |
|---|---|---|---|
| **1 — reliability** | H1 + H2 + H3 | ~2–3 hours, mostly the Python helper | Next time in the skill repo |
| **2 — workflow ergonomics** | M1 + M2 + M3 | ~2 hours | After 5+ posts shipped and artifact-tracking pain is real |
| **3 — polish** | L1 + L2 | 30 min | Bored, or right before sharing the skill |
| **Skip** | Dropped items | — | — |
