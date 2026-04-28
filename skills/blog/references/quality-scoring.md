# Quality scoring framework

The 5-category 0–100 scoring used by `audit` and `rewrite`. Each category has a fixed weight; checks within the category are weighted to roughly add up to the category total.

## Categories and weights

| Category               | Weight | Why it gets this weight                                              |
| ---------------------- | -----: | -------------------------------------------------------------------- |
| Content Quality         | 30     | The single biggest predictor of whether a post is read to the end. |
| SEO Optimization        | 25     | Drives discovery. Independent of quality but compounds with it.     |
| E-E-A-T Signals         | 15     | What separates "ranks" from "ranks well + cited".                   |
| Technical Elements      | 15     | Schema + structure. Cheap to add, big payoff.                       |
| AI-Citation Readiness   | 15     | New surface (ChatGPT, Perplexity, AI Overviews). Easy to ignore, increasingly costly. |
|                        | **100**|                                                                      |

---

## Content Quality (30 points)

### 1. Burstiness — sentence-length variance (6 points)

Compute std-dev of sentence word counts.

| Std-dev | Points |
| ------- | ------ |
| ≥ 6     | 6      |
| 4 – 5.99| 3      |
| < 4     | 0      |

AI-generated prose typically lands at std-dev 2–4 because LLMs default to medium-length sentences. Human prose mixes 5-word punchlines with 30-word context sentences. Aim for ≥ 6.

### 2. Type-Token Ratio — vocabulary diversity (6 points)

Compute unique words / total words (lowercase, strip punctuation). Cap at first 1000 words for fairness.

| TTR     | Points |
| ------- | ------ |
| ≥ 0.50  | 6      |
| 0.40 – 0.49 | 3 |
| < 0.40  | 0      |

Repetitive AI prose lands TTR < 0.40. Natural prose with even modest vocabulary discipline lands ≥ 0.50.

### 3. AI-phrase density (6 points)

Count matches against `references/ai-phrase-scrubber.json`.

| Hits  | Points |
| ----- | ------ |
| 0     | 6      |
| 1 – 3 | 3      |
| 4+    | 0      |

### 4. Paragraph length distribution (6 points)

- All paragraphs ≤ 150 words AND mix of short (1–3 sentence) + long: 6 pts.
- One paragraph > 150 words OR all paragraphs uniform length: 3 pts.
- Multiple paragraphs > 150 words OR rhythm clearly broken: 0 pts.

Long monolithic paragraphs and uniform-length paragraphs are both readability problems for different reasons; both lose points.

### 5. Original data / first-hand experience (6 points)

Look for either or both:

- **First-person experience marker**: the post describes something the author did, observed, or personally encountered (≥ 2 instances).
- **Original data callout**: the post presents data, screenshots, logs, or measurements the author generated (not aggregated from elsewhere).

| Status                                | Points |
| ------------------------------------- | ------ |
| Both present (≥ 2 first-person, ≥ 1 data) | 6      |
| One present                          | 3      |
| Neither                              | 0      |

This is the single strongest E-E-A-T signal at the content level. Weighted into Content Quality rather than E-E-A-T Signals because it shows up in the prose itself, not in the metadata.

---

## SEO Optimization (25 points)

### 1. Heading hierarchy clean (5 points)

H1 → H2 → H3, no skips, exactly one H1 per post: 5 pts. Any violation: 0.

### 2. Primary keyword placement (5 points)

Primary keyword appears in:

- Title
- H1 (often same as title)
- First 100 words
- ≥ 1 H2

All four: 5 pts. Three of four: 3. Fewer: 0.

### 3. Meta description (5 points)

Present, 150–160 chars, includes primary keyword, ends in a sentence: 5 pts. Present but out of range or missing keyword: 3. Absent: 0.

### 4. Word count vs intent (5 points)

| Intent          | Target floor |
| --------------- | ------------ |
| informational   | 1500         |
| commercial      | 1800         |
| transactional   | 700          |
| navigational    | 500          |

Within target → 5 pts; under floor by ≤ 25% → 3; under floor by > 25% → 0.

### 5. Freshness signals (5 points)

- Publication date in body or frontmatter
- "Last updated" date if applicable
- ≥ 1 cited statistic from the last 24 months

All three: 5 pts. Two: 3. One or zero: 0.

---

## E-E-A-T Signals (15 points)

### 1. Named author + bio with credentials (4 points)

Byline with the author's name + a one-line credentials statement (job, what they've built, what they study): 4 pts. Byline with name only: 2. Anonymous: 0.

### 2. First-person experience markers (4 points)

Count phrases in the body that explicitly tie the writing to first-hand experience: "we ran X for 18 months", "I tested this on Y", "the first time we hit this", "from talking to N customers".

| Markers | Points |
| ------- | ------ |
| ≥ 2     | 4      |
| 1       | 2      |
| 0       | 0      |

### 3. All quantitative claims sourced (4 points)

Every number in the body must have a named source within ~50 words. Audit by extracting numbers and checking the surrounding sentences.

| Sourced rate | Points |
| ------------ | ------ |
| 100%         | 4      |
| 80 – 99%     | 2      |
| < 80%        | 0      |

### 4. Date markers (3 points)

Publication date present + lastUpdated present (if the post has been updated): 3 pts. One present: 1. Neither: 0.

---

## Technical Elements (15 points)

### 1. FAQ schema (4 points)

Either:

- Inline `<FAQPage>` / `<FAQItem>` JSON-LD or component, or
- Markdown FAQ section explicitly marked for FAQ-schema injection at render time.

Present + valid: 4. Present but malformed / partial: 2. Absent: 0.

### 2. Article / BlogPosting schema (3 points)

JSON-LD or component-based BlogPosting / Article schema with at minimum: headline, datePublished, author, publisher: 3 pts. Partial: 1. Absent: 0.

### 3. Internal links (4 points)

≥ 3 links to other posts on the same site, with descriptive anchor text (not "click here", "read more", "this article"): 4 pts. ≥ 1 such link: 2. Zero: 0. Greenfield blogs (no other posts to link to) get 4 pts automatically.

### 4. Image alt text (2 points)

Every `<img>` / `![alt](src)` has populated alt text describing the visual: 2 pts. ≥ 1 missing: 1. Multiple missing: 0.

### 5. Code blocks language-tagged (2 points)

Every fenced code block has a language tag (`\`\`\`python`, `\`\`\`bash`, etc.): 2 pts. ≥ 1 untagged: 0.

---

## AI-Citation Readiness (15 points)

### 1. Answer-first formatting (4 points)

Every H2 opens with the section's answer in 1–2 sentences before context.

| H2 compliance rate | Points |
| ------------------ | ------ |
| 100% / all H2s     | 4      |
| ≥ 70%              | 2      |
| < 70%              | 0      |

### 2. Key Takeaways callout (3 points)

A "Key Takeaways" / "TL;DR" / "Summary" callout near the top, before the main body, with 3–5 bullet points: 3 pts. Present but in the wrong location (bottom): 1. Absent: 0.

### 3. Citation capsules (4 points)

Inline citations in the form "(per <source> <year>)" or "according to <source>'s <year> <type>".

| Density (per 500 words) | Points |
| ----------------------- | ------ |
| ≥ 2                     | 4      |
| 1                       | 2      |
| 0                       | 0      |

### 4. Information-gain markers (2 points)

Sentences that explicitly flag what's new / different about this post's coverage: "while most coverage focuses on X, this post examines Y", "what isn't widely reported is Z".

≥ 1 such marker: 2 pts. None: 0.

### 5. Long-tail question phrasing in H2s (2 points)

H2s phrased as the question they answer ("Why we use Inngest" → "Why we chose Inngest over alternatives", "Cache configuration" → "How cache TTL is decided").

| H2 question rate | Points |
| ---------------- | ------ |
| ≥ 50%            | 2      |
| 25 – 49%         | 1      |
| < 25%            | 0      |

---

## Total interpretation

| Score    | Verdict                                                              |
| -------- | -------------------------------------------------------------------- |
| 90 – 100 | Ship. This is a strong post.                                         |
| 75 – 89  | Ship after addressing the top 3 punch-list items.                    |
| 60 – 74  | Don't ship yet. Run `/blog rewrite` and re-audit.                     |
| < 60     | Substantial issues. Consider whether to fix or to start over.        |

## Calibration

If the audit is producing scores that don't match the user's lived sense of quality (everything scoring high; everything scoring low; no spread), the weights and thresholds in this doc should be tuned. Edit the numbers in this file directly — the audit workflow reads from here, so changes take effect on the next audit.
