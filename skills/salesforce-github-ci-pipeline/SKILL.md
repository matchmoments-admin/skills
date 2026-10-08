---
name: salesforce-github-ci-pipeline
description: Set up a Salesforce delivery pipeline on GitHub Actions end to end, manual by default with each AI step (Claude plan/build/review/fix/UI test, Jev triage) behind its own switch (optional build plan before starting, scratch orgs per story, live test views, a gate that locks the merge button, optional UAT, gated release train to production). Use when the user wants Salesforce CI/CD, a release train, or scratch-org-per-story development on GitHub; when standing up a new Salesforce repo with Claude in CI; or when an existing pipeline built from this skill fails (GH013, scratch org allocation, sfdxAuthUrl null, gate not merging).
---

# Salesforce GitHub CI pipeline

Stands up a proven pipeline: GitHub issue → optional **build plan** (Claude proposes, asks questions; the agreed plan joins the spec) → story branch + production-shaped scratch org → a person (or Claude) builds → CI runs the change's tests (live on the PR) → optional AI review and UI test → a person signs off → the gate merges into the sprint (GitHub's merge button stays locked until it does) → staging runs everything → release PR → optional UAT sign-off → approve → production validation (`RunRelevantTests`, live) → quick deploy → close-out. Hotfixes take the same gates straight to `main`. A **story card** on each issue shows what is running now, with a link, and every stage.

The template in [`assets/template/`](assets/template/) is the working implementation. Copy it; do not re-derive it. Every rule in it exists because a run failed without it; [`references/gotchas.md`](references/gotchas.md) says which.

Read [`references/architecture.md`](references/architecture.md) before changing anything in `pipeline/` or `.github/`.

## Phase 0 — Decisions

Ask the user, then record the answers in the repo's `CLAUDE.md`:

1. **GitHub owner.** Branch rules on a private repo need GitHub Pro (personal) or Team (organisation). Recommend an organisation on Team: it also enables the pipeline App identity and org-level Actions policy.
2. **Production org and Dev Hub.** Often the same org. Note its edition: Developer Edition allows 3 active / 6 daily scratch orgs, which caps the team at about two stories in flight (see gotchas, *Scaling*).
3. **Tracker.** GitHub Issues (default) or Jira ([`references/jira.md`](references/jira.md)).
4. **AI switches.** All off by default: the pipeline is complete without AI (CI + a person's approval). Turn on only what the user wants, each a repository variable: `AI_PLAN`, `AI_IMPLEMENT`, `AI_REVIEW`, `AI_FIX`, `AI_UI_TEST`, `AI_AUTO_CHAIN`, `AI_TRIAGE` (Jev), optional `AI_MODEL`. Pipeline switches (not AI): `BASELINE` (the production baseline in every scratch org: soft by default), `BASELINE_NIGHTLY`, `SCRATCH_SNAPSHOT` (force or `off`; unset uses the newest pipeline snapshot), `UAT_TESTER_ROLE`, `UI_EVIDENCE` (a passing UI test posts one small screenshot per acceptance criterion on the story; off unless `true`), `UAT_ENABLED` (a UAT stage with `/uat-pass`; sandbox via secret `SF_UAT_USERNAME`, else a scratch stand-in) `PROD_TEST_LEVEL` (default `RunRelevantTests`, falling back to every test class) and `CI_TEST_LEVEL` (default `RunRelevantTests` for a story's Apex tests, falling back to the pipeline's own selection; `selector` turns it off). Cheapest useful preset: `AI_REVIEW` + `AI_TRIAGE`. See [`references/architecture.md`](references/architecture.md), *AI switches*.
5. **Claude auth in CI** (only if any Claude switch is on). Subscription token (`claude setup-token`) or an API key. Subscription usage counts against the user's plan limits; the template uses Haiku for the UI test and Sonnet for plan, spec, build, fix and review.
6. **Jev** (only with `AI_TRIAGE`): a TypeSafe key (`apik…`) as secret `TYPESAFE_API_KEY`. Reuse an existing one from another project by piping it into `gh secret set` without printing it.
7. **Sprint naming** (e.g. `2026-w42`).
8. **Existing org?** A fresh org follows the phases as written. An established Enterprise/Unlimited org (Flows,
   managed packages, no source control) first follows [`references/enterprise.md`](references/enterprise.md):
   Dev Hub and integration user, production into source, `config/packages.json`, Flow settings.
9. **CI runner.** GitHub Actions (the template) or the company's Buildkite ([`references/buildkite.md`](references/buildkite.md)).
   If the team only wants per-feature scratch-org tests in an existing build (Buildkite, Bitbucket, no pipeline
   change), use the separate `salesforce-scratch-org-tests` skill instead of this one.

10. **Where is the code hosted?** GitHub is what this template runs on. If the team is on Bitbucket or GitLab, say
    so plainly: the pipeline (Actions, rulesets, the App, issue cards) does not run there yet. Offer the
    `salesforce-scratch-org-tests` skill for their existing build, or a GitHub organisation for the pipeline, and
    stop here until they choose. Follow the team's own conventions for repo naming, branch names and labels where
    they have them (ask; the pipeline's names are in `pipeline/src/conventions.mjs`).
11. **How are secrets kept?** Ask before creating any. Default: GitHub secrets, with the production credentials in
    the `production` environment (deployments from `main` only; on GitHub Enterprise add required reviewers). If
    the company has a vault (HashiCorp, AWS, Azure), note it in `CLAUDE.md` and keep GitHub as the store for now:
    OIDC from Actions to the vault is a next step ([`references/enterprise.md`](references/enterprise.md)).
12. **Who may hold production credentials?** Default and recommendation: nobody but CI. People keep their own
    production logins for Setup; the pipeline's key (`secrets/ci.key`) is made once, stored as a secret, and deleted
    from the machine that made it. Admins reach a story's scratch org with **Send me an admin login**, never the key.
13. **Approvers.** Who approves stories (`APPROVERS`, default first, e.g. the lead). With it set, nobody approves a
    change they pushed, and each story names its approver ([`references/enterprise.md`](references/enterprise.md), *People*).

Done when: all thirteen answers are written down.

## Phase 1 — Repo from the template

Run [`scripts/bootstrap.sh`](scripts/bootstrap.sh) `<target-repo-dir>`. It copies the template, keeps any existing `force-app/`, and prints what it changed. Then edit `CLAUDE.md` (project rules) and `REVIEW.md` (review rubric) for the project.

Done when: `npm ci && npm run test:pipeline` passes in the target repo, and `actionlint .github/workflows/*.yml` is clean.

## Phase 2 — Salesforce

Order matters; each step depends on the one before.

1. **Dev Hub**: Setup → Dev Hub → Enable (one-way). Also enable **Scratch Org Snapshots** there (one-way): new story, CI, staging and UAT orgs then start from a snapshot with production's baseline and the test data already in (`snapshot-refresh`). Then run `prod-baseline` once by hand and review its PR (all of production by default; tune `config/baseline.json`).
2. **CI certificate and connected app**: [`scripts/make-ci-cert.sh`](scripts/make-ci-cert.sh) `<repo-dir> <contact-email>` generates `secrets/ci.key` + certificate and writes `devhub-setup/.../Pipeline_CI.connectedApp-meta.xml`. Deploy `devhub-setup/` to production, then **assign** the `Pipeline_CI` permission set to the CI user (`sf org assign permset`): the assignment is what pre-authorizes the app, and it is data, not metadata.
3. **Prove the JWT login** locally: `sf org login jwt --client-id <consumer key> --jwt-key-file secrets/ci.key --username <ci user> --instance-url https://login.salesforce.com`.
4. **Org Shape**: deploy `devhub-setup/main/default/settings/DevHub.settings-meta.xml`, then the user adds production's **15-character** org ID under Setup → Scratch Orgs → "Allow a Dev Hub org to create scratch orgs using this org's shape" (no API for this), then `sf org create shape -o <prod>`. Put that 18-char ID in `config/scratch-{dev,qa,hotfix,training}.json` as `sourceOrg`.

Done when: `sf org list shape` shows the production shape **Active**, and a test scratch org created from `config/scratch-dev.json` deploys `force-app` (delete it afterwards).

## Phase 3 — GitHub

Run [`scripts/github-setup.sh`](scripts/github-setup.sh) `<owner/repo> <ci-username> <repo-dir>`; it is idempotent and reports each item. It sets the Salesforce and Claude secrets, the Actions policy (allow Actions to create PRs, at org and repo level, sent as a JSON body), the labels (`pipe labels sync`), the `production` environment (deploy from `main` only) and the two branch rulesets from [`assets/rulesets/`](assets/rulesets/).

Then the pipeline App, which only a person can confirm: [`scripts/create-app.sh`](scripts/create-app.sh) `<owner> <repo>` opens a pre-filled manifest page; the user clicks Create, pastes back the `code`, the script stores `PIPELINE_APP_ID` and `PIPELINE_APP_PRIVATE_KEY` without printing the key; the user installs the App on the repo.

Then the variables: `APPROVERS` (Phase 0), `PIPELINE_BOTS=github-actions,<app-slug>` (the only bots allowed to start agents; bare logins, no `[bot]`; every agent step reads it, and a pipeline test checks each workflow does) and each switch the user chose in Phase 0 (`gh variable set AI_REVIEW --body true`). Leave the rest unset.

**Merge button and emergencies.** Both rulesets require `pipeline/gate` from the GitHub Actions app (integration
15368): the gate posts it, so GitHub's merge button stays locked until every requirement is met. Emergency approval
is the rulesets' bypass list ("for pull requests only"): repository admins by default; for a team lead, add their team
(`{"actor_type":"Team","actor_id":<team id>,"bypass_mode":"pull_request"}`). The `merged` workflow comments who
bypassed and still starts the follow-ups (a release validates against production itself).

Done when: a direct `git push` to `main` is refused with GH013, a PR's merge button says "pipeline/gate expected", `gh api orgs/<org>/installations` lists the App, the repo's workflow permissions show `can_approve_pull_request_reviews: true`, and `gh variable list` shows exactly the chosen switches.

## Phase 4 — Tracer story

Prove the whole path with one small real story before anyone relies on it. Drive it exactly as a user would, and fix forward through the template (then `scripts/skills-sync.sh`) whenever a step fails.

1. Push a commit to `main` and wait for **CI on main** to go green (release branches are cut only from commits with green required checks; do not merge to `main` while a sprint is starting).
2. Actions → `sprint-start` with the sprint name.
3. Create the story with the **New story** issue form (acceptance criteria say **what the user sees**). With `AI_PLAN` on, comment `/plan`: a **Build plan** comment appears (proposed build, tests, risks, size, numbered questions); answer in a comment, `/plan` again if it should change.
4. Comment `/start`. Within seconds the **Pipeline status** card shows **⏳ Now:** with a *watch it live* link; when the branch and org exist, its **Next** line says what to do.
5. Build on the branch and push (the pipeline opens the PR), or comment `/build`. On the PR's *Checks* tab, **Salesforce tests** shows the change's tests running; the AI review and UI test (if on) run by themselves; a failure starts `ai:fix` (if on).
6. Sign off: **Approve here** on the card, or `/ship`. The gate posts `pipeline/gate` and merges; staging runs every test.
7. Actions → `release-cut`; with UAT on, test in UAT and comment `/uat-pass`; approve the release PR. Watch **Production validation** on it, then the release graph (deploy → tag + org shape → close-out → back-merge).

Run it with every AI switch off first (manual path), then with the chosen switches. Then a hotfix (**Urgent production fix** form; it starts on submit), built by hand.

Done when: a GitHub Release tag exists for both, the change is visible in production Setup, the story card ends "Done: live in production", the milestone is closed, and `scratch-janitor` (every 6 hours; or run it) leaves no orgs from that sprint: `sf data query -o <prod> -q "SELECT Description FROM ScratchOrgInfo WHERE Status='Active'"`.

## Operating it

- The user's actions are comments on the story and PR: `/plan` (bigger stories) → `/start` → push or `/build` → **Approve** or `/ship` → (once a sprint) `release-cut` → `/uat-pass` (if UAT) → **Approve**. `/help` lists them. Hotfix: the **Urgent production fix** form. Undo: Actions → `rollback` with a tag. Emergency: someone on the rules' bypass list merges; the `merged` workflow still runs the follow-ups.
- People watch the **story card**: **⏳ Now:** what is running with a *watch it live* link (or **❌ Failed:** with where to look and how to retry), the **Next** step, a live diagram, a row per stage. Optional delivery board: a Project with a Status field (Ready, Building, In review, Approved, In staging, Live), the App's organisation **Projects: Read and write**, and `BOARD_PROJECT` ([`scripts/create-board.sh`](scripts/create-board.sh) `<org> <repo>`).
- Tests per stage: a story runs only what its change needs (live **Salesforce tests** check on the PR); staging runs everything; production validates with `RunRelevantTests` (beta), falling back to every test class (live **Production validation** check, plus Setup › Deployment Status).
- Scratch orgs: every creator has a cleaner, and `scratch-janitor` sweeps orphans every 6 hours (CI orgs whose run died, closed stories, staging and UAT of sprints no longer open), deleting through the Dev Hub record.
- Telemetry: the weekly `metrics` workflow publishes `METRICS.md` on the `metrics` branch and a "Delivery metrics" issue (DORA, AI cost per role, workflow health); transcripts of every AI run are artifacts (`claude-transcript-*`, 30 days).
- Pipeline changes: AI steps always run `main`'s workflow file (dispatched); CI and other PR-event workflows use the PR's merge result, so a workflow fix reaches an open sprint through `gh workflow run back-merge.yml`. After any pipeline change run `scripts/skills-sync.sh` (CI's `--check` fails a stale skill).
- Settings: every workflow has one `PIPELINE_VARS: ${{ toJSON(vars) }}` line; `pipe` reads all switches from it. Telemetry: the **event log** (`events/` on the `metrics` branch, one file per event, written by the `pipe` command that knows the outcome) feeds METRICS.md: lead time to production, change failure rate with rollbacks, time per stage, gate waits, org-hours, AI cost per role.
- Orgs are used one job at a time through **lanes** (`pipeline/src/lane.mjs`: an atomic `refs/locks/<org>` ref; no GitHub concurrency groups on orgs, which drop waiting runs); `org ensure` finishes a half-made org.
- Specs on GitHub: the **New spec** form; `/spec` (Claude writes the spec, `ai-spec.yml` under `AI_PLAN`), then **Make it a story** (`/story`; agent-free: one Story issue from the spec, `pipeline/src/spec.mjs`). Every agent on that story reads the whole spec (`pipe tracker story`). More stories only by hand, with `Blocked by #N`, checked at Start and at merge. Everything runs from GitHub; no local skill is needed.
- Engineering skills: the template carries `docs/agents/` (story format, label mapping, domain docs, **salesforce.md**: seams, slices, tests, debugging, PR bodies and review for Apex and Flows), `GLOSSARY-MAP.md` and a starter `docs/org/GLOSSARY.md`, so `/to-spec`, `/to-tickets`, `/pr`, `/tdd`, `/diagnosing-bugs` and `/code-review` work in the new repo; the agents' prompts carry the adapted parts (PR body, spec-axis review, diagnosing loop).
- Cards are the UI: story cards and a **release card** say what is happening now, what is next, and offer **tick boxes** (`card-actions.yml`: the card before and after an edit -> `pipe act`, the same as the comment commands in `commands.yml`; `pipeline/src/actions.mjs`). A ticked sign-off is the trusted status `pipeline/sign-off`.
- Shipping is keyed by commit (`pipeline/src/shipping.mjs`): the gate validates its own candidate (base tip + head) under the `main` lock; `release.yml` takes the merge SHA and the validated tree and quick-deploys only on a match; close-out works from that SHA and the previous `v*` tag; `pipe ship renudge` and the janitor's `pipe ship watchdog` make sure nothing queued is lost.
- Agent context and access: every agent's story file ends with the **context pack** (`pipe tracker story --pack`: what exists for the objects the story touches, and production's org-wide defaults from `EntityDefinition`); `ai-implement` merges the base into the story branch first. CLAUDE.md's **Access** rules, the plan's **Access** section and CI's **access check** (`pipe access check`: profiles, admin permissions, View All/Modify All, sharing keywords, unexplained `without sharing`, ungranted new fields/objects) keep access least-privilege with or without AI; PMD's Apex security rules are raised to High in `code-analyzer.yml`. Exceptions: `config/access-exceptions.json`.
- When something fails, look it up in [`references/gotchas.md`](references/gotchas.md) by its error text first.
