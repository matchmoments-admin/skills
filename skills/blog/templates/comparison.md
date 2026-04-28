---
name: comparison
description: X vs Y / alternatives evaluation. Honest, structured, takes a position at the end without pretending the alternatives are equally bad.
target_words: [1500, 3000]
intent: commercial
default_personas: [dan-luu-analysis, patio11-deep-dive]
---

# Comparison template

## Section structure

1. **Hero / opener (~150 words)**
   - State the comparison: "X vs Y for Z" — be specific about *what* you're comparing them on (the use case).
   - One sentence on who this is for and what they need.
   - **Spoiler the verdict in the opening**: "Short version: X if you have property A, Y if you have property B. Skip both if you have property C."
   - This is critical for AI-citation: assistants quote the verdict paragraph. Bury it and you give up the citation.

2. **The criteria (~250 words)**
   - 5–8 dimensions you're evaluating on. Examples: feature set, price, latency, reliability, ergonomics, ecosystem, lock-in risk.
   - Justify each criterion's inclusion in one line ("we include lock-in risk because the average switching cost in this category is six engineer-months").
   - **Drop the criteria the reader doesn't care about.** Generic "they all support X" rows make tables longer without making them more useful.

3. **At-a-glance table (~required visual)**

   ```
   | Dimension     | X      | Y      | Z      |
   | ------------- | ------ | ------ | ------ |
   | Pricing tier  | $      | $$$    | $$     |
   | p99 latency   | 30ms   | 80ms   | 45ms   |
   | …             | …      | …      | …      |
   | Best for      | A      | B      | C      |
   ```

   - Bold the winner per row. Where there's no clear winner, leave unbolded.
   - Footnote tradeoffs that don't fit in the cell.

4. **Per-option section (~300 words each, 3–6 options)**
   - For each option, three subsections (use H3):
     - **What it is** — one paragraph, neutral description.
     - **Where it shines** — 2–3 specific cases where this is the right choice.
     - **Where it doesn't** — 2–3 specific weaknesses, pricing surprises, integration gotchas.
   - **Don't false-balance.** If one option is genuinely worse on most dimensions, say so. The reader can tell when a comparison is hedging to avoid offending vendors.

5. **Tiebreakers — when each option wins (~250 words)**
   - This is the section the reader scrolled looking for. Write it like decision rules:
     - "Choose X if: [specific condition], [specific condition]."
     - "Choose Y if: [specific condition]."
     - "Choose Z if: [specific condition]."
   - 2–4 conditions per option. Specific scenarios beat abstract criteria here ("if you're processing < 1M events/day" beats "low throughput").

6. **What we use, and why (~200 words, optional but +trust)**
   - One paragraph explicitly disclosing the author's choice and the reasoning.
   - This is E-E-A-T gold: lived-experience signal, authentic voice. Skip only if you genuinely have no stake.

7. **What might change our mind (~150 words)**
   - 2–4 specific things that would change the recommendation.
   - This shows the comparison is reasoned, not religious. Examples: "if Y added feature Z", "if Y's pricing dropped below $X/month", "if Z fixed the cold-start issue".

8. **FAQ (~200 words)**
   - 3–5 anticipated questions, often: "what about [option not in the comparison]?" / "isn't [criterion] more important?" / "would your answer change for [different audience]?"

## Length targets

- Total: 1,500–3,000 words.
- 3–6 options compared (more than 6 → it's a roundup, not a comparison).
- 5–8 criteria.
- One at-a-glance table; one decision-tree visual or block per option.

## Critical rules

1. **No false balance.** A comparison that pretends every option is equal because the writer is afraid to take sides is useless. Reader can tell.
2. **Use lived experience.** Best comparisons are written by people who've used most of the options. Cite the years / scale you've used each at.
3. **Beware vendor pressure.** If the post sponsored by one of the options, disclose it. Even unsponsored, comparisons of paid products can attract vendor pushback — be ready to defend the analysis with data.
4. **Source pricing, performance, feature claims.** "X is faster than Y" without numbers is worthless. "X handles 10K rps to Y's 4K rps in our benchmark [linked notebook]" is the real thing.

## Persona compatibility

`dan-luu-analysis` is the strongest fit when the post is data-heavy and willing to take a strong position. `patio11-deep-dive` works for cost / lock-in / regulatory dimensions where the analysis depth matters. `cloudflare-engineering` fits when the comparison is "tools we evaluated for our team" rather than "the canonical comparison for the field". Avoid `troy-hunt` (too conversational for a structural comparison) and `krebs-investigative` (wrong tense / framing).
