---
name: house-template
description: Fillable starter persona — fork via `/blog persona create` to define your own house voice. The unset values below are sensible defaults for a technically-curious mid-experience reader; override anything that doesn't fit.
tone:
  funny_serious: 0.6
  formal_casual: 0.5
  respectful_irreverent: 0.3
  enthusiastic_matter_of_fact: 0.5
writing:
  vocabulary_tier: professional
  sentence_length_mean: 18
  sentence_length_std: 7
  contraction_frequency: 0.6
  max_passive_voice_pct: 10
  reading_grade_target: [9, 11]
do:
  - "[FILL IN — pick 5 things you do that distinguish your voice; examples: 'open with one specific number', 'address the reader as you', 'use first-person plural']"
  - "[FILL IN]"
  - "[FILL IN]"
  - "[FILL IN]"
  - "[FILL IN]"
dont:
  - "[FILL IN — pick 5 phrasings or moves you specifically avoid; examples: 'never start with In today's...', 'don't use marketing register', 'don't apologise for length']"
  - "[FILL IN]"
  - "[FILL IN]"
  - "[FILL IN]"
  - "[FILL IN]"
signature_moves:
  - "[FILL IN — 3–5 things this voice always does that other voices don't]"
  - "[FILL IN]"
  - "[FILL IN]"
forbidden_phrases:
  - "[FILL IN — phrases this brand specifically must never use; can be empty]"
---

# House template

This file is a **starter** — the values above are middle-of-the-road defaults that should produce reasonable prose for most professional contexts. They are not opinionated enough to make your posts sound like you specifically. To get there:

1. **Decide who you sound like.** The closest of the named personas is a starting point. Read those files (`troy-hunt.md`, `patio11-deep-dive.md`, `cloudflare-engineering.md`, `dan-luu-analysis.md`, `krebs-investigative.md`) and see which one's voice description and example sentences feel closest to what you'd write naturally.

2. **Adjust the deltas.** If `troy-hunt` is closest but you write more formally, raise the `formal_casual` score (toward 0.0). If you don't write Australian English, drop the colloquialisms in the do-list. The named personas are anchors, not constraints.

3. **Fill in the do's, don'ts, and signature moves.** This is where your voice actually lives. Generic do's like "use clear language" do not make you distinct from any other writer; they're not worth listing. Specific do's like "every quantitative claim is followed by a parenthetical citing the source" or "every post closes with what I'd change tomorrow" are what make a voice recognisable.

4. **Forbidden phrases.** Industry- or brand-specific phrasings to avoid. Always include the AI-marketing phrases that infect technical writing if no other persona's `forbidden_phrases` list applies (`leverage`, `delve`, `cutting-edge`, `revolutionize`, `paradigm shift`, etc. — but the global `~/.claude/skills/blog/references/ai-phrase-scrubber.json` already covers those, so this list should be additions specific to your context).

## Workflow

The fastest way to get from this template to a working persona:

```bash
/blog persona create
```

This kicks off the 6-step interactive interview defined in `~/.claude/skills/blog/workflows/persona.md`. The output is a new persona file in `~/.claude/skills/blog/personas/<your-name>.md` that subsequent `/blog write` calls can use.

## Example sentences (replace these)

Three to five short example sentences in the voice. Pick concrete topics so the rhythm is audible. **Replace these with your own** — the boilerplate examples below are placeholders.

- "Placeholder: every quantitative claim is followed by a parenthetical citing the source (this one being a placeholder, no source applies)."
- "Placeholder: a short sentence."
- "Placeholder: a longer sentence that demonstrates how this voice handles a more complex argument by stacking clauses, signalling refinements with em-dashes, and arriving at a specific conclusion grounded in named data."

## When to use this persona

The unedited template is the fallback the skill uses when no active persona is set. As soon as you fork it via `/blog persona create`, the new file is the one to reach for. Do not write production posts under `house-template` itself — its values are deliberately generic and the prose will read that way.
