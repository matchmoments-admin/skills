# Architecture

Workflows are thin adapters. The decisions live in `pipeline/` (Node, no dependencies), called through one interface: `node pipeline/bin/pipe.mjs <command>`. The domain words are defined in the template's `GLOSSARY.md`.

## Modules

| Module | Interface (pipe …) | Owns |
| --- | --- | --- |
| `conventions` | `context [--key K] [--branch B] [--labels …]` | Story key ↔ branch (`issue-12`, `LIFE-123`), sprint ↔ `release/<sprint>` ↔ milestone, org identity (alias, registry Description, definition, lifetime, lock key), base branch, labels, required check names, coverage minimum |
| `org` | `org ensure\|attach\|remove <target>`, `prepare <alias>`, `deploy`, `temp`, `sweep`, `limits` | Finding orgs via `ScratchOrgInfo`, JWT login, create-or-adopt, user prep + permission sets, deletion |
| `gate` | `gate evaluate <pr>`, `gate nudge <pr>`, `gate checks [ref]` | Route (feature, hotfix, release, back-merge), required checks (latest run by exact name), verdict freshness, human sign-off, merge method, follow-ups |
| `closeout` | `closeout plan\|run --tag` | Which sprint shipped (its release PR merged), shipped vs carried stories, hotfix stories, orgs and branch to delete |
| `tracker` | `tracker story\|comment\|open-sprint`, `release notes` | GitHub Issues adapter and Jira adapter behind one interface (`TRACKER=jira`) |
| `verdict` | `verdict instructions\|review\|rounds` | The AI output formats: the instruction and its parser in one place |
| `io` | — | The only module that runs `gh`, `sf`, `git`; injected so tests use fakes |

Tests (`npm run test:pipeline`) replay recorded PR facts as fixtures. Add a fixture whenever a gate decides wrongly in a real run.

## Workflows

| Workflow | Trigger | Does |
| --- | --- | --- |
| `sprint-start` | Run workflow (sprint name) | Tracker sprint, `release/<sprint>` from a green `main`, staging org |
| `issue-start` | label `start` | Story branch from base (release branch, or `main` with `hotfix`), story org |
| `ai-implement` | label `ai:implement` | Claude builds in the story org; workflow guarantees push + PR |
| `ci` | PR, push to `main`, dispatch | Static checks; delta deploy + all Apex tests in the branch's org (no org when `force-app` is unchanged) |
| `ai-review` | PR opened, `ai:review`, after a fix | Review → `review:pass` / `review:changes` |
| `ai-fix` | label `ai:fix` | Fixes blockers/majors from collected feedback; 2 rounds max |
| `ui-test` | label `ai:test` | Playwright spec in the story org → `ui:pass` / `ui:fail` from running the committed spec |
| `gate` | approval, `ready`, dispatch | Decide → (validate against production) → merge → follow-ups |
| `staging-deploy` | gate, after a story merges | Release branch into staging; full Apex + UI regression (`staging regression` check) |
| `release-cut` | Run workflow | Release PR with notes |
| `release` | gate, after `main` changes | Quick-deploy the validation, smoke, refresh shape, tag, close out, start back-merge |
| `back-merge` | release | PR from `main` into an open release branch; merges itself on green CI |
| `scratch-janitor`, `org-shape-refresh` | weekly | Delete orgs of closed stories; re-capture production's shape |

Composite actions: `sf-auth` (CLI + JWT login; outputs `key-file`), `pipeline-identity` (App token or fallback; authenticated checkout), `claude-agent` (role prompt + verdict rules + transcript).

## Concurrency lanes

Job-level only, so skipped jobs never hold a slot:

- `scratch-orgs`: jobs that create or sweep orgs.
- `org-issue-N`: everything using one story's org (ai-implement, ci, ai-fix, ui-test).
- `org-staging`: staging-deploy and CI of the release candidate.
- `gate-<pr>`: one gate decision per PR.
- `release`: production.

## Gate routes

| Route | When | Needs | Merge | Then |
| --- | --- | --- | --- | --- |
| feature | story → `release/*` | CI, fresh `review:pass` + `ui:pass`, sign-off | squash | delete story org, staging |
| hotfix | story → `main` | same + approval + production validation | squash | delete story org, release |
| release | `release/*` → `main` | CI + `staging regression` + approval + production validation | merge commit | release |
| back-merge | `backmerge-*` → `release/*` | CI | merge commit | staging |

## AI switches

Every AI step is optional; the gate's `requiredVerdicts()` decides what a PR needs from `aiFeatures(env)` (both in
`pipeline/src/`). Workflows pass `vars.AI_*` as env and use them in job `if:`; nothing else reads them.

| Switch | Replaces | Gate effect |
| --- | --- | --- |
| `AI_IMPLEMENT` | a person building the story | none |
| `AI_REVIEW` | nothing (the approver reviews) | `pipeline/ai-review` required |
| `AI_FIX` | a person pushing fixes | none |
| `AI_UI_TEST` | a person writing the spec | `pipeline/ui-test` required for UI-facing PRs (otherwise only when a story spec is committed) |
| `AI_AUTO_CHAIN` | a person adding `ai:fix` / `ai:test` | none |
| `UI_EVIDENCE` (not AI) | a reviewer logging in to look | none: a passing UI test posts its `evidence()` screenshots (WebP, ≤100 KB, ≤6) as one comment on the story, linked from the card; stored on the `evidence` branch (latest passing commit, open stories only; the janitor squashes it). Off = nothing taken, stored or posted |
| `AI_TRIAGE` | nothing | Jev may skip a low-risk review (posts success "not needed") and re-run a flaky UI test once |

A failed verdict always blocks. Models per role live in `verdict.mjs` `MODELS` (Haiku for review and UI test,
Sonnet for build and fix); `AI_MODEL` overrides. The label `test` runs a committed spec with no AI.

## Tests and production validation

- `pipeline/src/tests.mjs` is the one test-run module: `selectTests` (pure: a story runs what its change needs; any
  non-code metadata, deletion or untested code runs everything), `runTests` (async Apex run polled through
  ApexTestQueueItem / ApexTestResult, then Flow tests by name; `onProgress` each poll), `verdict` (story runs gate the
  changed classes' own coverage, full runs gate org-wide), `checkOutput` / `summaryMarkdown` (pure). `pipe tests run`
  posts the live **Salesforce tests** check on the commit and refreshes the story card. CI uses it per story (release
  PRs and back-merges run all); staging runs all.
- `pipeline/src/production.mjs`: check-only deploy, async, polled with `sf project deploy report` (components and
  tests); `RunRelevantTests` with a fallback to every test class (at start, or when the result says the level was
  refused); `pipe prod validate` posts the live **Production validation** check and prints only the job id.
  `scripts/ci/validate-prod.sh` is a wrapper; `PROD_TEST_LEVEL` overrides.
- UAT (`UAT_ENABLED`): `uat-deploy` puts the release head in UAT (sandbox via `SF_UAT_USERNAME`, else scratch
  `uat:<sprint>`); `pipeline/uat` is a verdict the gate requires on the release route; `/uat-pass`, `/uat-fail <why>`.
