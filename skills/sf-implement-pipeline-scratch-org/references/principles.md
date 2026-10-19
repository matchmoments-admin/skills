# Principles

Each rule is what sf-lifecycle-labs' pipeline learned building around 200 story orgs. Keep these rules whatever CI you
wire them into; the CI wiring is the part that's free to change.

## The org is production's shape plus the branch

- **Shape:** the scratch definition names production (`sourceOrg`), so features, settings, licences and limits match.
  Salesforce lets a shape age; `create()` refreshes it once when Salesforce says it's outdated, then retries.
- **Packages:** org shape copies settings, not installed packages. `config/packages.json` lists production's managed
  packages (04t ids), installed before the source. A baseline capture reports any production package missing from it.
- **Production baseline:** production's own customisations (fields, layouts, Flows, permission sets, rules...),
  captured into `baseline/`. It's deployed in one deploy with the branch, because each refers to the other. It's never
  a package directory, so nothing can ever ship it to production. Details: `baseline.md`.
- **The branch:** every package directory of the feature branch (`sourceDirs()`).

## One owner

A component lives in `baseline/` or in the source folders, never both. Capture drops from `baseline/` everything the
source holds, matched by metadata identity (`classes/A.cls`), whatever the folder layout. To change something
production has, retrieve it into the branch. From then on the branch owns it, and the next capture leaves it out.
Without this rule, the two copies drift apart silently.

## Trusted config

The org's shape, packages, baseline and seed come from the **default branch**, checked out beside the build
(`CONFIG_ROOT`). Only the source comes from the feature branch. A branch can propose a change to `config/` or the
seed in its PR, but it can't use that change to build its own org before review.

## Idempotent, marked ready

`ready()` is the only way an org becomes usable, and it can be repeated:

- It finds the branch's org by its Dev Hub description, or creates it.
- It finishes whatever a previous run left half done: packages already installed are skipped, and seeds are guarded
  by marker records.
- At the very end it writes the **ready marker** (`pipeline: ready <commit> b<baseline> s<seed>`) to the org admin's
  Title.

A run that died leaves no marker, so the next run finishes the org instead of trusting it. A push that changes no
deployable files only re-marks the org (`sameSourceGit`).

## One job per org

Two jobs deploying into one org corrupt each other: a half-applied deploy, or source tracking racing. On Buildkite,
`concurrency_group: scratch-org/<branch>` with `concurrency: 1` queues them. sf-lifecycle-labs uses a git-ref lock
instead (`refs/locks/org-<branch>`), because GitHub Actions groups cancel rather than queue.

## Soft baseline

Some production components can't exist in a scratch org, for example ones needing a feature the shape lacks.

- In **soft** mode (the default), the failed `baseline/` files are dropped, the deploy is retried once, and then the
  branch is deployed alone. The build stays green and the log names what was dropped.
- **strict** fails the build instead.
- A failure in the **branch's own** source never triggers the fallback: that's the developer's error to see.

## People get in by email, never by URL

`login` creates a user (Standard User with every permission set in the source, or System Administrator), then calls
`System.resetPassword`, so Salesforce emails a set-password link. No password, front-door URL or session ID is ever
printed in a log or annotation. CI logs are widely readable and long-lived.

## Capacity is shared

The Dev Hub's active and daily scratch-org allowances are shared with everyone else using it. `ready` checks capacity
first and names who holds the slots. No room is exit code 3, which a step soft-fails on: a busy day is a warning, not
a broken branch. Orgs are deleted through the Dev Hub's `ActiveScratchOrg` record, so no login to the org is needed.
The sweep removes orgs whose branch is gone. With no branch list, it deletes nothing.

## Production is read-only

The only production calls are reads: capture, `org list metadata`, limits, the shape. The seed refuses to load into
the Dev Hub (`org/data.mjs`). Synthetic data only: this skill never copies production records.
