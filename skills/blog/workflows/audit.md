# /blog audit — score an existing post

Run a 5-category quality scan on a published or draft post. Output is a numerical score plus a punch-list of specific fixes. This is what `write` calls internally as Pass 4, and what users invoke directly to grade competitor posts or to decide whether an old post needs `rewrite`.

## Inputs

- `<post-path>` — required. Markdown, MDX, or HTML.
- `--persona <name>` — score persona-drift against this persona. If unset, only the persona-agnostic categories run.
- `--report <path>` — write the audit report to a file. Default: `<post-path>.audit.md` next to the post.
- `--mode collab|auto` — default `auto` (audit is rarely interactive).

## Scoring framework

Five categories, weights from `references/quality-scoring.md`:

| Category               | Weight | What it measures                                              |
| ---------------------- | -----: | ------------------------------------------------------------- |
| Content Quality         | 30     | Originality, depth, structure, readability                     |
| SEO Optimization        | 25     | Keyword usage, headings, meta, length, freshness               |
| E-E-A-T Signals         | 15     | First-person experience, named sources, credentials, dates    |
| Technical Elements      | 15     | Schema, images, internal links, heading hierarchy             |
| AI-Citation Readiness   | 15     | Answer-first formatting, FAQ schema, key-takeaways box, citation capsules |
|                        | **100**|                                                                |

Each category is 0–N where N is its weight. Score is the sum.

## Workflow

### 1. Read the post

Detect format from extension. Strip frontmatter and treat the body as the audit target.

### 2. Run each category check

Implementation notes for each are in `references/quality-scoring.md`. Summary of what to compute:

#### Content Quality (30)

- **Burstiness** (sentence-length std-dev): ≥ 6 → 6 pts, 4–6 → 3 pts, < 4 → 0 pts (reads as AI).
- **Type-Token Ratio** (unique words / total words): ≥ 0.50 → 6 pts, 0.40–0.49 → 3 pts, < 0.40 → 0 pts.
- **AI-phrase density** (matches against `references/ai-phrase-scrubber.json`): 0 → 6 pts, 1–3 → 3 pts, 4+ → 0 pts.
- **Paragraph length distribution** (no paragraph > 150 words; mix of short + long): all-pass → 6 pts, 1 violation → 3, 2+ → 0.
- **Original data / experience present**: ≥ 1 first-person experience marker AND ≥ 1 original-data callout → 6 pts, one or the other → 3, neither → 0.

#### SEO Optimization (25)

- **Heading hierarchy clean** (H1 → H2 → H3, no skips): 5 pts.
- **Primary keyword in title, H1, first 100 words, ≥ 1 H2**: 5 pts.
- **Meta description** present, 150–160 chars, includes primary keyword: 5 pts.
- **Word count** matches intent (informational ≥ 1500, commercial ≥ 1800, transactional flexible): 5 pts.
- **Freshness signals** (date in body, "last updated" if applicable, recent stats from ≤ 24 months): 5 pts.

#### E-E-A-T Signals (15)

- **Named author + bio with credentials**: 4 pts.
- **First-person experience markers** (≥ 2 per post): 4 pts.
- **All quantitative claims sourced** to named external source: 4 pts.
- **Date markers** (publication date + lastUpdated): 3 pts.

#### Technical Elements (15)

- **FAQ schema present** (or marked for render-time injection): 4 pts.
- **Article / BlogPosting schema** present: 3 pts.
- **Internal links** (≥ 3 to other posts on the same site, descriptive anchors): 4 pts.
- **Image alt text** populated for every image: 2 pts.
- **Code blocks** have language tags (for syntax highlighting): 2 pts.

#### AI-Citation Readiness (15)

- **Answer-first formatting** (every H2 opens with the section's answer in 1–2 sentences): 4 pts.
- **Key Takeaways callout** at the top: 3 pts.
- **Citation capsules** (named sources with year, in-line, format like "(per Anthropic's 2025 model card)"): 4 pts.
- **Information-gain markers** (sentences that flag "what's new here vs. existing coverage"): 2 pts.
- **Long-tail question phrasing** in H2s (questions, not declaratives): 2 pts.

### 3. Persona drift (only if `--persona` set)

Compute drift against the named persona's declared targets:

- **Sentence-length mean drift**: |observed - declared| / declared. Report as ±N words.
- **Sentence-length std drift**: ratio of observed/declared (target ≥ 0.7).
- **Contraction-frequency drift**: observed - declared.
- **Reading-grade drift**: ±N grades.
- **Forbidden-phrase hits**: count of phrases from the persona's `forbidden_phrases[]` found in the post.
- **Do hits**: which of the persona's "do" rules are visibly applied (heuristic check).
- **Don't hits**: which of the persona's "don't" rules are violated.

Persona drift is **not** rolled into the 100-point score — it's reported separately as a "voice fit" verdict (good / acceptable / poor) with the underlying numbers.

### 4. Output

Write the report to `<report-path>` (default `<post>.audit.md`). Format:

```markdown
# Audit: <slug>

**Score: 78 / 100**

| Category              | Score | Notes |
| --------------------- | ----- | ----- |
| Content Quality       | 24/30 | Burstiness 5.2 (target ≥ 6); 2 AI-phrase hits |
| SEO Optimization      | 20/25 | Meta description missing |
| E-E-A-T Signals       | 12/15 | First-person markers OK; 2 unsourced numbers |
| Technical Elements    | 10/15 | No FAQ schema; 1 image missing alt text |
| AI-Citation Readiness | 12/15 | Answer-first OK on 4/6 H2s |

## Punch list (priority order)

1. Add meta description (150–160 chars, primary keyword).
2. Source the unsourced numbers in the "phone enrichment" and "feed coverage" sections.
3. Inject FAQ schema (3 Q&A pairs added at the bottom).
4. Add alt text to image: `/illustrations/architecture-hero.webp`.
5. Replace AI-phrase hits: "leverage" → "use" (line 42); "in today's digital landscape" → "today" (line 8).
6. Tighten 2 H2s to answer-first format: "Why we use Inngest" should open with the one-line answer.

## Persona drift (if --persona given)

| Metric                 | Declared | Observed | Drift     |
| ---------------------- | -------- | -------- | --------- |
| Sentence-length mean   | 18 ± 7   | 21 ± 5.2 | +3 / -1.8 |
| Contraction frequency  | 0.6      | 0.42     | -0.18     |
| Reading grade          | 9–11     | 12.4     | +1.4 above|
| Forbidden phrases hit  | 0        | 1        | +1        |
| Do rules applied       | 5/5      | 4/5      | "answer-first H2s" missing |
| Don't rules violated   | 0/5      | 1/5      | "starts with 'In' " (line 1) |

**Voice fit: acceptable** — drift on sentence variance and reading grade; one forbidden phrase hit. Recommend `/blog rewrite <post> --persona <name>` to pull back into voice.

## Quick `rewrite` recipe

If you want to run `/blog rewrite <post>` after this, the highest-leverage targets are: items 1, 2, 5 in the punch list. Items 3, 4, 6 can be batched into a follow-up pass if time-constrained.
```

### 5. Exit code

- Score ≥ 85 — exit 0, "ship-ready"
- Score 70–84 — exit 0, "ship with the punch-list addressed"
- Score < 70 — exit 1, "do not ship — fix the punch list and re-audit"

The exit code is useful for CI integration, e.g. running audit on every PR that touches `docs/blog/`.
