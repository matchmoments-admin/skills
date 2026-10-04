# Running the pipeline on Buildkite

The pipeline's logic is one Node CLI (`pipeline/bin/pipe.mjs`) plus two shell scripts; only the wiring is GitHub
Actions. If the company already runs Buildkite (agents in its own cloud, one view of every build), keep GitHub as
the system of record for pull requests, approvals, the story card and branch rules, and run the Salesforce work on
Buildkite agents.

## What maps to what

| GitHub Actions (template) | Buildkite |
| --- | --- |
| `ci.yml` jobs `static`, `apex` | a pipeline triggered by GitHub PR builds; steps run `npm ci`, `pipe org attach`, delta deploy, `coverage-gate.sh`, `flow-tests.sh` |
| required checks | Buildkite reports a commit status per pipeline; require that status in the GitHub ruleset |
| `gate.yml` ship job | a pipeline with a **block step** ("Ship to production?") before `validate-prod.sh` and the quick deploy |
| environment `production` | agents with the production credentials in their own queue; only the release pipeline targets that queue |
| `workflow_dispatch` buttons | "New build" with **input fields** on a block step (sprint name, release tag) |
| labels as buttons (`start`, `ai:*`) | keep these on GitHub Actions (they are cheap, event-driven and need the App); or a GitHub webhook to Buildkite with `if: build.pull_request.labels includes "..."` |
| job graph per workflow | one pipeline graph per build, with dynamic steps uploaded by `pipe` itself |

## Trade-offs (2026 list prices)

- **Cost.** GitHub Team includes 3,000 Actions minutes a month, then Linux is $0.006 a minute; this pipeline uses
  about 20 minutes a story. Buildkite Pro is $30 per active user a month (unlimited build minutes, 4,000 hosted
  vCPU-minutes included) plus compute: hosted Linux small is $0.008 a minute, or free on the company's own agents.
  For a small Salesforce team on GitHub alone, Actions is cheaper; if Buildkite is already licensed, the
  marginal cost is the agents.
- **Buildkite is better at:** one graph for the whole release, block steps with input fields (an approval with a
  value), agents inside the company's network (Salesforce credentials never leave it), dynamic pipelines, test
  analytics, unlimited concurrency.
- **GitHub Actions is better at:** native pull request events, labels and reviews as triggers, the pipeline App
  identity, the Claude GitHub Action, no second system to administer.
- Required reviewers on GitHub environments (the native "Continue" button) need GitHub Enterprise for private
  repositories; on Team the approval is the pull request review.
