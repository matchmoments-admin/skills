# /blog write — draft an article

Produce a finished draft from a topic, an outline, or a brief, using the active persona and the chosen template. This is the workflow that ties together every other reference doc in the skill.

## Inputs

- `<topic-or-path>` — required. If a path to an `outline-*.md` or `brief-*.md` exists, load it. Otherwise treat as a free-form topic and run `outline.md` first to scaffold.
- `--persona <name>` — override the active persona for this call only.
- `--template <type>` — force a template (`deep-dive`, `post-mortem`, `how-to`, `comparison`, `incident-report`, `announcement`).
- `--target-words <n>` — override the brief/outline target.
- `--format markdown|mdx|html` — default: auto-detect from project (look for `.mdx` files in the blog dir; default markdown).
- `--no-schema` — skip Pass 5 (don't emit `schema.json`). Default: emit.
- `--mode collab|auto` — default `collab`.

## Pre-flight

1. **Load active persona.** Read `~/.claude/skills/blog/.active-persona`. If unset or `--persona` was passed, use that. Read `personas/<name>.md` and parse the YAML frontmatter into a constraints object: `tone`, `writing.*`, `do[]`, `dont[]`, `signature_moves[]`, `forbidden_phrases[]`.

2. **Load template.** Decide template per `outline.md` step 2 if not given. Read `templates/<type>.md` for section structure and length targets.

3. **Load references.** Always load:
   - `references/ai-phrase-scrubber.json` — banned phrases (treated as a *hard constraint*: never emit any of these).
   - `references/eeat-signals.md` — markers to weave into the post.
   - `references/internal-linking.md` — rules for the linking pass.
   - `references/quality-scoring.md` — so you know what `audit` will measure later.

4. **Load brief / outline** if a path was passed. Otherwise run `/blog outline <topic>` inline to produce one before drafting.

## Drafting passes

A draft is built in **three passes**, each with a specific quality gate. Don't try to do everything in one shot — the LLM reflex is to write a generic answer-shaped paragraph; the multi-pass structure beats that out.

### Pass 1 — Skeleton + statistics

Write the H2/H3 structure exactly as the outline specifies, but for each section:

- Write **only** the answer-first opening sentence (the stat or fact that opens the section).
- Then write the section as a bulleted list of points to expand, with each statistic referenced by `[STAT-N]` where N is the index from the brief.

Result: a short doc that looks like a strong outline with the data already placed.

In `--mode collab`, surface this and ask: "Skeleton looks right? (y / edit X)". This is the cheapest place to course-correct.

### Pass 2 — Prose, persona-constrained

Expand each section into prose. While drafting, hold these constraints in mind from the persona:

- **Sentence-length distribution**: aim for mean ± std-dev as declared. Vary sentence length deliberately — short sentences for emphasis, long for context. AI prose famously lands in a narrow band; intentionally writing a 5-word sentence next to a 35-word one is the simplest counter.
- **Vocabulary tier**: don't reach above the tier (no "obviate" in a consumer-tier post). Don't dumb below it either — readers feel patronised.
- **Contractions**: hit the declared frequency. If `contraction_frequency: 0.6`, ~60% of contractible verb pairs use the contraction. If `0.0`, none.
- **Passive-voice cap**: keep below the declared max %.
- **Do's and don'ts**: each section should hit at least one "do" pattern. Re-read each paragraph and check it doesn't violate any "don't".
- **Signature moves**: try to place at least 2–3 of the persona's signature moves across the post. They're what distinguishes one persona from another.
- **Forbidden phrases**: never emit any phrase in the persona's `forbidden_phrases[]` or in `references/ai-phrase-scrubber.json`. If a banned phrase is the natural choice, find a different way.
- **Commercial discipline**: scope by post class.
  - **Consumer / regulatory** (persona is `troy-hunt` or `krebs-investigative`, OR the post matches `references/askarthur-consumer-explainer.md` template): **zero commercial CTA**. Close with reader-action ("if this happened to you, here's the report-it link"; "here are the three checks to make tonight"), not platform-promo.
  - **B2B / founder-voice** (persona is `askarthur-house`, `patio11-deep-dive`, `cloudflare-engineering`): **at most one product mention**, placed *after* the post's pain section establishes why the reader needs the solution. The "if you want to talk about X, here's how" close from `askarthur-house` signature_moves is the canonical shape — never a marketing CTA.
  - **Engineering deep-dive without commercial intent**: zero product mention unless the post IS the launch (then use the `announcement` template instead, which has its own rules).

Statistics from pass 1 (`[STAT-N]`) get expanded with full source citations: `According to <source name>'s <year> report, <claim>` — followed by a footnote-style or inline link to the source URL.

### Pass 3 — Polish

In order:

1. **AI-phrase scrub.** Search the draft for every entry in `references/ai-phrase-scrubber.json`. Replace each with the suggested replacement (or rewrite the sentence if the replacement doesn't fit). This step alone eliminates most of the "GPT smell." Verify by running the metrics script (see step 2) and checking `ai_phrase_hits == 0`.

2. **Run the metrics script** (this powers the next two checks and Pass 4):

   ```bash
   python3 ~/.claude/skills/blog/scripts/audit_metrics.py <draft-path> --persona <active-persona>
   ```

   Parse the JSON. Use the values verbatim — do not re-estimate.

3. **Burstiness check.** From the JSON: `burstiness` (= sentence-length std-dev). Target ≥ 6. If below, rewrite the most uniform paragraph (the longest run of similar-length sentences) with one short jab and one long context sentence, then re-run the script to confirm.

4. **Reading-grade check.** From the JSON: `reading_grade` (Flesch-Kincaid). Verify it's within the persona's `reading_grade_target` range. Adjust vocabulary up or down if not.

5. **E-E-A-T pass.** From `references/eeat-signals.md`, add at minimum:
   - One **first-person experience** sentence ("we ran this in production for…", "the first time we tried…").
   - One **named source** for every quantitative claim (no orphan numbers).
   - One **author byline** at the top with credentials relevant to the topic.
   - For technical posts: at least one **code snippet** the reader could copy-paste.
   - For data posts: at least one **chart** (Mermaid, ASCII, or generated SVG via the diagram skills).

6. **Internal linking.** Per `references/internal-linking.md`: weave 3–6 internal links into the body, with descriptive anchor text (never "click here" or "read more"). For greenfield blogs, skip and note it.

7. **FAQ schema.** If the template specifies a FAQ section, write 3–5 Q&A pairs. Format as:
   ```html
   <FAQPage> ... </FAQPage>  <!-- if HTML/MDX with schema component -->
   ```
   Or as a plain markdown FAQ section with a comment indicating schema should be applied at render time. AI-citation odds increase ~20% when FAQ schema is present.

8. **Title + meta description.** Three title candidates (40–60 chars, front-loaded keyword). One meta description (150–160 chars, includes primary keyword). One slug (kebab-case, ≤ 5 words).

9. **TL;DR / Key Takeaways.** Per the active persona's preference (some skip this, some do it as a "Key Takeaways" callout at the top, some do a "Summary" sentence at the bottom). Default to a 3-bullet "Key Takeaways" box right after the intro — it's the single most-cited element by AI assistants.

### Pass 4 — Self-audit

Re-run the metrics script (it's already invoked in Pass 3 step 2 — re-run only if Pass 3 changed the draft):

```bash
python3 ~/.claude/skills/blog/scripts/audit_metrics.py <draft-path> --persona <active-persona>
```

Check each gate against the JSON. Numbers from the script; LLM judgment only for the qualitative bullets.

- `ai_phrase_hits == 0` ✅
- `burstiness >= 6` ✅
- `forbidden_phrase_hits == 0` ✅
- Persona drift acceptable: `|sentence_length_mean - persona.writing.sentence_length_mean| <= 2` AND `sentence_length_std >= 0.7 × persona.writing.sentence_length_std` ✅
- `reading_grade` inside `persona.writing.reading_grade_target` range ✅
- `paragraph_violations == 0` (no paragraph > 150 words) ✅
- All quantitative claims sourced (LLM check) ✅
- All persona "do's" hit at least once; all "don'ts" verified zero hits (LLM check) ✅

If any check fails: go back to Pass 3 for that subset only, don't redraft from scratch. After fixing, re-run the script and re-check only the failed gates.

### Pass 5 — Schema generation

Produce a `schema.json` sibling file containing JSON-LD for the post. AI-citation odds rise meaningfully when both `BlogPosting` and `FAQPage` schema ship with the article — and the audit's Technical Elements category awards 7 of 15 pts for these two.

Skip with `--no-schema`. Otherwise emit the file unconditionally; downstream rendering decides whether to inline it as a `<script type="application/ld+json">` block or serve it as a separate JSON document.

#### 5a. BlogPosting

Always emit. Pull fields from the brief (or from frontmatter if no brief was used):

```json
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "<title — exact, ≤ 110 chars>",
  "description": "<meta description from Pass 3 step 8>",
  "datePublished": "<ISO 8601 date>",
  "dateModified": "<ISO 8601 date — same as datePublished on first publish>",
  "author": {
    "@type": "Person",
    "name": "<author from frontmatter or brief>",
    "url": "<author profile URL if known>"
  },
  "keywords": ["<primary keyword>", "<secondary keyword 1>", "..."],
  "articleSection": "<category — from brief, e.g. 'Engineering' or 'Consumer guidance'>",
  "wordCount": <from metrics script>,
  "inLanguage": "en-AU"
}
```

`mainEntityOfPage` and `image` get filled in at render time once the post URL and hero image path are final — leave them out of the skill's output to avoid stale URLs.

#### 5b. FAQPage

Emit only if the article contains an FAQ section (Pass 3 step 7). Parse the Q&A pairs from the rendered FAQ markdown:

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "<question 1 — exactly as written in the article>",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "<answer 1 — strip markdown formatting, keep prose only>"
      }
    },
    ...
  ]
}
```

If no FAQ section exists, omit the `FAQPage` block entirely (don't ship an empty one — search engines treat it as low-quality).

#### Output shape

Single file: `<article-path-without-ext>.schema.json`. If both blocks are present, wrap them in an array:

```json
[
  { "@type": "BlogPosting", ... },
  { "@type": "FAQPage", ... }
]
```

If only `BlogPosting`, ship as a single object (not a one-element array — most renderers prefer the bare object).

In `--mode collab`, surface the schema path alongside the article path and a one-line note: "Schema: BlogPosting + FAQPage (3 Q&A pairs)" or "Schema: BlogPosting only (no FAQ section in article)".

## Output

Write the article to:

- If a brief or outline was loaded, the same directory with name `<slug>.<format>`.
- Else `<cwd>/<slug>.<format>`.

In `--mode collab`, surface:

- Path to the article
- Path to `schema.json` (or "schema skipped" if `--no-schema`)
- Word count
- Persona used + drift score (if measurable)
- Top 3 statistics + their sources (so the user can sanity-check)
- One-line summary of what could improve in a follow-up `/blog rewrite`

In `--mode auto`, just print the path and a one-line summary.

## Cross-skill integration

If the post would benefit from a hero illustration, suggest:

> "This post has a strong narrative arc. Want to generate hero illustrations? Run `/gemini-diagram-illustration --source <path>` to fan out 3–7 illustrations in parallel."

If the post has architecture or comparison content, suggest:

> "Want a clean architecture / comparison diagram? Run `/excalidraw-diagram <topic>` to produce one."

Don't auto-invoke either — the user decides whether the cost (illustrations) or time (diagram iteration) is worth it.
