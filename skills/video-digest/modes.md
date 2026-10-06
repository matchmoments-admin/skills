# Digest mode schemas

One schema per mode. Follow the structure; drop sections that genuinely don't apply
rather than padding them.

Every timestamp is `[mm:ss]` (or `[h:mm:ss]` past an hour) and links back to the
moment the claim came from. Every uncertain value carries a marker:

- `[not stated]` — never mentioned
- `[unclear: heard "…"]` — caption garbled, exact text quoted
- `[from screen at mm:ss]` — read off a frame, not spoken

---

## recipe

```markdown
# <Dish name>

**Yield:** N servings [not stated]
**Active time:** … · **Total time:** …

## Ingredients
- 2 cups plain flour `[01:12]`
- [not stated] butter, softened `[01:20]`
- 1 tsp [unclear: heard "to spoons"] vanilla `[01:31]`

## Equipment
- 23cm springform tin `[00:48]`

## Steps
1. Preheat oven to 180°C `[02:04]`
2. …

## Notes from the cook
- Any technique tips, substitutions or warnings the presenter gave.

## Confidence notes
- Oven temperature stated once and not repeated; verify.
- Butter quantity never given.
```

Convert spoken numbers to numerals (`two cups` → `2 cups`). Keep the unit the
presenter used; don't convert between metric and imperial unless asked. Note
temperatures, times and pan sizes explicitly — they're the most commonly mangled and
the most consequential.

---

## tutorial

```markdown
# <What this teaches>

**Stack / versions:** … `[00:30]`
**Prerequisites:** …

## Steps
1. **<Action>** `[01:05]`
   ```bash
   exact command as spoken or shown
   ```
   Why: …

## Settings and values mentioned
| Setting | Value | Where |
|---|---|---|
| … | … | `[04:12]` |

## Links mentioned
- … `[07:30]`

## Confidence notes
```

Commands and code go in fenced blocks verbatim. If a command was shown on screen but
not read aloud, mark it `[from screen at mm:ss]` — an ASR-transcribed shell command is
almost always wrong.

---

## sop

```markdown
# SOP: <process name>

**Trigger:** what starts this
**Owner:** who does it
**Systems touched:** …

## Procedure
1. … `[mm:ss]`
   - **If <condition>:** …
   - **Failure mode:** … → …

## Decision points
| At step | Question | Options |
|---|---|---|

## Not covered in the video
- Gaps someone would hit on their first run.
```

The value of an SOP is in the branches and the failure modes, not the happy path.
Capture "if it errors, do X" wherever it appears, and be explicit about what the
video never addressed.

---

## podcast

```markdown
# <Episode title>
**Guest:** … · **Host:** …

## In one paragraph
…

## Key threads
### <Thread> `[12:04 – 19:30]`
- Claim: …
- Reasoning: …
- Pushback: …

## Notable moments
| Time | What |
|---|---|

## Named references
People, papers, books, companies mentioned — with timestamps.

## Confidence notes
```

Keep speakers separated. Transcripts rarely carry speaker labels, so attribute only
where the audio makes it obvious (a question followed by an answer), and say when
you can't tell. Do not present paraphrase as quotation.

---

## lecture

```markdown
# <Topic>

## Prerequisites assumed
## Core ideas
### <Idea> `[mm:ss]`
Definition · intuition · worked example

## Worked examples
## Open questions raised
## Confidence notes
```

Definitions are the load-bearing part. Capture them close to verbatim where the
transcript is punctuated, and mark them as reconstructed where it isn't.

---

## meeting

```markdown
# <Meeting> — <date>

## Decisions
| Decision | Owner | Timestamp |

## Actions
- [ ] … — @owner `[mm:ss]`

## Discussion
## Open / unresolved
```

Separate what was **decided** from what was **discussed**. A meeting note that blurs
the two is why people re-litigate things.
