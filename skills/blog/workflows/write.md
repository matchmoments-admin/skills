# /blog write — draft an article

Produce a finished draft from a topic, an outline, or a brief, using the active persona and the chosen template. This is the workflow that ties together every other reference doc in the skill.

## Inputs

- `<topic-or-path>` — required. If a path to an `outline-*.md` or `brief-*.md` exists, load it. Otherwise treat as a free-form topic and run `outline.md` first to scaffold.
- `--persona <name>` — override the active persona for this call only.
- `--template <type>` — force a template (`deep-dive`, `post-mortem`, `how-to`, `comparison`, `incident-report`, `announcement`).
- `--target-words <n>` — override the brief/outline target.
- `--format markdown|mdx|html` — default: auto-detect from project (look for `.mdx` files in the blog dir; default markdown).
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

Statistics from pass 1 (`[STAT-N]`) get expanded with full source citations: `According to <source name>'s <year> report, <claim>` — followed by a footnote-style or inline link to the source URL.

### Pass 3 — Polish

In order:

1. **AI-phrase scrub.** Search the draft for every entry in `references/ai-phrase-scrubber.json`. Replace each with the suggested replacement (or rewrite the sentence if the replacement doesn't fit). This step alone eliminates most of the "GPT smell."

2. **Burstiness check.** Compute the standard deviation of sentence word counts. Target ≥ 6 (per `quality-scoring.md`). If below, rewrite the most uniform paragraph with one short jab and one long context sentence.

3. **Reading-grade check.** Run a Flesch-Kincaid approximation and verify it's within the persona's `reading_grade_target` range. Adjust vocabulary up or down if not.

4. **E-E-A-T pass.** From `references/eeat-signals.md`, add at minimum:
   - One **first-person experience** sentence ("we ran this in production for…", "the first time we tried…").
   - One **named source** for every quantitative claim (no orphan numbers).
   - One **author byline** at the top with credentials relevant to the topic.
   - For technical posts: at least one **code snippet** the reader could copy-paste.
   - For data posts: at least one **chart** (Mermaid, ASCII, or generated SVG via the diagram skills).

5. **Internal linking.** Per `references/internal-linking.md`: weave 3–6 internal links into the body, with descriptive anchor text (never "click here" or "read more"). For greenfield blogs, skip and note it.

6. **FAQ schema.** If the template specifies a FAQ section, write 3–5 Q&A pairs. Format as:
   ```html
   <FAQPage> ... </FAQPage>  <!-- if HTML/MDX with schema component -->
   ```
   Or as a plain markdown FAQ section with a comment indicating schema should be applied at render time. AI-citation odds increase ~20% when FAQ schema is present.

7. **Title + meta description.** Three title candidates (40–60 chars, front-loaded keyword). One meta description (150–160 chars, includes primary keyword). One slug (kebab-case, ≤ 5 words).

8. **TL;DR / Key Takeaways.** Per the active persona's preference (some skip this, some do it as a "Key Takeaways" callout at the top, some do a "Summary" sentence at the bottom). Default to a 3-bullet "Key Takeaways" box right after the intro — it's the single most-cited element by AI assistants.

### Pass 4 — Self-audit

Run the audit workflow internally before handing the post over:

- All AI-phrase-scrubber entries returning zero matches? ✅
- Burstiness ≥ 6? ✅
- Persona drift acceptable? Sentence-length mean within ±2 words of declared, std ≥ 70% of declared? ✅
- All quantitative claims sourced? ✅
- All persona "do's" hit at least once? All "don'ts" verified zero hits? ✅
- All forbidden phrases absent? ✅

If any check fails: go back to pass 3 for that subset only, don't redraft from scratch.

## Output

Write the article to:

- If a brief or outline was loaded, the same directory with name `<slug>.<format>`.
- Else `<cwd>/<slug>.<format>`.

In `--mode collab`, surface:

- Path to the article
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
