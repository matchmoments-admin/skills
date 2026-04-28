# /blog persona — manage writing voices

Personas are the heart of this skill. They turn "write a blog post about X" into "write a blog post about X **as if Troy Hunt were writing it**" — which produces measurably more interesting prose because each persona declares specific sentence-length distributions, vocabulary tiers, do's, don'ts, and signature moves.

## Subcommands

| Form                          | Action                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `/blog persona list`          | Print all personas in `~/.claude/skills/blog/personas/`, with one-line descriptions     |
| `/blog persona show <name>`   | Print the full persona file for inspection                                              |
| `/blog persona use <name>`    | Set the active persona (writes the name to `~/.claude/skills/blog/.active-persona`)     |
| `/blog persona create`        | Interactive 6-step interview to fork `house-template.md` into a new named persona       |
| `/blog persona current`       | Print the active persona's name (or "none — falling back to house-template")            |

## `list` — implementation

```bash
ls ~/.claude/skills/blog/personas/*.md
```

For each, parse the YAML frontmatter and print:

```
- <name>  — <short_description>
```

Sort alphabetically except keep `house-template` last.

## `show <name>` — implementation

Print `~/.claude/skills/blog/personas/<name>.md` verbatim. If the file doesn't exist, `list` available personas instead and exit 1.

## `use <name>` — implementation

```bash
echo "<name>" > ~/.claude/skills/blog/.active-persona
```

Validate first: if `<name>.md` doesn't exist under `personas/`, error with the available names.

After writing, confirm:

> Active persona: <name>. Future `/blog write` and `/blog rewrite` calls will use this voice unless overridden with `--persona`.

## `create` — interactive interview

This is the meatiest subcommand. It walks the user through 6 steps, then writes a new persona file derived from `house-template.md` with the user's answers baked in.

### Step 1 — Brand basics

Ask:

- **Persona name** (kebab-case, e.g. `acme-engineering`)
- **Short description** (one line for the YAML frontmatter)
- **Industry / domain** (e.g. "fintech APIs", "embedded systems", "cybersecurity")
- **Target reader** (one sentence)

### Step 2 — NNGroup 4-dimension tone

Each dimension is 0.0 → 1.0. Show both ends with examples; let the user pick a number.

| Dimension                    | 0.0                                                          | 1.0                                                                | Default |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ------- |
| `funny_serious`              | "Let's be real, ToS are unread."                              | "Understanding agreements protects your business."                  | 0.6     |
| `formal_casual`              | "We are pleased to announce."                                 | "Guess what — we shipped it."                                       | 0.5     |
| `respectful_irreverent`      | "We appreciate your patience."                                | "Yeah, that old pattern is broken."                                 | 0.3     |
| `enthusiastic_matter_of_fact`| "This changes everything!"                                    | "Here are the results."                                             | 0.5     |

### Step 3 — Sentence-length distribution + vocab tier

- **Vocabulary tier**: `consumer` (Flesch 60–70 / grade 7–9), `professional` (Flesch 50–60 / grade 9–11), `technical` (Flesch 40–50 / grade 11–13)
- **Sentence-length mean** in words (default 18)
- **Sentence-length std-dev** in words — variation matters more than mean (default 7; AI-generated prose often shows std-dev < 4, which is why it reads as "AI-generated")
- **Contraction frequency** 0.0 (never) → 1.0 (always); default 0.6
- **Max passive voice** as a percentage cap; default 10%

### Step 4 — Do's and don'ts

Ask for **5 do's and 5 don'ts**. Show 3 starter examples for each based on the tone scores. The user can accept, edit, or replace.

Example starters when `formal_casual` is high (casual):

- Do: open with a question or a single concrete number
- Do: use first-person plural for shared experience
- Don't: open with "In today's digital landscape"
- Don't: use "leverage" as a verb

### Step 5 — Signature moves

Ask for 3–5 "things this voice always does that other voices don't." Examples:

- "Includes a table of source data with every quantitative claim"
- "Ends every post with 'what I'd change tomorrow'"
- "Uses bracketed parenthetical asides rather than footnotes"
- "Names specific products / vendors rather than 'a popular tool'"
- "Closes with a single-sentence summary"

### Step 6 — Forbidden phrases (project-specific, optional)

Ask if there are any phrases this brand specifically must never use (e.g. "best-in-class", or a competitor's product name). These get appended to the global `references/ai-phrase-scrubber.json` enforcement when this persona is active.

### Output

Write the new persona file to `~/.claude/skills/blog/personas/<name>.md` using the `house-template.md` shape. YAML frontmatter:

```yaml
---
name: <name>
description: <short description>
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
  - <do 1>
  - <do 2>
  - <do 3>
  - <do 4>
  - <do 5>
dont:
  - <dont 1>
  ...
signature_moves:
  - <move 1>
  ...
forbidden_phrases:
  - <phrase 1>
  ...
---

# <Name>

<longer prose description that pattern-matches "what this voice sounds like when it's working" — 2–3 paragraphs the agent can read at draft time to internalise the voice>

## Example sentences

Three to five short example sentences in this voice. Pick concrete topics so the user can hear the rhythm.

## When to use this persona

Brief description of the topic / audience / format combinations this voice is best at, and the ones it's wrong for.
```

After writing, ask:

> "Persona <name> created. Set as active? (y/n)"

## How workflows consume the active persona

`write`, `rewrite`, and `repurpose` all read `~/.claude/skills/blog/.active-persona` and load the named file before drafting. The persona's tone scores, sentence stats, and signature moves are passed into the draft as constraints. The audit step measures the draft against those targets and flags drift.
