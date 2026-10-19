# Buildkite wiring

The CLI is CI-neutral. This file is the Buildkite layer: `assets/buildkite/pipeline.feature-org.yml` and
`scratch-org-step.sh`. For Bitbucket triggers, agents and secrets, see salesforce-scratch-org-tests'
`references/buildkite-bitbucket.md`.

## Files in the target repo

- `scripts/scratch-org/`: `scratch-org.mjs`, `engine/` and `scratch-org-step.sh`, copied from this skill.
- `.buildkite/pipeline.feature-org.yml`: uploaded by the pipeline's first step, so `$BUILDKITE_BRANCH` is
  interpolated into the concurrency group.
- `config/`, `baseline/`, `data/seed/` on the default branch.

## Picking the trigger (Phase 0 decides)

| The team works... | Use |
| --- | --- |
| On one branch per ticket, pushing often, and the Dev Hub has room | **A**: every push brings the org up to date |
| On many short branches, or the Dev Hub is tight | **B**: a `block` step, "Create or update my org" |
| Mostly in Setup (admins, declarative work) | A or B, plus the **Setup changes** block step |

Agents aren't involved either way. The org exists for people to build and test in.

## How it fits together

- **One job per org:** every step that touches the branch's org has `concurrency: 1` and
  `concurrency_group: "scratch-org/$BUILDKITE_BRANCH"`. Jobs queue rather than cancel.
- **Exit code 3** means no capacity. The step `soft_fail`s on it and annotates a warning.
- **Annotations:** `ready` posts the org, what it holds, and how to get in. `login` posts the masked email. `changes`
  posts what was pulled. None of them carries a URL or a password.
- **Block steps with fields:** `login-email` and `login-admin` are read with `buildkite-agent meta-data get`.
  `BUILDKITE_UNBLOCKER` and `BUILDKITE_UNBLOCKER_EMAIL` name who clicked, and they're the authors of the Setup-changes
  commit.
- **Trusted config:** the step script runs `git fetch origin <default>` and
  `git worktree add --detach <tmp>/trusted origin/<default>`, then exports `CONFIG_ROOT`. The agent needs read access to
  the default branch (it already has the repo).
- **Pushing:** the Setup-changes step and the baseline step push. The agent's git credentials need write access, or
  give those two steps a queue whose agents have it.

## Scheduled builds (Pipeline settings, Schedules)

| Schedule | Env | Cadence |
| --- | --- | --- |
| sweep | `SCRATCH_JOB=sweep` | Every 6 hours. Deletes orgs whose branch is gone, and CI orgs older than 2 hours. |
| baseline | `SCRATCH_JOB=baseline` | Nightly, and trigger it after each production release. |
| snapshot (optional) | `SCRATCH_JOB=snapshot` | Daily at most. Each run costs one daily org. It's worth it once new orgs are frequent: about 8 minutes from a snapshot against 15 to 40 from the shape. |

## The drift PR (`BASELINE_PR_COMMAND`)

The baseline step pushes branch `baseline-refresh`, then runs this command with `drift.md` in the working directory.
Examples:

- **GitHub:** `gh pr create --head baseline-refresh --title "Production baseline: drift" --body-file drift.md || gh pr edit baseline-refresh --body-file drift.md`
- **Bitbucket Cloud:** a `curl` to `POST /2.0/repositories/{workspace}/{repo}/pullrequests` with a repository access
  token from Buildkite Secrets (source `baseline-refresh`, destination the default branch, description from
  `drift.md`).

## Agents

The agents need Node 20 or later, the `sf` CLI baked into the image, `git` and `jq`, and network access to
`login.salesforce.com` and the company's My Domain. A new org's first `ready` takes 15 to 40 minutes, so give the
step a long timeout (the asset uses 75 minutes).
