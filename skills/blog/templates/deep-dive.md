---
name: deep-dive
description: Architecture / "how X works" engineering posts. Walks through a system end-to-end with diagrams, code, and tradeoffs.
target_words: [2000, 4000]
intent: informational
default_personas: [patio11-deep-dive, cloudflare-engineering, dan-luu-analysis]
---

# Deep-dive template

## Section structure

1. **Hero / opener (~150 words)**
   - One concrete number or specific moment that frames why the system exists.
   - One paragraph of stakes — what happens if the reader doesn't understand this; what they'll be able to do after.
   - Promise: a list of what the post covers (3–5 items, in the order the post will treat them).

2. **The 30-second tour (~250 words)**
   - Highest-level architecture diagram (mermaid, image, or ASCII).
   - 2–3 paragraphs explaining the diagram. Name every component once with a one-line description.
   - End with a transition: "Now let's go one level down."

3. **Part 1 — the request path (~700 words)**
   - Step-by-step of the most-frequent code path.
   - Mark each step with a short heading or numbered list item.
   - For each step, name: what it does, what it costs (latency, dollars, or both), what failure looks like.
   - One code snippet showing a non-obvious bit (validation, a clever trick, a dependency injection).

4. **Part 2 — the durable / async / background side (~600 words)**
   - What happens after the response goes out.
   - Why it's separate from the request path (Vercel timeouts, retry semantics, etc.).
   - Diagram if the topology differs from part 1.
   - "What happens when X fails?" paragraph.

5. **Part 3 — the data layer / threat-intel layer / shared infrastructure (~500 words)**
   - The bit that's "obvious in retrospect" but actually hard.
   - One specific failure mode + how it's mitigated.
   - One table of the underlying components (feeds, partners, vendors, dependencies).

6. **A short detour: the thing that's harder than it looks (~400 words)**
   - Optional but high-value: pick the one piece that gets glossed over in shallower writeups and explain it properly.
   - Examples: idempotency, rate limiting, schema migrations, retry semantics, timezone handling.

7. **What I'd change tomorrow (~250 words)**
   - 3–5 specific, scoped improvements you'd make if you had time.
   - Acknowledges debt without apologising for it.
   - This section is a credibility marker: it shows the reader you know where the bodies are buried.

8. **FAQ (~200 words, +20% AI-citation odds)**
   - 3–5 question-shaped H3s answering the long-tail queries.
   - Each answer is 2–4 sentences, answer-first.
   - Mark the section for FAQ schema injection at render time.

9. **Closing (~100 words)**
   - One-paragraph zoom-out: the larger pattern this system is one instance of.
   - Single CTA or open question.

## Length targets

- Total: 2,000–4,000 words.
- No paragraph over 150 words.
- 6–9 H2 sections.
- At least one diagram, one code snippet, one data table.

## Persona compatibility

Best with `patio11-deep-dive` (long-form, dense), `cloudflare-engineering` (team retrospective shape), or `dan-luu-analysis` (data-heavy version).

`troy-hunt` works only if the deep dive is grounded in a specific incident the author triaged personally — otherwise the conversational voice undermines the structural rigour.

`krebs-investigative` is a poor fit — investigative voice is for external events, not internal architecture.
