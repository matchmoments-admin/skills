---
name: sf-implement-pipeline-scratch-org
description: Give every Salesforce feature branch its own production-like scratch org, built from a nightly "golden" snapshot of production's shape, packages and customisations, kept current by delta deploys, and run first by a local agent (Claude Code) then by CI (Buildkite first). Use when a team wants a scratch org per branch or ticket that matches production, when production has thousands of components, or when an existing feature-org setup from this skill fails.
---

# Feature orgs at scale: golden snapshot, then per-branch deltas

Version 2. It replaces v1's "one combined deploy of all of production on every push". That design breaks on a large
org: Metadata API caps each deploy at 10,000 files, and the CLI does not split deploys for you. v2 does the expensive
work **once a night** and **clones** it for every branch:

```
NIGHTLY (golden build, ~1–3 h, one org)                     PER BRANCH (minutes)
shape def ─▶ create org ─▶ packages ─▶ tiered baseline   ┌─▶ create from snapshot (first push only)
            (sourceOrg +            deploy loop          │   re-deploy credentials (not in snapshots)
             explicit features)     (--ignore-errors,    │   delta deploy: git diff last-sha..HEAD
                                    fixed point)         │   permsets, ready marker
            ─▶ permsets ─▶ seed (bypass on) ─▶ compile   │
            ─▶ reset tracking ─▶ smoke test ─▶ SNAPSHOT ─┘
```

Two rules hold everywhere:

- **Production is read-only.** The only production calls are reads: shape, list, retrieve, limits.
- **No secret, password or session URL is ever printed.** That covers logs, annotations and the agent's own replies.

`references/principles.md` explains why each rule exists (trusted config, one owner, idempotent ready marker, one job
per org). Read it before changing any of them.

---

## How the pieces fit (what's needed, and what isn't)

| Piece | Gives the org | Needed? |
| --- | --- | --- |
| **Golden definition file** `config/scratch-golden.json` | `sourceOrg` (the shape), plus the features the shape doesn't carry | **Yes.** Nightly build only. |
| **Org Shape** | Production's **boolean** settings and licences, including package licences. Not number or text settings, not metadata, not data, not the packages themselves. One active shape per Dev Hub, and it goes stale each Salesforce release. | **Yes**, behind the golden def only. |
| **Snapshot** | A frozen copy of the golden org: packages, metadata, seed. **Not** connected apps, named credentials or external credentials. Expires after 90 days. | **Yes.** It's what makes feature orgs fast. |
| **Feature definition file** | `{ orgName, snapshot }`. The engine writes it at run time. A snapshot def **can't** hold `features`, `sourceOrg` or `releaseVersion`. | Generated. Nothing goes in git. |
| **`baseline/`** | Production's own customisations, captured nightly | **Yes.** Neither the shape nor any def carries metadata. |
| **Branch source** | The feature's changes | **Yes.** Deployed as a delta. |
| **Seed** `data/seed/` (sf tree JSON) | A few dozen synthetic records | **Yes**, small. Loaded into the golden org only. |
| CSV / Bulk loads | Large flat loads linked by external IDs | **No.** Volume testing belongs in a sandbox. |
| Sandbox templates | Pick the data a Partial Copy *sandbox* copies | **No.** They don't apply to scratch orgs. |

---

## Running this with a local agent

Every phase runs **on a developer machine first**, driven by the local agent. CI only takes over a step once it works
locally. The engine is CI-neutral: the same `node scripts/scratch-org/scratch-org.mjs <command>` runs on a laptop and
on an agent.

**Agent rules** (put these in the repo's `CLAUDE.md` too):

1. Ask the person before anything irreversible or shared: enabling Dev Hub or Org Shape, `sf org create shape` (it
   deactivates the previous shape), creating or deleting a snapshot, deleting any org it didn't create in this
   session, `git push`, and opening PRs.
2. Never run a write command (`deploy`, `data import`, `apex run`, `assign`) against the production alias. The engine
   refuses to seed the Dev Hub. The agent must also check `sf org display -o <alias>` before every write.
3. Never print `sf org display --verbose`, `sfdxAuthUrl`, passwords, or front-door URLs. To get a person into an org,
   use `login`, which sends them an email.
4. Record every measurement from Phase 0 in `docs/scratch-orgs.md` as it's taken. Don't summarise from memory.
5. When a command fails, look the message up in `references/gotchas.md` (and **Gotchas** below) before improvising.

**Local setup:**

```bash
# tools: Node 20+, sf CLI (current), git, jq, the delta plugin
sf plugins install sfdx-git-delta
ulimit -n 65536                                  # large source-tracked projects run out of file handles
sf org login web --alias devhub --set-default-dev-hub --instance-url https://login.salesforce.com   # production = Dev Hub
export DEVHUB_ALIAS=devhub PROD_ALIAS=devhub     # PROD_ALIAS: the org read as production (v2 setting)
# trusted config, as CI does it: the default branch beside the checkout
git fetch origin main && git worktree add --detach ../trusted origin/main && export CONFIG_ROOT=$(cd ../trusted && pwd)
```

On a laptop, `attach()` reuses an alias that is already logged in, so no JWT key is needed locally. `auth` is for CI.

---

## Phase 0: discover, measure, decide

Read the repo and CI first: `.buildkite/`, hooks, agent queues, Node and `sf` versions on the agents, how secrets
arrive (SSM), and `sfdx-project.json` package directories. Note any folder that must never reach a scratch org, plus
branch naming (Jira keys?), the Dev Hub's edition, and the managed packages (`sf package installed list -o devhub`).

Then run the **spikes** against production. They decide every timeout and whether to go ahead at all.

| # | Spike | How | Record |
| --- | --- | --- | --- |
| 1 | Inventory | `sf org list metadata -m <Type> -o devhub --json \| jq '.result \| length'` for each type in `assets/config/baseline.json`, per folder for Report/Dashboard/EmailTemplate | Members per type; estimated **files** (class/trigger = 2, LWC/Aura bundles = per file) |
| 2 | Apex size | Setup → Apex Classes shows "% of Apex used". Or `sf data query --use-tooling-api -o devhub -q "SELECT LengthWithoutComments FROM ApexClass WHERE NamespacePrefix = null" --json \| jq '[.result.records[].LengthWithoutComments] \| add'`, plus ApexTrigger. This total includes test classes, so it's an upper bound. | Non-test characters vs **10 MB**, the scratch maximum without a Support case |
| 3 | Allocations | `sf org list limits -o devhub` | ActiveScratchOrgs, DailyScratchOrgs, ActiveOrgSnapshots, DailyOrgSnapshots; edition |
| 4 | Full retrieve | Batched retrieve (Phase 3), timed | Zip size per batch vs 39 MB; minutes |
| 5 | Tiered deploy | The golden loop (Phase 4) into a fresh shape org | Minutes per tier; failures per pass; passes to fixed point; with synchronous compile on and off |
| 6 | Snapshot | Snapshot the golden org, then `org create scratch` from it ×3 | Snapshot minutes; create minutes; data storage used (vs 200 MB) |
| 7 | Delta deploy | A typical branch's delta | Minutes |
| 8 | SourceMember | Count rows after the baseline lands, before and after `sf project reset tracking` | Rows |

**Go / no-go** (write the result into the decision record):

- **Go** if: the scoped baseline converges to fewer than ~100 excluded components within 4 passes and ~2 hours;
  non-test Apex is ≤ 10 MB (or Support has raised `MaxApexCodeSize`); the golden snapshot is under 200 MB of data;
  and active allocation covers the expected concurrent branches plus 3 (golden org, 2 snapshots' build headroom, CI
  test orgs). Enterprise (40 active) caps you at about 30 concurrent branches. Unlimited/Performance (100) is
  comfortable.
- **No-go** for the full production baseline if it won't converge. Then scope it harder (Phase 3), or give the teams
  that need all of production Developer / Developer Pro sandboxes, which copy all metadata and need no baseline.

Write `docs/scratch-orgs.md`, the decision record:

- spike results (the table above, filled in)
- **trigger:** A (every push), B (a block step), either one plus Setup changes (`references/buildkite.md`)
- settings that differ from their defaults (**Settings** below)
- baseline scope: included types and exclusions, and why
- golden, sweep and baseline schedules; who reviews drift PRs and where they go
- the gaps that matter to this team (`references/gaps.md`, plus snapshots not carrying credentials)

**Done when** the spikes are recorded, the go/no-go is written, and the person has agreed the decision record.

---

## Phase 1: fix the engine (required before first use)

These are bugs in v1's code. Fix them, add a test for each where it's pure, and run `node --test tests/*.test.mjs`.

1. **Login and Setup-changes steps run unattended on the default branch and on scheduled builds.** Buildkite runs
   a step whose dependency was skipped by `if:`. In `pipeline.feature-org.yml`, give the `login` and `changes`
   command steps (and variant B's `feature-org`) the same condition as their block steps:
   `if: build.branch != pipeline.default_branch && build.source != "schedule"`.
2. **`changes` always commits `changes.txt`.** In `scratch-org-step.sh`, write `changes.txt` / `changes.md` /
   `login.md` / `org.md` to `"$(mktemp -d)"`, not the checkout. Limit the status check and `git add` to the source
   folders (`git status --porcelain -- $SOURCE_DIRS`, `git add -- $SOURCE_DIRS`). Also run
   `git pull --rebase origin "$BRANCH"` before pushing, so a branch that moved doesn't reject the push.
3. **`baseline.mjs` hard-codes `-o devhub`** (six calls). Import an alias from settings and use it everywhere.
4. **The Dev Hub is assumed to be production.** Add `PROD_ALIAS` (default `DEVHUB_ALIAS`). `baseline.capture()`
   reads `PROD_ALIAS`. The seed guard in `org/data.mjs` refuses both `PROD_ALIAS` and `DEVHUB_ALIAS`. CI logs in to
   production separately (JWT) when the two differ.
5. **The sweep doc disagrees with the code.** A failed `ls-remote` gives an empty list and the sweep exits 2. Keep
   that (it's safe), but make `--from-git` still delete expired `ci-*` orgs before exiting, and fix
   `references/gotchas.md` to say what happens.

Smaller fixes:

- In soft mode, a failure in the branch's own source must not log "the baseline did not deploy".
- `tester()` puts `--name` unescaped into `LastName`. Strip quotes from it.
- SKILL.md order: the Phase 1 done-check used files that v1 only copied in Phase 4. v2 copies the engine first
  (Phase 2).
- Delete the leftovers: the empty `assets/buildkite/hooks/` folder, `GLOSSARY.md` references, the `sprint`/`uat`
  branches in `ready()`, and the blank-line gaps in `org.mjs`.

**Done when** the tests pass, including new ones for 1–5, and `bash -n` and a YAML parse of the pipeline file are
clean.

---

## Phase 2: Dev Hub, login, shape and definition files

1. Copy `scripts/scratch-org.mjs`, `scripts/engine/` and `assets/buildkite/scratch-org-step.sh` to
   `scripts/scratch-org/` in the target repo.
2. **JWT for CI:** reuse salesforce-scratch-org-tests' `make-ci-cert.sh` (connected app, certificate, the
   `Pipeline_CI` permission set). Secrets `SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME` and `SF_DEVHUB_JWT_KEY` live in
   SSM. Store the key base64-encoded, because Parameter Store keeps only the first line of a multi-line value
   otherwise, and decode it in the agent's environment hook.
3. **Org Shape:** enable it for the Dev Hub on production. *(Ask first.)* Then
   `sf org create shape -o devhub` and wait until `sf org list shape` shows it Active. The shape takes the
   **15-character** production org ID.
4. **Golden definition** `config/scratch-golden.json`. Don't set `edition` alongside `sourceOrg`. Add every feature
   the shape doesn't carry that production uses:

   ```json
   {
     "orgName": "Feature org golden",
     "sourceOrg": "00Dxxxxxxxxxxxx",
     "features": ["PersonAccounts", "MultiCurrency", "MaxApexCodeSize:10"],
     "settings": {
       "apexSettings": { "enableCompileOnDeploy": false }
     }
   }
   ```

   - `PersonAccounts`, `MultiCurrency`, `Chatbot` and `DevOpsCenter` are never captured by a shape. Keep only the
     ones production has.
   - Set `MaxApexCodeSize` from spike 2. Above 10 needs a Salesforce Support case for the **Dev Hub**.
   - Add each raised integer limit that spike 5 fails on (for example `MaxCustomLabels:<n>`). The shape doesn't
     carry integer-valued settings.
   - `enableCompileOnDeploy: false` speeds up the golden deploy. Compile errors then surface at run time, so Phase 4
     compiles explicitly before the snapshot. *(Verify the setting name against the current Metadata API
     `ApexSettings`.)*
   - Set `SCRATCH_DEF=config/scratch-golden.json` for the golden build.
5. `config/packages.json`: production's managed packages (04t ids, plus `keyEnv` for install keys). The nightly
   capture reports any that are missing.

**Done when** `node scripts/scratch-org/scratch-org.mjs limits` prints the allowances, locally and from a CI agent,
and a throwaway org from `scratch-golden.json` creates cleanly (delete it afterwards).

---

## Phase 3: the production baseline, scoped and batched

1. Copy `assets/config/baseline.json` to `config/baseline.json`. **Scope it** (the biggest lever at scale):
   - Remove `Report`, `Dashboard`, `EmailTemplate` and `ListView` from `types` unless a feature needs them. They're
     usually most of the file count and rarely needed for development.
   - Optionally build the scope from the dependency closure of what branches touched in the last N months
     (`sf project retrieve start --metadata ...` from `git log` paths, or `rootTypesWithDependencies`, which is
     limited to 25 requests a day and 100 components per request).
   - Add the org's own exclusions: integration users' permission sets, anything secret.
2. **Engine change: a batched retrieve.** `capture()` must split the manifest so each retrieve stays under **10,000
   files** and **39 MB zipped**:
   - one manifest per type, or per group of small types
   - split CustomObject, Flow, ApexClass and any type over ~2,500 members into batches
   - retrieve each into its own metadata folder, convert each into `baseline/`, then subtract owned files and
     sanitize as before
   - log each batch's zip size, and halve a batch that fails on size
3. Run `scratch-org baseline capture` once locally, on `main`, as a user who can read production. Read `drift.md`:
   anything that looks secret goes in `exclude`, and `watch` lists what scratch orgs won't get (record it).
4. Commit `baseline/` through a PR. `baseline/` is **never** a package directory.
5. Schedule the nightly **baseline** build (`references/buildkite.md`), with `BASELINE_PR_COMMAND` set for the
   team's VCS.

**Done when** `baseline/` is on the default branch, isn't in `sfdx-project.json`, and the scheduled build has opened
or updated a drift PR once.

---

## Phase 4: the golden build and snapshot (nightly)

This replaces v1's optional "snapshot refresh". It's now the only way the baseline reaches an org.

**Engine change: `golden` command.** Rename `snapshot refresh` to `golden build` (keep the old name as an alias):

1. Check capacity. Create `snapshot-src` from `config/scratch-golden.json` (shape). Turn on "Login As" and rebuild
   roles (as v1 does).
2. Install packages. Use `--wait 30 --publish-wait 10`, and retry once on timeout.
3. **Deploy the baseline in tiers.** Each tier is split into chunks under 10,000 files, **5,000 Apex code units**
   and 39 MB, or set `SF_ORG_METADATA_REST_DEPLOY=true` to lift the 39 MB limit (the file limit still applies):

   | Tier | Types |
   | --- | --- |
   | T0 | Settings, GlobalValueSet, CustomLabels, StaticResource, RemoteSiteSetting, CspTrustedSite, CustomPermission |
   | T1 | CustomObject, CustomField, RecordType, BusinessProcess, ValidationRule, FieldSet, Queue, Group, Role |
   | T2 | ApexClass, ApexTrigger, ApexPage, ApexComponent, LWC, Aura, CustomMetadata, LightningMessageChannel |
   | T3 | Flow, Workflow, ApprovalProcess, AssignmentRules, AutoResponseRules, EscalationRules, SharingRules, DuplicateRule, MatchingRules |
   | T4 | Layout, FlexiPage, CompactLayout, QuickAction, WebLink, CustomTab, CustomApplication, PathAssistant, ListView |
   | T5 | PermissionSet, PermissionSetGroup, NamedCredential, ExternalCredential |
   | T6 | ReportType, Report, Dashboard, EmailTemplate (only if in scope) |

4. **The fixed-point loop**, which replaces v1's "drop the failed files and retry once". One missing dependency
   fails hundreds of victims, so deleting the failures throws the baseline away. Instead:
   - Deploy each tier with `--ignore-errors --async`. This is allowed in scratch orgs, never in production. Then
     poll `sf project deploy report --job-id <id>`.
   - Parse `componentFailures`. Redeploy only the failed components. Repeat until a pass deploys **zero new
     components**, which usually takes 2–4 passes. Cap it at 6.
   - Write what's left to `baseline/.exclusions.json` with a reason code: `missing-feature`, `unsupported-type`,
     `org-specific-id`, `user-reference`, `flow-delete`, `limit` or `unknown`. Post it in the build annotation. A
     person then either adds the feature to `scratch-golden.json` or moves the component to `exclude`.
     **Shrinking this list is the main ongoing job.**
5. **Deploy the default branch's own source folders** (`SOURCE_DIRS`) at the commit being built, after the last
   tier and **without** `--ignore-errors`. The baseline subtracts every file the source owns, so without this step the
   snapshot holds production minus the team's code, and Phase 6's delta from the snapshot commit would never deploy
   the files that branch didn't change. A failure here fails the build: it's the team's code, not production's.
6. Assign every permission set in the source to the admin. Load the seed with the **automation bypass** on
   (Phase 5).
7. **Compile and smoke test:** run `RunSpecifiedTests` with a small, fast set of tests (`GOLDEN_SMOKE_TESTS`), or
   compile all classes. Fail the build on compile errors.
8. Abort any scheduled or queued Apex jobs. A pending job blocks redeploying its classes in every clone.
9. `sf project reset tracking -o snapshot-src --no-prompt`, so clones start with a clean SourceMember table.
10. Snapshot it as `LCB<yymmddhhmm>`, with the description `<commit> b<baselineId> s<seedId>`, where `<commit>` is
   the default-branch commit whose source step 5 deployed. Wait for Active.
   Create **one** org from it and run the smoke test there before the new snapshot is used. Keep the newest 2.
   Delete `snapshot-src`.

**Timeouts:** step `timeout_in_minutes: 180`. Every deploy uses `--async` plus polling, so a long tier never hits a
`--wait`. Schedule it outside the production instance's maintenance window (trust.salesforce.com). A deploy that
straddles one restarts.

**After each Salesforce major release** (three a year): recreate the shape first (*ask first*), **wait until
`sf org list shape` shows it Active**, then start the golden build. Recreating a shape deactivates the old one, so a
golden build started straight after `create shape` can fail or pick up nothing.
Don't wait for "shape outdated".

**Done when** a golden snapshot is Active, a clone of it passes the smoke test, and the exclusions list is recorded
in the decision record.

---

## Phase 5: the seed

1. Write `data/seed/` from `assets/data/seed/` (sf tree JSON, `plan.json` parents first, `@ref` links, date tokens
   `${TODAY}` and similar). Extend it with only the records the team's next features need: tens, not thousands. Use
   picklist **codes** (`BillingCountryCode`), `example.invalid` emails, and "(seed)" in names.
2. **Automation bypass:** heavy automation fires on every insert, and the sObject Tree API takes 200 records and 5
   levels per request. Add a hierarchy custom setting or custom permission (for example `Bypass_Automation__c`)
   that triggers, Flows and validation rules check. Turn it on for the CI user while seeding, then off.
   *If production lacks such a switch, propose it as its own change. Don't add it to the baseline.*
3. Leave out records that schedule or queue async Apex.
4. The seed loads into the golden org, so it travels in the snapshot. Per-story seeds
   (`data/seed/stories/<key>/plan.json`, from the branch) still load into that branch's org only. Fold them into
   the core seed once the feature ships.

**Done when** the seed loads cleanly in the golden build, and the snapshot's data storage is well under 200 MB.

---

## Phase 6: the feature org (per branch)

**Engine change: `ready` from the snapshot, then deltas.**

1. Find the branch's org by its Dev Hub description, or create it **from the newest Active golden snapshot**. If
   there's no snapshot, fail with a clear message (`SCRATCH_SHAPE_FALLBACK=on` permits a shape fallback that runs the
   full golden loop. Allow it only on Unlimited-size allocations).
2. **Re-deploy credentials after creating from a snapshot.** Snapshots don't carry connected apps, named credentials
   or external credentials. Deploy the `NamedCredential` and `ExternalCredential` files of `baseline/` (and the
   source's), pointed at sandboxes or mocks.
3. **Delta deploy.** The ready marker becomes `pipeline: ready <sha> b<baselineId> s<seedId>`:
   - On a new org: `sf sgd source delta --from <snapshot commit> --to HEAD --source-dir <each source dir> --output-dir <tmp>`.
     This is correct only because the golden org holds the source at that commit (Phase 4 step 5). The snapshot
     commit needn't be an ancestor of the branch: sgd compares the two trees, so the org ends up matching the branch
     (what the default branch added after the branch point is deleted). The ancestor check below is for the marker.
   - On an existing org: `--from <marker sha>`
   - Deploy with `sf project deploy start --manifest <tmp>/package/package.xml --post-destructive-changes <tmp>/destructiveChanges/destructiveChanges.xml --wait 30`.
     **No `--ignore-errors`:** the branch's own failures must be seen.
   - If the marker is missing, the marker sha isn't an ancestor of HEAD (a rebase or force-push), or delta generation fails: deploy the **branch's source
     folders in full**, never the full baseline.
   - If the snapshot's baseline id differs from the current `baseline/` (a drift PR merged since), deploy the delta
     of `baseline/` between the two ids too, or wait for the next golden build (`BASELINE_CATCHUP=delta|wait`,
     default `delta`).
   - Watch flow deletions: one Flow that can't be deleted fails the whole deploy (Known Issue W-10538057).
     Deploy flow deletions separately.
4. Assign permission sets, run the story seed if there is one, and write the marker.

`ready` stays safe to repeat. A push that changes nothing deployable only re-marks the org.

**Locally:** `node scripts/scratch-org/scratch-org.mjs ready --branch "$(git branch --show-current)"`. Then wire
`.buildkite/pipeline.feature-org.yml`, keeping the trigger the decision record chose, and upload it from the
pipeline's first step: `buildkite-agent pipeline upload .buildkite/pipeline.feature-org.yml`.

**Timeouts:** step 45 minutes, deploy `--wait 30`. Exit code 3 (no capacity) soft-fails.

**Done when** a test branch's first build creates its org from the snapshot in minutes, and a second push reports
"updated" (a delta) or "already up to date" without creating a new org.

---

## Phase 7: people in the org

1. **Send me a login** (a block step with email and profile fields). It creates the user as a record and calls
   `System.resetPassword`, so Salesforce emails a set-password link. The profile is Standard User with every
   permission set in the source, or System Administrator to build in Setup.
2. **Pull my Setup changes.** It queries SourceMember for changes **after the CI deploy**: record `RevisionCounter`
   in the ready marker step, and filter `RevisionCounter > <that>` as well as by the people's usernames. Handle
   paging (`nextRecordsUrl`). Retrieve in batches under 10,000 files, commit as the person who clicked, then push.
   From then on the branch owns those components, and the next capture leaves them out.

**Done when** a person has logged in from the email, changed something in Setup, and seen it committed to their
branch.

---

## Phase 8: housekeeping

| Schedule | Env | Cadence |
| --- | --- | --- |
| golden | `SCRATCH_JOB=golden` | Nightly after the baseline build, plus after each major release (shape first) |
| baseline | `SCRATCH_JOB=baseline` | Nightly, and after each production release |
| sweep | `SCRATCH_JOB=sweep` | Every 6 hours: orgs whose branch is gone, CI orgs older than 2 h, a stale `snapshot-src` |

- Alert (a warning annotation) when ActiveScratchOrgs passes 80% or a golden snapshot is older than 7 days.
- `ORG_RESERVE` keeps slots free for CI test orgs and the golden build.
- The daily allowance is a rolling 24-hour window (some Developer Edition Dev Hubs were seen resetting at 00:00
  UTC). Snapshots have their own allowance, equal to the active allowance.

**Done when** a deleted test branch's org is gone after the next sweep, and the schedules are in
`docs/scratch-orgs.md`.

---

## Settings

All are environment variables. Secrets come from SSM or Buildkite Secrets, never from YAML. New in v2: **bold**.

| Name | Default | What it does |
| --- | --- | --- |
| `SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME`, `SF_DEVHUB_JWT_KEY` | (secret) | JWT login to the Dev Hub |
| `SF_LOGIN_URL` | `https://login.salesforce.com` | The Dev Hub login URL or My Domain |
| `DEVHUB_ALIAS` | `devhub` | The Dev Hub alias |
| **`PROD_ALIAS`** | `DEVHUB_ALIAS` | The org read as production (capture) and refused as a seed target |
| `DEFAULT_BRANCH`, `CONFIG_ROOT` | the pipeline's default / the trusted checkout | Trusted config |
| `SOURCE_DIRS` | `sfdx-project.json` package dirs | The branch's source folders |
| `SCRATCH_DEF` | `config/scratch-feature.json` | **Set to `config/scratch-golden.json` for the golden build** |
| `ORG_PREFIX` | `feat-` | Must be unique on this Dev Hub. The sweep deletes by it. |
| `ORG_DAYS` | `7` | Feature org lifetime (1–30) |
| `ORG_RESERVE` | `0` | Slots left free. **Set ≥ 2 for the golden build and CI.** |
| `BASELINE` | `soft` | `soft` / `strict` / `off`. In v2 it applies to the golden loop: `strict` fails on any exclusion not already listed in `.exclusions.json` |
| **`BASELINE_CATCHUP`** | `delta` | A feature org whose snapshot predates the current baseline: deploy the baseline delta, or `wait` |
| **`GOLDEN_MAX_PASSES`** | `6` | Fixed-point loop cap |
| **`GOLDEN_SMOKE_TESTS`** | (unset) | Test classes for the golden and clone smoke test |
| **`SF_ORG_METADATA_REST_DEPLOY`** | `true` | REST deploys: no 39 MB zip limit |
| **`SCRATCH_SHAPE_FALLBACK`** | `off` | Allow a feature org from the shape when there's no snapshot |
| `SEED` | `on` | `off` loads no data |
| `SCRATCH_SNAPSHOT` | newest Active `LCB…` | Force a snapshot |
| `COUNTRY_CODE` | (unset) | Set when production uses State and Country picklists (for example `AU`) |
| `TESTER_TIMEZONE`, `TESTER_LOCALE` | the org admin's | People's logins (for example `Australia/Sydney`, `en_AU`) |
| `USERNAME_SUFFIX` | `pipeline` | People's logins `<name>.uat@<orgid>.<suffix>` |
| `BASELINE_PR_COMMAND` | (unset) | Opens the drift PR from `baseline-refresh` |

---

## Limits to design around

| Limit | Value | Source |
| --- | --- | --- |
| Files per deploy or retrieve | 10,000 | Official (Metadata API Guide v68) |
| Zip per deploy or retrieve | 39 MB compressed (SOAP), 600 MB uncompressed. REST deploy is not bound by 39 MB. | Official. Older docs say 400 MB. |
| Apex code units per deploy | 5,000 | Official. Some third-party copies say 7,500. Plan for 5,000. |
| Custom fields per deploy | 45,000 | Official |
| CLI chunking | None. It warns at 80% and sends anyway. | Official (CLI env vars) |
| Non-test Apex in a scratch org | 10 MB via `MaxApexCodeSize`. More needs Support. | Official |
| Scratch storage | 200 MB data, 50 MB files. Snapshots have the same limit. | Official |
| Snapshot expiry | 90 days | Official. Earlier research said 30. |
| Snapshot allowance | Equal to the active scratch allowance | Official |
| Snapshot contents | Packages, features, limits, licences, metadata, data. **No** connected apps or named/external credentials. Can't snapshot an org made from a snapshot. | Official |
| Shape contents | Boolean settings and licences. **No** integer/string settings, metadata or data. One active per Dev Hub. Tied to a release. | Official |
| Dev Hub allocations | Developer 3/6, Enterprise 40/80, Unlimited/Performance 100/200 (active/daily) | Official. Verify with `sf org list limits`. |
| sObject Tree import | 200 records, 5 levels, 5 types per request. All automation fires. | Official |
| `rootTypesWithDependencies` | 25 requests a day, 100 components per request | Official |
| Large-project timings | Org preparation of about 80 min without pools; retrieves over 15 min on tracked orgs | Practitioner (DX@Scale deck, forcedotcom/cli #3272) |

`references/research.md` has the sources behind every row, the conflicts between them and the alternatives considered.

Not verified anywhere (measure in the spikes): a member cap on `sf org list metadata`, SourceMember paging at tens
of thousands of rows, whether a shape carries raised integer limits, and whether Salesforce will raise scratch
allocations.

---

## Gotchas added in v2

Also see `references/gotchas.md`.

- **"Maximum size of request reached" or "too many files" on deploy or retrieve:** the batch is too big. Halve it.
  The CLI won't.
- **Hundreds of failures from one root cause** (a missing field, feature or object): read the *first* failure per
  component type, fix the root (a feature in `scratch-golden.json`, or an exclusion), and rerun the loop. Don't
  exclude the victims.
- **"You can't specify features in a snapshot-based definition":** expected. Features belong in `scratch-golden.json`.
- **Named credential callouts fail in a fresh feature org:** the snapshot dropped them. Phase 6 step 2 redeploys them.
- **Deploy waits forever, then the job is killed:** use `--async` plus `sf project deploy report`. A timed-out wait
  doesn't stop the deploy in the org.
- **Compile errors in a clone but not in the deploy:** synchronous compile is off in the golden org. The smoke test
  must run before the snapshot is used.
- **"Too many open files" on the agent:** raise `ulimit -n`, or set `SF_SOURCE_TRACKING_BATCH_SIZE`.
- **Person Accounts / MultiCurrency errors on creation:** add them to `scratch-golden.json`. A shape never carries them.
- **Shape-based creation breaks right after a Salesforce release** (for example MultiCurrency in Summer '23,
  forcedotcom/cli #2214): recreate the shape, then rerun the golden build.
- **A delta that reverts the default branch's newer work:** diff only from a sha the org is known to hold (the
  snapshot commit or the ready marker). Never use `--from origin/<default>` on a checkout of the branch tip: anything
  the default branch gained after the branch point comes out as deletions and reverts in the org.
- **Callouts fail only in snapshot-built orgs, not shape-built ones:** a "baseline already in the snapshot, so deploy
  source only" shortcut skips the credentials. Phase 6 step 2 must run even when the baseline is skipped.
- **Data residency:** scratch orgs from a Hyperforce Dev Hub are created in the Dev Hub's region. Seed data stays
  synthetic regardless.

---

## When scratch orgs are the wrong tool

Use Developer or Developer Pro sandboxes (Enterprise includes 25 Developer, Unlimited 100 Developer plus 5 Developer
Pro; they refresh daily and copy all metadata) when:

- the full production baseline won't converge,
- Apex is over 10 MB and Support won't raise `MaxApexCodeSize`, or
- a team needs the whole of production rather than a feature slice.

Use Partial or Full sandboxes for integration testing, UAT, real data volume and performance. The long-term fix for
"happy soup" is modularising into unlocked or org-dependent packages. That's a multi-quarter refactor, not a CI change.

---

## Keeping the engine current

`scripts/engine/` is derived from sf-lifecycle-labs. `scripts/engine/ENGINE.md` lists every intended difference. Add
v2's changes there: batched capture, the golden command, tiered fixed-point deploy, delta ready, `PROD_ALIAS`,
credential redeploy and RevisionCounter. `scripts/sync-engine.sh <sf-lifecycle-labs>` shows upstream changes.
Tests: `node --test tests/*.test.mjs`. Add pure tests for tier assignment, chunking (files, Apex units, bytes),
fixed-point termination, exclusion classification, delta fallback and the marker format.
