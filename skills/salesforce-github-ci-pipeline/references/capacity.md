# Capacity: sizing the pipeline for the team, and scaling it

Ask about load in Phase 0 (decision 14). Then run `node pipeline/bin/pipe.mjs org capacity --devs <N>` once the Dev Hub is
connected, and again whenever the team or the test suite grows. It reads the Dev Hub's scratch-org allowances and the UI
specs, and prints:
- stories in flight;
- the staging UI regression's time;
- the settings to use (`UI_SHARDS`, `UI_RUNNER`, `UI_WORKERS`);
- a month's Actions and Claude cost.

Its constants are measured on a real run (`MEASURED` in `pipeline/src/capacity.mjs`). Re-measure them on the customer's
org after the tracer story.

Flags: `--devs`, `--stories` (per sprint), `--sprint-days`, `--in-flight`, `--cores` (runner), `--target` (minutes for
the UI regression), `--test-seconds`, `--in-use` (active scratch orgs held by other projects).

## What limits this pipeline, in order

| Limit | Where it bites | Developer Edition Dev Hub (a lab) | Enterprise company |
|---|---|---|---|
| **Active scratch orgs** | stories in flight: one org each, plus staging (and UAT's stand-in at release) | 3: one story at a time beside staging | Enterprise 40, Unlimited and Performance 100 (more can be bought) |
| **Daily scratch orgs** | new stories and rebuilds a day | 6 | 80 / 200 |
| **User licences in the test org** | persona UI specs (`loginAs`) run one at a time in a scratch org, because they share its few Salesforce licences | a handful | a Full or Partial Copy sandbox has production's licences, so persona specs can run in parallel |
| **CPU per runner** | browsers per runner: a Lightning page is CPU-heavy, and 3 browsers on 2 cores timed out | 2-core runners | larger runners (4 to 64 cores, Team or Enterprise plan) or self-hosted |
| **Runner minutes** | everything | a small budget with a hard stop | billed on the company's plan, or free on self-hosted runners |
| **Salesforce API and test queue** | deploys and test runs in production and the shared orgs | rarely | one deploy at a time per org; a daily cap on Apex test classes queued; daily API requests per licence. Large orgs spend most of a release in `RunLocalTests`, so `RunRelevantTests` matters |
| **Claude** | AI steps | a personal subscription token | an organisation API key with its own rate limits; about $2 to $2.50 a story with every switch on |

## How an enterprise org differs, and what to set

- **Move the Dev Hub to an Enterprise or Unlimited org** before adding people. On a Developer Edition Dev Hub, the
  second story waits for a slot (`waiting:org`). Decide early, because the Dev Hub holds the connected app, the shape
  and the snapshots.
- **UAT on a sandbox:** `SF_UAT_USERNAME` (and `SF_UAT_LOGIN_URL`). This frees a scratch org at every release, and
  testers keep their sandbox logins.
- **Staging on a Full or Partial Copy sandbox** is the next step (not built yet). It brings production's licences
  (persona specs in parallel) and real data volume, at the cost of refresh windows: Partial Copy every 5 days, Full every
  29. Until then, staging is a scratch org with `VOLUME_RECORDS` synthetic data.
- **Runners:** for speed, set `UI_SHARDS` first (more runners, each with its own CPUs). Then a larger runner, through
  `UI_RUNNER` (a label) and `UI_WORKERS` (half its cores). Self-hosted runners (the company's own Kubernetes or VMs)
  remove minute billing. They need Chromium's system libraries, and they must not keep a Salesforce key between jobs:
  use ephemeral runners.
- **Concurrency:** GitHub runs about 20 concurrent jobs on Free, 60 on Team and 500 on Enterprise (standard runners).
  With shards, each staging run takes `UI_SHARDS` + 2 of them.
- **Apex at scale:** production validation uses `RunRelevantTests` (falling back to every class). Story CI runs only the
  change's tests. The staging regression runs everything, so a 3,000-class org needs the 60-minute cap and a quiet
  staging lane (`ORG_RESERVE`).
- **Secrets and people:** the company's vault through OIDC, required reviewers on the `production` environment, and
  `APPROVERS` as a team ([`enterprise.md`](enterprise.md)).

## Scale path (what to turn on, in order)

| Team | Dev Hub | UAT | UI regression | Settings |
|---|---|---|---|---|
| 1 to 2 people (a lab) | Developer Edition | scratch stand-in | one runner | defaults |
| 3 to 8 | Enterprise | sandbox | 2 to 3 shards | `UI_SHARDS=3`, `SF_UAT_USERNAME` |
| 8 to 30 | Enterprise or Unlimited | sandbox | 3 to 6 shards on 4-core runners | `UI_SHARDS`, `UI_RUNNER`, `UI_WORKERS=2` |
| 30 or more, several trains | Unlimited | sandbox per train | shards, self-hosted runners | one staging org and `sprint:` target per train (gotchas, *Scaling*) |

## The UI regression grows with every story

Each story adds 2 or 3 UI tests, so the staging regression grows by 1 to 3 minutes per story, every release. Shards keep
the wall time down; the billed minutes still grow.

When it passes about 30 minutes of billed time per release, consider running only the specs whose story touched what
the release changes (plus a smoke set) in staging, and the full regression nightly. That trades some assurance for
speed, so the team decides.

## Measured on the lab (13 Oct 2026)

| | |
|---|---|
| UI regression on one 2-core runner | 35 tests in 18 min |
| The same on 3 browsers | failed: Lightning pages timed out (#268) |
| UAT's org built during staging | ready 68 s after staging, against 14 min |
| A story's Actions minutes when nothing fails | about 42 (start 9, build 8, CI 8, review 3, UI test 12, gate 2) |
| A release besides staging | about 15 min |
| Claude per story, every switch on | about $2.50 |
