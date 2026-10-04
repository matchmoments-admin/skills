---
name: salesforce-github-ci-pipeline
description: Set up a Salesforce delivery pipeline on GitHub Actions end to end, manual by default with each AI step (Claude build/review/fix/UI test, Jev triage) behind its own switch (scratch orgs per story, gated release train to production). Use when the user wants Salesforce CI/CD, a release train, or scratch-org-per-story development on GitHub; when standing up a new Salesforce repo with Claude in CI; or when an existing pipeline built from this skill fails (GH013, scratch org allocation, sfdxAuthUrl null, gate not merging).
---

# Salesforce GitHub CI pipeline

Stands up a proven pipeline: GitHub issue → story branch + production-shaped scratch org → a person (or Claude) builds, CI checks, optional AI review and UI test → a person approves → gate merges into the sprint's release branch → staging regression → release PR → approve → production validation → quick deploy → close-out. Hotfixes take the same gates straight to `main`.

The template in [`assets/template/`](assets/template/) is the working implementation. Copy it; do not re-derive it. Every rule in it exists because a run failed without it; [`references/gotchas.md`](references/gotchas.md) says which.

Read [`references/architecture.md`](references/architecture.md) before changing anything in `pipeline/` or `.github/`.

## Phase 0 — Decisions

Ask the user, then record the answers in the repo's `CLAUDE.md`:

1. **GitHub owner.** Branch rules on a private repo need GitHub Pro (personal) or Team (organisation). Recommend an organisation on Team: it also enables the pipeline App identity and org-level Actions policy.
2. **Production org and Dev Hub.** Often the same org. Note its edition: Developer Edition allows 3 active / 6 daily scratch orgs, which caps the team at about two stories in flight (see gotchas, *Scaling*).
3. **Tracker.** GitHub Issues (default) or Jira ([`references/jira.md`](references/jira.md)).
4. **AI switches.** All off by default: the pipeline is complete without AI (CI + a person's approval). Turn on only what the user wants, each a repository variable: `AI_IMPLEMENT`, `AI_REVIEW`, `AI_FIX`, `AI_UI_TEST`, `AI_AUTO_CHAIN`, `AI_TRIAGE` (Jev), optional `AI_MODEL`. Cheapest useful preset: `AI_REVIEW` + `AI_TRIAGE`. See [`references/architecture.md`](references/architecture.md), *AI switches*.
5. **Claude auth in CI** (only if any Claude switch is on). Subscription token (`claude setup-token`) or an API key. Subscription usage counts against the user's plan limits; the template already uses Haiku for review and UI test.
6. **Jev** (only with `AI_TRIAGE`): a TypeSafe key (`apik…`) as secret `TYPESAFE_API_KEY`. Reuse an existing one from another project by piping it into `gh secret set` without printing it.
7. **Sprint naming** (e.g. `2026-w42`).

Done when: all seven answers are written down.

## Phase 1 — Repo from the template

Run [`scripts/bootstrap.sh`](scripts/bootstrap.sh) `<target-repo-dir>`. It copies the template, keeps any existing `force-app/`, and prints what it changed. Then edit `CLAUDE.md` (project rules) and `REVIEW.md` (review rubric) for the project.

Done when: `npm ci && npm run test:pipeline` passes in the target repo, and `actionlint .github/workflows/*.yml` is clean.

## Phase 2 — Salesforce

Order matters; each step depends on the one before.

1. **Dev Hub**: Setup → Dev Hub → Enable (one-way).
2. **CI certificate and connected app**: [`scripts/make-ci-cert.sh`](scripts/make-ci-cert.sh) `<repo-dir> <contact-email>` generates `secrets/ci.key` + certificate and writes `devhub-setup/.../Pipeline_CI.connectedApp-meta.xml`. Deploy `devhub-setup/` to production, then **assign** the `Pipeline_CI` permission set to the CI user (`sf org assign permset`): the assignment is what pre-authorizes the app, and it is data, not metadata.
3. **Prove the JWT login** locally: `sf org login jwt --client-id <consumer key> --jwt-key-file secrets/ci.key --username <ci user> --instance-url https://login.salesforce.com`.
4. **Org Shape**: deploy `devhub-setup/main/default/settings/DevHub.settings-meta.xml`, then the user adds production's **15-character** org ID under Setup → Scratch Orgs → "Allow a Dev Hub org to create scratch orgs using this org's shape" (no API for this), then `sf org create shape -o <prod>`. Put that 18-char ID in `config/scratch-{dev,qa,hotfix,training}.json` as `sourceOrg`.

Done when: `sf org list shape` shows the production shape **Active**, and a test scratch org created from `config/scratch-dev.json` deploys `force-app` (delete it afterwards).

## Phase 3 — GitHub

Run [`scripts/github-setup.sh`](scripts/github-setup.sh) `<owner/repo> <ci-username> <repo-dir>`; it is idempotent and reports each item. It sets the Salesforce and Claude secrets, the Actions policy (allow Actions to create PRs, at org and repo level, sent as a JSON body), the labels (`pipe labels sync`), the `production` environment (deploy from `main` only) and the two branch rulesets from [`assets/rulesets/`](assets/rulesets/).

Then the pipeline App, which only a person can confirm: [`scripts/create-app.sh`](scripts/create-app.sh) `<owner> <repo>` opens a pre-filled manifest page; the user clicks Create, pastes back the `code`, the script stores `PIPELINE_APP_ID` and `PIPELINE_APP_PRIVATE_KEY` without printing the key; the user installs the App on the repo.

Then the variables: `PIPELINE_BOTS=github-actions,<app-slug>` (the only bots allowed to start agents; bare logins, no `[bot]`) and each AI switch the user chose in Phase 0 (`gh variable set AI_REVIEW --body true`). Leave the rest unset.

Done when: a direct `git push` to `main` is refused with GH013, `gh api orgs/<org>/installations` lists the App, the repo's workflow permissions show `can_approve_pull_request_reviews: true`, and `gh variable list` shows exactly the chosen switches.

## Phase 4 — Tracer story

Prove the whole path with one small real story before anyone relies on it. Drive it exactly as a user would, and fix forward through the template (then re-sync the skill) whenever a step fails.

1. Push a commit to `main` and wait for **CI on main** to go green (release branches are cut only from commits with green required checks).
2. Actions → `sprint-start` with the sprint name.
3. Create an issue with acceptance criteria that say **what the user sees** ("the record page shows…"), label `start`, then build it on the branch (or label `ai:implement` if `AI_IMPLEMENT` is on).
4. CI (and `ai-review`, if on) start by themselves. For the UI test, commit `e2e/story-<key>.spec.ts` and label `test`, or label `ai:test` if `AI_UI_TEST` is on. Approve the PR; the gate waits for whatever is still running.
   Run the tracer twice if the user wants AI: once with every switch off, once with their chosen switches.
5. The gate merges into the release branch and starts the staging regression.
6. Actions → `release-cut`; approve the release PR.

Done when: a GitHub Release tag exists, the change is visible in production Setup, the story is closed, the milestone is closed, and `sf data query -o <prod> -q "SELECT Description FROM ScratchOrgInfo WHERE Status='Active'"` returns no orgs from that sprint.

## Operating it

- The user's actions are only: `sprint-start`, label `start`, build (or `ai:implement`), label `test` (or `ai:test`), **Approve**, `release-cut`, **Approve**. Hotfix: labels `hotfix` + `start`. Undo: Actions → `rollback` with a tag.
- When a gate does not merge, its PR comment names every missing input; fix that input, the gate re-runs itself.
- Telemetry: the weekly `metrics` workflow keeps a "Delivery metrics" issue (DORA, AI first-pass rate, workflow health); transcripts of every AI run are artifacts (`claude-transcript-*`).
- A fix to `.github/` or `pipeline/` reaches an open release branch only after `gh workflow run back-merge.yml` (PR workflows run the merge result's copy).
- When something fails, look it up in [`references/gotchas.md`](references/gotchas.md) by its error text first.
