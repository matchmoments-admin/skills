# Gotchas

Every entry happened in a real run. Search this file for the error text you see. Format: **symptom** → cause → what the template does about it.

## Salesforce and scratch orgs

- **`sfdxAuthUrl` is null; later jobs cannot reach orgs earlier jobs created** → a Dev Hub logged in by JWT has no refresh token, so there is no auth URL to save. → Later jobs log in to the scratch org by JWT with the *same* connected app and key. The registry is the Dev Hub's own `ScratchOrgInfo` (matched on Description), never a saved login.
- **`field 'Description' can not be filtered in a query call`** → it is long text. → Query `ScratchOrgInfo` by `Status`, filter Description in code.
- **`LIMIT_EXCEEDED` … daily scratch org signup limit** → Developer Edition Dev Hub: 3 active, 6 created per day. The daily count resets at **00:00 UTC**, not rolling. Deleting an org frees an *active* slot only. A refused signup costs nothing; a failed creation after signup does. → Story orgs are deleted at merge; org-creating jobs share one lane.
- **Deploy from CI: "There are changes in the org that conflict"** → a fresh runner has no source-tracking history for an org it did not create. → Every scratch deploy uses `--ignore-conflicts` (git is the source of truth).
- **Production rejects a layout: `no QuickAction named FeedItem.RypplePost`** → the layout was retrieved from a scratch org whose features production lacks (environment drift). Every scratch-org gate passed. → Scratch orgs copy production's **Org Shape**; production validation runs *before* merging to `main`.
- **`Can't create scratch org. Contact the source org admin to add your Dev Hub org ID` (SH-0001)** → production must allow-list the Dev Hub, even when it is the Dev Hub. → Setup → Scratch Orgs, enter the **15-character** org ID (18 characters is rejected).
- **Shape-based scratch org: every UI test lands in Classic** → the admin user defaults to Classic. → `pipe org prepare` sets `UserPreferencesLightningExperiencePreferred`.
- **`There's a problem with this country … : Country` when updating the scratch user** → production's shape turns on State and Country picklists; the user's free-text country is invalid. → `prepare` sets `CountryCode` in the same update.
- **New field exists but is invisible to the UI test** → a metadata deploy grants no field access, and the permission set was deployed but never assigned. → `prepare` assigns every permission set in `force-app` (scratch orgs only; never production).
- **Field deployed and assigned but not on the edit form** → not on the page layout. Unit tests, CI and AI review all passed; only the UI test caught it. → CLAUDE.md requires layouts / record pages; REVIEW.md makes a missing one a *major*.
- **Component exists but is on no page** → acceptance criteria said "can be placed with App Builder". → Criteria must say what the user sees; components ship on a FlexiPage activated in `Account.object-meta.xml` (`actionOverrides`).
- **User-mode SOQL test: `System.SecurityException: Access to entity 'Case' denied`** → `WITH USER_MODE` on an inaccessible object throws `SecurityException`, not `QueryException`.
- **`securitySettings.passwordPolicies.enableSetPasswordInApi` rejected at API 67** → keep scratch definitions minimal; with Org Shape use only `orgName` + `sourceOrg`.
- **Unsigned plugin install hangs in CI** → `echo y | sf plugins install sfdx-git-delta`.
- **Key file missing mid-job** → `sf org create scratch` and later JWT logins re-read it. → `sf-auth` keeps it for the whole job and exports `SF_CI_KEY_FILE`.

## GitHub rules, identity and events

- **Branch rules unavailable / not enforced on a private repo** → GitHub Free. → Pro (personal) or Team (organisation). Required *environment reviewers* stay Enterprise-only on private repos: the release PR approval is the human release gate.
- **`GH013 … 2 of 2 required status checks are expected` when creating `release/<sprint>`** → the release-branch rule wants green CI on the commit the branch starts from; CI only ran on PR heads. → CI runs on every push to `main`; `sprint-start` checks `pipe gate checks HEAD` first.
- **`GraphQL: … not permitted to create or approve pull requests` / `gh pr create` fails in Actions** → off by default. On an organisation it must be allowed at **org** level first (needs `gh auth refresh -s admin:org`), then repo level. Send it as a JSON body; `-F can_approve_pull_request_reviews=true` is silently ignored.
- **PR opened by the pipeline: "N workflows awaiting approval"; required checks "Expected — waiting"** → PRs and pushes made with `GITHUB_TOKEN` start no workflows (or are held), and dispatched runs are not linked to the PR, so branch rules never see them. → The pipeline acts as a **GitHub App** (manifest flow in `scripts/create-app.sh`); its PRs and pushes trigger CI normally.
- **Chained run's checks never appear on the PR** → `gh workflow run` without `--ref` runs on `main`. → Always `--ref <branch>`.
- **Approval given but the gate says "no sign-off"** → GitHub leaves `reviewDecision` empty when the branch rules do not require reviews (release branches). → `humanApproval()` reads the reviews: a person's latest decisive review is APPROVED and newer than the latest code change.
- **Approval silently disappears** → `main`'s rule dismisses approvals when commits land (e.g. the UI tester's spec commit). → Approve after the UI test; the gate also comments "your approval was reset".
- **`Resource not accessible by integration (HTTP 403)`** → a missing job permission: `checks: read` to read check runs, `issues: read` for label events, `actions: write` to dispatch, `contents: write` to push.
- **`failed to run git: fatal: not a git repository`** → `gh` in a job without a checkout. → `GH_REPO` set in every workflow.
- **Duplicate/cancelled queued runs; a needed run "cancelled"** → concurrency groups keep one running and one pending; and workflow-level groups are taken even by runs whose job `if:` skips (every issue label fires every label-triggered workflow). → Job-level concurrency only, keyed per org (`org-issue-N`), plus one per PR for the gate.
- **Lock keys for the same org differ** → issue jobs knew `N`, PR jobs knew `issue-N-slug`, and expressions cannot parse. → The story branch *is* the key: `issue-N` (or `LIFE-123`).
- **`release` closes the open sprint after a hotfix** → "release branch is an ancestor of `main`" is true for a freshly cut branch. → A sprint has shipped only when its release PR merged.
- **Check matching never succeeds** → a regex on job names was case-sensitive ("Apex"). → Required checks are listed by exact name in `conventions.mjs` and the latest run of each wins.

## Claude in CI (claude-code-action)

- **`Either ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN … is required`** → the secret is empty (often set with nothing piped in). → Set it from a terminal with `gh secret set`, never by pasting into chat.
- **`Workflow initiated by non-human actor`** → the action refuses bot-started runs. → `allowed_bots: '*'` on reviews the pipeline starts.
- **Commands refused: "A nested command / variable in braces can't be checked"** → Claude Code blocks pipes, `&&`, `$()`, `${}` and shell variables. → Prompts say one command per call; org aliases are typed literally; files written with the Write tool.
- **The AI ran Playwright with `run_in_background` and the job ended** → the job ends when the agent stops. → Foreground only (in `verdict.instructions`).
- **`Claude reported a successful result after 42 turns, exceeding … 40`** → the cap fails the step after the work is done. → Caps sized per role; the "PR exists" plumbing runs `if: always()`.
- **`gh pr view --comments` fails for the fixer** → it also requests check status. → The workflow collects review feedback into a file first.
- **Transcript invisible** → `show_full_output` is off. → Every AI job uploads `claude-execution-output.json` as an artifact (7 days).
- **AI review on a back-merge** → wasted run on already-reviewed code. → Skipped for `backmerge-*` heads.
- **`Workflow initiated by non-human actor: <app> (type: Bot)`** → auto-chain adds labels as the App. → `allowed_bots: ${{ vars.PIPELINE_BOTS }}` (bare logins, no `[bot]`); never `*`, which trusts every bot with label access.
- **Auto-chain labels a merged PR** → the review finished after the merge. → Chain only when the PR is still open.
- **An AI label while its switch is off** → nothing would run and the person waits. → An `off` job comments which variable to set and removes the label.

## Playwright against Lightning

- **`JSON.parse` fails on `sf org open --json` inside Playwright** → Playwright sets `FORCE_COLOR`, so the CLI colours its JSON. → `login.ts` sets `FORCE_COLOR=0` for the CLI call.
- **`Cannot navigate to invalid URL`** → no `baseURL` (the org's domain is known only after login). → `openPath(page, path)`.
- **"logged out due to inactivity" at login, intermittently** → a front-door login bounce in shaped orgs. → `login()` retries once with a fresh URL.
- **Jest runs the Playwright spec** → `testPathIgnorePatterns: ["<rootDir>/e2e/"]`.
- **Prettier breaks LWC templates (`lwc:if="{x}"`)** → HTML parser. → Prettier override `parser: lwc` for `**/lwc/**/*.html`.

## Pipeline code itself

- **A long-lived branch runs old pipeline code** → `pull_request` workflows run the workflow file from the PR's merge result. → Every job runs `main`'s `pipeline/` from a `.pipeline/` checkout, but workflow *files* reach an open sprint only through `back-merge` (merges itself on green CI).
- **A maintenance PR that adds a `pipe` command fails its own CI** → CI runs `main`'s copy, which lacks the command. → Admin-merge (squash) pipeline maintenance PRs; their CI afterwards fails on the vanished `refs/pull/N/merge`, harmlessly.
- **The release PR never gets "staging regression"** → a dispatched workflow's check lands on the commit of the ref it runs on. → Dispatch `staging-deploy` with `--ref <release branch>`.
- **`gh release create` → 403 "Resource not accessible by integration"** after a good deploy → a tag on a commit that changes workflows needs the `workflows` permission, which the Actions token never has. → Tag as the App. Recover by tagging by hand and re-running `release` (it skips deploy and tag, still closes out).
- **A person can never approve their own hotfix PR** → GitHub forbids self-approval and `main` needs one. → `story-pr` opens story PRs on push, as the App.
- **`git fetch` returns nothing inside `.pipeline/`** → it is checked out with `persist-credentials: false` (so PR code cannot read the token). → Look things up through the GitHub API (`gh api`), not git.
- **PR code can forge a verdict** if it runs on the same runner as the step that posts the status (it can edit `.pipeline/`). → Run specs in their own read-only job; post statuses from a fresh runner, from the step `outcome`.
- **`no JSON in command output`** after `gh issue comment` → it prints a URL. → `io.gh` returns text when the output is not JSON.
- **Stale `origin/release/*` refs locally** → fetch without `--prune`. → `pipe` always prunes.

## Scaling

- **Developer Edition Dev Hub caps the team** at roughly staging + 2 stories in flight. Move the Dev Hub to an Enterprise or Unlimited org (much higher allocations) before adding people.
- **One open sprint, one staging org** by design; parallel release trains need one staging org each and a `sprint:` target per train.
- **Subscription-token AI usage is per person.** For a team, use an organisation API key.
- **Actions minutes**: `pipe metrics` / the weekly `metrics` workflow. The template caches the sf CLI weekly and Chromium by lockfile.
- **Release PR and back-merge CI burn scratch orgs** (1 of 6 a day each). → They attach the sprint's staging org under the `org-staging` lock.
- **Jev (TypeSafe) is for decisions only.** It cannot write code or reviews. `noul` criteria must be `{true, false}`; score criteria are levels lowest first; keys start `apik`; failures return `{ok:false}` and the caller falls back.

## Flows

- **Shipped Flows arrive inactive in production** → `enableFlowDeployAsActiveEnabled` is off by default. → `devhub-setup/.../Flow.settings-meta.xml`; then deploys need Apex tests that run the active Flows.
- **`flow:TriggerEntryCriteria` (High) from Code Analyzer** → a record-triggered Flow checks its conditions in a Decision. → Put them in the Start element's filters.
- **A Flow test fails although the Flow is right** → the test's triggering record does not meet the entry criteria; Flow tests cannot test "does not run". → Cover that in Apex.
- **A deleted Flow test keeps failing CI** → added and deleted within one branch, it never reaches a destructive change and stays in the story org. → Run Flow tests by name from git (`<FlowApiName>.<TestName>`), not RunLocalTests.
- **`This class name's value is invalid: flowtesting`** → `--tests` needs `<FlowApiName>.<TestName>`.

## Workflow versions

- **A labelled PR runs an old workflow file** → `pull_request` events use GitHub's test merge commit, refreshed lazily; even a back-merge may not reach it. → Run AI steps on `workflow_dispatch --ref main`; route PR events through `pull_request_target` (base branch's own file), with route jobs that never check out PR code.
- **An agent "scheduled a check" and ended without committing** → it backgrounded a long command. → `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` on the agent step, plus a workflow step that commits what it wrote.
- **ai-fix ignored a failed check** → the newest CI run was still running. → Use the newest *failed* run, preferring the current head.

## Tests, validation and CI on main

- **`RunRelevantTests` ran 0 tests** → the payload was identical to production; the platform only tests what changes.
  Expected. Orgs without the beta reject the level: the module falls back to every test class.
- **A second merge to main cancels the first commit's CI** (one CI per branch); a script waiting for the first
  commit's CI then waits forever, and sprint-start (which needs main's latest commit green) fails. → Wait on the
  latest main commit; do not merge to main while a sprint is starting.
- **Logging in to the same Salesforce user under a new alias drops the old alias** (seen with `devhub` after a
  `ci-devhub` login). → Pipeline jobs use one alias; locally, `sf alias set devhub=<username>` restores it.

## Scratch org cleanup

- **Every creator needs a cleaner, and a sweep for when it fails.** Story orgs go at merge and close-out; staging and
  UAT at close-out; CI temporary orgs in an `always()` step. A killed runner, a half-failed creation (an org without
  its alias), an abandoned sprint (30-day orgs) or a closed-but-unmerged story still leaves orgs holding active slots.
  → `findOrphans` + `scratch-janitor` every 6 hours.
- **Delete through the Dev Hub** (`ActiveScratchOrg` record by `SignupUsername`), not by logging in to the org: a
  failed JWT login or a missing alias otherwise leaves the org alive.

## Comment commands

- **A repeated command did nothing** (a second `/start`) → the command adds a label, and adding a label that is
  already there fires no event. → Remove the label, then add it.
- **`/build` failed with "non-human actor"** → commands act as the App, and `ai-implement` had no `allowed_bots`.
  → Every agent step passes `allowed-bots: ${{ vars.PIPELINE_BOTS }}`; a pipeline test checks every workflow.
- **Keep the skill in step**: after a pipeline change run `scripts/skills-sync.sh` (text from the skills repo,
  template from the pipeline); CI's `--check` fails a PR whose skill template is stale.

## Merge button

- **GitHub's merge button ignored the gate** (AI review, UI test, UAT, sign-off are the gate's, not the branch
  rules'). → The gate posts `pipeline/gate`; the rulesets require it **with `integration_id` 15368** (GitHub Actions),
  or anyone with write access could post a fake success with their own token.
- **An emergency merge skipped staging or the release** → the `merged` workflow (on `pull_request_target: closed`,
  merged by a non-bot) starts the gate's follow-ups; with no gate validation id, `release` validates first.
