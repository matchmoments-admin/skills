# Triage labels

The engineering skills speak in five triage roles. This maps them to this repo's labels (`pipeline/src/conventions.mjs`
LABELS is the full list; the pipeline's button and verdict labels are not triage labels and skills must not apply them).

| Role in mattpocock/skills | Label here | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | A person needs to evaluate it |
| `needs-info` | `needs-info` | Waiting on the reporter |
| `ready-for-agent` | `feature` | A fully specified **story**: its card offers Plan / Start, and Claude can build it (`/build`) |
| `ready-for-human` | `feature` + `needs-human` | A story a person builds (on its branch after Start) |
| `wontfix` | `wontfix` | Will not be actioned |

Specs from `to-spec` get `spec` (not `feature`): they are split into stories, never built directly.
Never apply `start`, `ai:*`, `test`, `ready`, `review:*`, `ui:*`, `release`, `blocked` or `in-sprint`: the pipeline owns them.
