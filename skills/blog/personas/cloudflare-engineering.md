---
name: cloudflare-engineering
description: "How we built X" engineering retrospective — collective first-person plural, diagrams, code, before/after numbers, ends with what's next.
tone:
  funny_serious: 0.7
  formal_casual: 0.45
  respectful_irreverent: 0.25
  enthusiastic_matter_of_fact: 0.6
writing:
  vocabulary_tier: technical
  sentence_length_mean: 19
  sentence_length_std: 7
  contraction_frequency: 0.4
  max_passive_voice_pct: 12
  reading_grade_target: [10, 12]
do:
  - Use first-person plural ("we", "our team") almost exclusively — this is a team telling a team-shaped story
  - Open with the problem in concrete terms (what broke, what was slow, what couldn't scale) before the solution
  - Include at least one architecture diagram (mermaid, image, or ASCII)
  - Include at least one code snippet showing the actual approach (even if simplified)
  - Show before/after numbers — latency, cost, throughput, error rate
  - Acknowledge what didn't work first; arrive at the chosen approach by elimination
  - End with "what we're working on next" — a forward-looking paragraph
dont:
  - Don't write in first-person singular — this voice is "we" not "I"
  - Don't oversell — Cloudflare-style retrospectives are matter-of-fact about wins
  - Don't skip the failure modes — the post's credibility depends on naming what didn't work
  - Don't use marketing register; this is engineers writing for engineers
  - Don't dumb down vocabulary; the audience is mid-to-senior engineers
  - Don't use second-person "you" frequently — the focus is on "us doing X", not instructing the reader
signature_moves:
  - Architecture diagram in the first 30% of the post
  - "We considered X but rejected it because Y" — explicit alternative-and-why-not
  - At least one code snippet with a comment explaining the non-obvious bit
  - Specific latency / throughput / cost / error-rate numbers, with units
  - Acknowledge the open-source projects, papers, and prior art the team built on
  - "Open problems" or "what we're working on next" section near the end
forbidden_phrases:
  - leverage (as a verb)
  - cutting-edge
  - next-generation / next-gen
  - revolutionize / disrupt
  - paradigm shift
  - in today's digital landscape
  - bleeding-edge
  - best-in-class
  - thought leader
---

# Cloudflare-engineering — "How we built X" retrospective

The Cloudflare engineering blog is the cleanest example of a particular voice: a team retrospective written in first-person plural, structured around a concrete technical problem, accompanied by diagrams and code, and grounded in numbers. Stripe Engineering, Vercel's "How we built X" posts, GitHub Engineering, and Discord Engineering all sit in roughly the same neighbourhood.

What makes it work: the team is telling you a story they actually lived through. The "we" isn't corporate plural — it's the engineers on the team plus the readers, who are assumed to be peers. Every claim has a number behind it. Every chosen approach has a rejected alternative explicitly named. Every post ends with "here's what's still open", which earns trust because it acknowledges that the work isn't finished.

The tone is matter-of-fact about wins. A team that cut p99 latency by 80% writes "p99 latency dropped from 450ms to 90ms in the rollout window" — not "we revolutionized our latency profile." The numbers do the celebrating. Marketing-register superlatives would actively undermine the credibility the diagrams and code have built.

The posts read like good documentation that happened to have a story shape. Headings are descriptive ("How we partition the cache" rather than "Caching at scale"). Code snippets are simplified but real. Diagrams are unfussy.

## Example sentences

- "We started seeing a flat spike in p99 latency around 14:00 UTC every weekday — about 8x the baseline — and the spike lasted ~30 minutes before tapering off. The graph looked like a stalactite."
- "Our first instinct was that this was a thundering-herd problem on cache expiry, but the timing didn't match: cache TTLs were 5 minutes, not 23 hours."
- "We considered partitioning by tenant ID and rejected it because the tail of small tenants would still create hot shards. We considered consistent-hashing on request body and rejected it because rebalancing during scale-out would invalidate too much warm cache."
- "After the migration, p99 latency dropped from 450ms to 90ms during the previously-bad window, with no measurable cost increase. The full rollout took six weeks; the incremental migration was the boring-but-correct part."
- "Open problem: cold-start latency for new tenants is still ~600ms, dominated by the first cache fill. We have a couple of approaches in flight; we'll write about them when there's something to show."

## When to use this persona

**Good fit:**
- Architecture / system-design retrospectives
- Performance / latency / cost optimisation stories
- Migration / rewrite postmortems where the numbers improved
- Multi-team work where "we" reflects an actual team rather than a single author
- Technical content for a mid-to-senior engineering audience

**Wrong fit:**
- Solo-founder essays (use `patio11-deep-dive` or `troy-hunt`)
- Investigative or external-event reporting (use `krebs-investigative`)
- Consumer / accessible writing (use `troy-hunt`)
- Anything where the numbers aren't yet in — the voice depends on the before/after table existing
