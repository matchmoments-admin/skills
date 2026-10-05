---
name: salesforce-scratch-org-tests
description: Add a throwaway Salesforce scratch org to an existing CI build (Buildkite, Bitbucket Pipelines, GitHub Actions or any shell CI) that creates an org per build, deploys the branch, runs only the Apex and Flow tests relevant to the change, and always deletes the org. Use when a team already has CI and the sf CLI but no scratch orgs, wants feature-level tests without a shared sandbox, or asks to "spin up a scratch org per PR", "run relevant tests", or clean up orphaned scratch orgs. Adds one step; does not change the rest of the build.
---

# Salesforce scratch-org tests in an existing build

One script, one step: `scripts/scratch/scratch-ci.sh run` creates a scratch org tagged with the build, deploys the
branch, runs the relevant tests (JUnit out), and deletes the org on every exit, including a cancelled build.
`scratch-ci.sh sweep` deletes CI orgs a killed agent left behind. Bash with `sf`, `jq`, `git` and Node (which `sf`
needs anyway); no other dependencies. Test selection is the GitHub pipeline's own tested engine
([`scripts/engine/tests.mjs`](scripts/engine/tests.mjs), a verbatim copy of its `pipeline/src/tests.mjs`), so a fix to
how tests are chosen lands in both skills. Proven end to end against a real Dev Hub: 13 of 27 Apex tests and 1 Flow test selected for a Flow
change, org created, deployed, passed, deleted, in about 6 minutes.

For the full GitHub delivery pipeline (story orgs, AI, gates, releases), use `salesforce-github-ci-pipeline`
instead. This skill is the scratch-org testing piece on its own.

## Phase 0: Decisions

Ask, then write the answers in the repo's README or CI docs:

1. **Dev Hub.** Production with Dev Hub enabled (Setup › Dev Hub; one-way). Allowance: Enterprise 40 active / 80 a
   day, Unlimited and Performance 100 / 200, Developer Edition 3 / 6. Each concurrent build holds one active org.
2. **CI user.** A dedicated integration user (API Only) in production, so the JWT login is not a person.
3. **Which builds.** Pull requests only (usual), or also feature branches. Default branch builds rarely need it.
4. **Test scope.** `relevant` (default: the tests for what changed; any non-code metadata change runs everything)
   or `all` (every local test, slower, simplest).
5. **Org shape.** `config/project-scratch-def.json` with `sourceOrg` (Org Shape: production's edition, features and
   settings) or a hand-written definition. Managed packages production has go in `config/packages.json`.
6. **Production-only folders.** Folders that must not go to a scratch org (a CI connected app, org-wide settings):
   list the rest in `SOURCE_DIRS`.

Done when: all six are written down.

## Phase 1: Salesforce

1. **CI certificate and connected app:** [`scripts/make-ci-cert.sh`](scripts/make-ci-cert.sh) `<repo-dir> <email>`
   writes `secrets/ci.key` (gitignored), the certificate, and a connected app plus permission set under
   `devhub-setup/`. Deploy that folder to production once, then **assign** the `Pipeline_CI` permission set to the
   CI user (the assignment pre-authorises the app; it is data, not metadata).
2. **Org Shape (recommended):** Setup › Org Shape › enable, allow the Dev Hub to use it (production's
   **15-character** org ID), `sf org create shape -o <prod>`. Put the ID in the definition as `sourceOrg`.
3. **Prove it locally:** `sf org login jwt --client-id <key> --jwt-key-file secrets/ci.key --username <ci user>
   --instance-url https://login.salesforce.com`, then create one org from the definition and deploy (delete it).

Done when: a scratch org from the definition deploys the source with no errors.

## Phase 2: The step

1. Copy [`scripts/`](scripts) to the repo as `scripts/scratch/` (`scratch-ci.sh`, `select-tests.sh`, and `engine/`).
2. Add the step from [`assets/buildkite/pipeline.scratch.yml`](assets/buildkite/pipeline.scratch.yml) to the
   pipeline (Buildkite). Other CIs: one job that runs `scripts/scratch/scratch-ci.sh run` with the same env, keeps
   `test-results/` as artifacts and test reports, and never runs more jobs at once than the active allowance.
3. Secrets (never in the repo or the log): `SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME`, `SF_DEVHUB_JWT_KEY`
   (PEM contents). Buildkite: Buildkite Secrets, or the agent `environment` hook from the company's secret store.
4. Optional: [`assets/buildkite/hooks/pre-exit`](assets/buildkite/hooks/pre-exit) as `.buildkite/hooks/pre-exit`,
   and a scheduled build running `scratch-ci.sh sweep 3`.

Done when: the pipeline YAML validates and the secrets exist (names only).

## Phase 3: Prove it

Open a pull request that changes one Apex class (or one Flow with a Flow test). The step should print the selected
tests, create `ci-<pipeline>-<build>`, deploy, run them, pass, and delete the org. Then cancel a run midway and
check the org is gone (EXIT trap or pre-exit hook), and change a field to see `all` selected.

Done when: `sf data query -o <prod> -q "SELECT Description FROM ScratchOrgInfo WHERE Status='Active'"` shows no
`ci:` orgs after the builds finish, and the test report shows the JUnit results.

## How it decides what to test

[`scripts/select-tests.sh`](scripts/select-tests.sh) `<base>`: a changed test class runs itself; a changed class
runs every test class that names it; a changed trigger or record-triggered Flow runs the test classes that name its
object, plus the Flow's own Flow tests; anything else (fields, objects, layouts, permission sets, validation rules),
any deletion, or code no test names runs **all** local tests (and every Flow test). No Salesforce change: no org at
all. `select-tests.sh` runs [`scripts/engine/select.mjs`](scripts/engine/select.mjs) over the pipeline's
`selectTests()`; do not edit `engine/tests.mjs` here: change it in the pipeline and run its `scripts/skills-sync.sh`.

## References

- [`references/buildkite-bitbucket.md`](references/buildkite-bitbucket.md): Buildkite and Bitbucket specifics.
- [`references/gotchas.md`](references/gotchas.md): every failure this hit, and the fix.
- Production deploys are a separate decision: `RunRelevantTests` (Salesforce beta, Spring '26) lets the platform
  pick relevant tests for production; `RunLocalTests` is the safe default.
