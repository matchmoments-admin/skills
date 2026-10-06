# Buildkite with Bitbucket

## Triggers and context

- Bitbucket Cloud/Server webhooks start Buildkite builds; enable **Build pull requests** in the pipeline's
  Bitbucket settings. Buildkite reports the step back to Bitbucket as a commit status, so Bitbucket's merge checks
  can require it ("Minimum successful builds").
- Variables the script uses: `BUILDKITE_PULL_REQUEST_BASE_BRANCH` (the base: diffed as `origin/<base>`),
  `BUILDKITE_BRANCH`, `BUILDKITE_BUILD_NUMBER`, `BUILDKITE_PIPELINE_SLUG` (the org alias and description
  `ci:<pipeline>:<build>:<branch>`). Outside a PR build, set `BASE_REF` (e.g. `origin/main`).
- The checkout must have the base branch's history: Buildkite's default clone is fine; with shallow clones set
  `BUILDKITE_GIT_CLONE_FLAGS=--filter=blob:none` or fetch the base (`git fetch origin <base>` runs inside the script).

## Agents

- Needs `sf` (`npm install --global @salesforce/cli`), `jq`, `git`, bash. Bake the CLI into the agent image: a fresh
  install every build costs a minute or more. Disable CLI auto-update (`SF_AUTOUPDATE_DISABLE=true`, set by the script).
- Put the step on a queue whose agents may reach `login.salesforce.com` and the company's My Domain.

## Concurrency and allowance

- `concurrency_group: salesforce/scratch-orgs` with `concurrency: N`, N at most the Dev Hub's active allowance
  minus what developers use by hand. Builds beyond N wait instead of failing.
- No allowance left: the script exits `NO_ORG_EXIT` (the example uses 3) and the step `soft_fail`s on it, with an
  annotation, so a busy day does not turn builds red.

## Secrets

- `SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME`, `SF_DEVHUB_JWT_KEY` via Buildkite Secrets (`buildkite-agent secret
  get`) or the agent's `environment` hook. The script writes the key to a 600-permission temp file and removes it.
- Rotate the certificate before it expires (`make-ci-cert.sh` makes a 2-year one): new cert on the connected app,
  new secret, old cert removed.

## Visibility

- The step log prints the selected tests, each failure, and the summary lines; `buildkite-agent annotate` adds a
  pass/fail box to the build page.
- `artifact_paths: test-results/**/*-junit.xml` keeps the reports; the `test-collector` plugin sends them to
  Buildkite Test Engine for per-test history, flaky-test detection and timings.
- Salesforce side: Setup › Apex Test Execution shows a scratch org's runs while they happen (open the org with
  `sf org open -o ci-<pipeline>-<build>` from a machine logged in to the Dev Hub).
