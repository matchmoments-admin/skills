# /blog outline — SERP-informed structure

Light-weight planning artefact: produce an H2/H3 outline + section-by-section length targets + content-gap notes, **without** the full keyword research and statistics-finding of `brief`. Use this when you already know the angle and just need a skeleton to draft against.

## Inputs

- `<topic-or-keyword>` — required.
- `--intent informational|commercial|transactional|navigational` — optional, inferred from topic if missing.
- `--target-words <n>` — optional, default 1500–2500 depending on intent.
- `--template <type>` — optional, force a specific template from `~/.claude/skills/blog/templates/` (overrides auto-detection).
- `--mode collab|auto` — default `collab`.

## Workflow

### 1. Topic + intent

If only a topic is given, infer:

- **Primary keyword**: closest exact-match phrase a reader would type.
- **Search intent**: pick one of the four. Heuristics:
  - "How to X", "X tutorial", "X explained" → informational
  - "Best X", "X review", "X vs Y", "X alternatives" → commercial
  - "Buy X", "X pricing", "X signup" → transactional
  - "X login", "X dashboard" → navigational

### 2. Template auto-detection

Map the topic + intent to one of `templates/`:

| Signal                                 | Template          |
| -------------------------------------- | ----------------- |
| Architecture / "how X works"           | `deep-dive`       |
| Failure / outage / lessons             | `post-mortem`     |
| Step-by-step                           | `how-to`          |
| X vs Y / alternatives                  | `comparison`      |
| Investigative reporting on an event    | `incident-report` |
| Product / feature launch / milestone   | `announcement`    |

If the user passed `--template`, use that. If nothing fits cleanly, pick `deep-dive` and tell the user.

Load `~/.claude/skills/blog/templates/<template>.md` for the section structure to seed step 4.

### 3. SERP analysis

Use WebSearch on the primary keyword. For each of the **top 5 results**:

- URL + title
- Heading structure (H2s, H3s if visible in the snippet)
- Approximate word count
- Visual elements (images, charts, videos, tables)
- One-line "what makes this distinct"
- One-line "what this misses"

Use WebFetch on the top 2–3 if the snippet is too thin to extract the heading structure reliably.

### 4. Generate outline

Combine the template's section structure with the SERP gaps. Output shape:

```markdown
# Outline: <topic>

## Title suggestions

1. <40–60 chars, front-loaded keyword, specific>
2. <alternative angle>
3. <question form>

## Target parameters

- **Primary keyword**: <keyword>
- **Search intent**: <intent>
- **Template**: <template>
- **Target word count**: ~2,000
- **Reading-grade target**: <from active persona>
- **Active persona**: <from .active-persona file>

## Outline

### Intro (~150 words)

- Hook: <a single concrete number, story, or question>
- Stakes: <why the reader should care>
- Promise: <what they'll be able to do / understand by the end>

### H2: <section 1 title — phrased as the question this section answers> (~300 words)

- Answer-first opener: <the one stat or fact this section opens with>
- Key points to cover:
  - <point 1>
  - <point 2>
  - <point 3>
- Visual: <suggested chart, table, diagram, or "none">
- Internal link target: <existing post / pillar to link to, if any>

### H2: <section 2> (~400 words)
...

### H2: FAQ (~200 words, optional but +20 AI-citation odds)

- Q1: <question> → A1: <one-paragraph answer>
- Q2: ...
- Q3: ...

### Conclusion (~100 words)

- Summary in 2–3 sentences
- One concrete action / question for the reader
- (Optional) "what I'd change tomorrow" / "what I got wrong"
```

### 5. Gap-vs-SERP table

Append a small table comparing this outline to the top 3 SERP results:

| Aspect              | Top result | #2 | #3 | Our outline   |
| ------------------- | ---------- | -- | -- | ------------- |
| Word count          | 1800       | 2400 | 1500 | 2000          |
| H2 count            | 6          | 8    | 5    | 7             |
| FAQ section         | no         | yes  | no   | yes           |
| Original data       | no         | no   | no   | **yes**       |
| Code snippets       | yes        | no   | no   | yes           |
| Author byline + bio | yes        | no   | no   | yes           |

The bolded cells are the differentiation — what the new post will have that nobody else does.

### 6. Output

Write the outline to `<output-dir>/outline-<slug>.md` (default `<cwd>/outline-<slug>.md`).

In `--mode collab`, ask:

> "Outline written to <path>. Run `/blog write <path>` now? Or `/blog brief <topic>` for deeper research first?"

Recommend `brief` if the outline depends on statistics that haven't been sourced yet. Recommend `write` if the user already has the data and just needs the article scaffolded.
