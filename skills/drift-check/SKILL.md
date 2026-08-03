---
name: drift-check
description: Verify every factual claim in a repo's CLAUDE.md (and directory-scoped CLAUDE.md files) against the actual repository — commands, paths, conventions, links. Fixes drift via a PR when it's substantial; reports it when it's minor. Never modifies code.
disable-model-invocation: true
argument-hint: "[repo-dir]"
---

# Drift check — keep the steering file true

Steering files rot: commands change, directories move, rules outlive the
incident that motivated them. A steering file that asserts something false is
worse than no steering file. This skill audits it against reality.

## Step 1 — Gather the steering surface

Target repo = the argument, or the current working directory's repo root.
Read, in full:

- Root `CLAUDE.md` (the master) and `AGENTS.md` (should be a short pointer).
- Every directory-scoped `CLAUDE.md` (`git ls-files '*CLAUDE.md'` plus a glob
  for untracked ones).
- Any `.claude/rules/*.md`.

## Step 2 — Verify every factual claim

Go claim by claim. A claim is anything the file asserts about the repo that
can be checked. For each, find primary evidence:

- **Commands** — every documented command must exist in `package.json`
  scripts (or Makefile/pyproject equivalent) with matching flags. Also check
  the reverse: important scripts (test, typecheck, lint, deploy) that exist
  but are undocumented or documented with stale names.
- **Paths and structure** — every directory, file, and glob mentioned must
  exist. Project-structure trees must match the actual tree.
- **Links** — every relative markdown link must resolve to an existing file.
- **Conventions** — spot-check stated conventions against 3-5 recently
  modified source files (e.g. "all handlers live in X", import patterns,
  naming rules). Recent files, not old ones — drift shows up at the edge.
- **Inventories** — tables of env vars, workflows, agents, scoped guides:
  compare against the actual `.github/workflows/`, `.claude/`, etc.

Classify each finding: **drifted** (the claim is now false — cite the
file:line that contradicts it) or **unverifiable** (can't be checked from the
repo; note it, don't count it as drift).

Read-only throughout this step. **Never modify code to make a claim true.**

## Step 3 — Act on the result

**3 or more drifted claims** → fix the file, not the code:

```bash
git fetch origin && git worktree add /tmp/drift-<repo>-<date> -b drift/<YYYY-MM-DD> origin/main
```

In the worktree, correct **only the drifted lines** — no rewrites, no style
changes, no reorganizing. Commit as `docs(steering): fix <N> drifted claims`,
push, and `gh pr create` with a body listing each fix as
`claim → reality (evidence: file:line)`. Remove the worktree. Do not merge.

**Fewer than 3** → no PR. Report the findings (including zero-drift: say what
you verified). If the repo has a `memory/` directory, append a one-line entry
to the Gotchas section of `memory/MEMORY.md` only when a finding is a genuine
trap for future sessions, tagged `[src: <session-id>]` — routine "all clean"
results don't go in memory.

## Rules of the loop

- NEVER modify source code, tests, or config — steering files only.
- NEVER "fix" a claim by deleting it when the underlying rule may still be
  intentional; flag it as a question in the PR body instead.
- Unverifiable ≠ wrong. Only contradicted claims count toward the PR
  threshold.
- If AGENTS.md has drifted from its pointer role (grown its own content),
  that's a finding — the convention is one master file, pointers elsewhere.
