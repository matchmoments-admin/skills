# Capacity: sizing the pipeline for the team

Ask about load in Phase 0 (decision 14). Then run `node pipeline/bin/pipe.mjs org capacity --devs <N>` once the Dev Hub is
connected, and again whenever the team or the UI suite grows. It reads the Dev Hub's scratch-org allowances and the UI
specs, and prints:
- stories in flight;
- the staging regression's time;
- a month's Actions and Claude cost;
- advice.

Its constants are measured on a real run (`MEASURED` in `pipeline/src/capacity.mjs`). Re-measure them on the customer's
org after the tracer story.

Flags: `--devs`, `--stories` (per sprint), `--sprint-days`, `--in-flight`, `--test-seconds`, `--in-use` (active scratch
orgs held by other projects), `--uat-sandbox`.

## What limits this pipeline, in order

| Limit | Where it bites | Developer Edition Dev Hub (a lab) | Enterprise company |
|---|---|---|---|
| **Active scratch orgs** | stories in flight: one org each, plus staging (and UAT's stand-in at release) | 3: one story at a time beside staging | Enterprise 40, Unlimited and Performance 100 (more can be bought) |
| **Daily scratch orgs** | new stories and rebuilds a day | 6 | 80 / 200 |
| **The staging regression** | one job, one browser: every Apex, Flow and UI test on the release branch | about 25 min with 38 UI tests | grows about 1.5 min with every story's spec |
| **Runner minutes** | everything | a small budget with a hard stop | billed on the company's plan |
| **Salesforce API and test queue** | deploys and test runs in production and the shared orgs | rarely | one deploy at a time per org; a daily cap on Apex test classes queued; `RunRelevantTests` keeps validation short |
| **Claude** | AI steps | a personal subscription token | an organisation API key; about $2 to $2.50 a story with every switch on |

## How an enterprise org differs, and what to set

- **Move the Dev Hub to an Enterprise or Unlimited org** before adding people. On a Developer Edition Dev Hub, the second
  story waits for a slot (`waiting:org`). Decide early, because the Dev Hub holds the connected app, the shape and the
  snapshots.
- **UAT on a sandbox:** `SF_UAT_USERNAME` (and `SF_UAT_LOGIN_URL`). This frees a scratch org at every release, and
  testers keep their sandbox logins.
- **Keep the UI suite lean.** Staging runs every spec, one browser at a time: a Lightning page is CPU-heavy, and more
  browsers on one runner time out (#268). Keep each story's spec to its acceptance criteria, and retire specs whose
  behaviour is covered by a newer story. `pipe org capacity` warns past 20 minutes.
- **Why not split the UI suite across runners (sharding)?** It was built and removed (#271). The shards hold the staging
  org across several jobs, which a re-run or a long runner queue can break. The persona specs, which share the org's
  few user licences, cap the gain at about 8 minutes. And it costs a runner setup per shard. One job is simpler and
  cheaper.
- **Secrets and people:** the company's vault through OIDC, required reviewers on the `production` environment, and
  `APPROVERS` as a team ([`enterprise.md`](enterprise.md)).

## Scale path

| Team | Dev Hub | UAT | Notes |
|---|---|---|---|
| 1 to 2 people (a lab) | Developer Edition | scratch stand-in | defaults |
| 3 to 8 | Enterprise | sandbox | `SF_UAT_USERNAME`; watch the staging time |
| 8 to 30 | Enterprise or Unlimited | sandbox | `ORG_RESERVE` so staging always has a slot |
| 30 or more, several trains | Unlimited | sandbox per train | one staging org and `sprint:` target per train (gotchas, *Scaling*) |

## Measured on the lab (13 Oct 2026)

| | |
|---|---|
| Staging regression, one 2-core runner | about 25 min: deploy 3.5, Apex and Flow 2.5, 35 UI tests 18 |
| The same with 3 browsers on one runner | failed: Lightning pages timed out (#268) |
| UAT's org built during staging | ready 68 s after staging, against 14 min |
| A story's Actions minutes when nothing fails | about 42 (start 9, build 8, CI 8, review 3, UI test 12, gate 2) |
| A release besides staging | about 15 min |
| Claude per story, every switch on | about $2.50 |
