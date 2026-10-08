# Issue tracker

Read by the engineering skills (`to-spec`, `to-tickets`, `triage`, `wayfinder`) and by people. Issues live in **GitHub
Issues** on `__OWNER__/sf-lifecycle-labs` (Jira can stand in: see `docs/handbook.md`). Use the `gh` CLI. Pull requests
are not a request surface: work starts from an issue.

## Two kinds of issue

| Kind | Made by | Title | Label | What happens next |
| --- | --- | --- | --- | --- |
| **Spec** (an epic: the why and the whole shape) | the **New spec** form, then Claude (`/spec`, the to-spec skill adapted) | `Spec: <name>` | `spec` | **Make it a story** (`/story`) makes its one story (agents on it read the whole spec); the spec itself is never built or closed by the pipeline |
| **Story** (one deliverable slice) | **Make it a story** on a spec, the **New story** form, or a person | `Story: <name>` | `feature` | its card offers Plan / Start; the pipeline builds, tests, signs off and ships it, and closes it when it is in production |

## The story body (the pipeline reads these headings; keep them exactly)

```markdown
### Summary
Who wants what, and why (one or two sentences, from the user's side).

### Acceptance criteria
- One line per testable outcome, in the user's words: what a tester sees or what the record holds afterwards.

### Access
Who may see or change it (the permission set to add or extend), the org-wide default of each object it touches if it
matters, and whether automation runs as the user or the system. "No change" is a valid answer.

### Where to see it in the UI
Where a person goes to see it work (the UI test follows this).

### Out of scope
What this story does not do. Blocked by #N (if another story must ship first).
```

Agents read `### Acceptance criteria` bullets as the scope, the build plan and the review hold the work to them, and Jev
checks each is testable. A story that needs another first says `Blocked by #N` in Out of scope and uses GitHub's native
"blocked by" relationship.
