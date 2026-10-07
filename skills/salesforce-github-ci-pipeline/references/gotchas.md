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

- **sprint-start fails with GH013 "Required status check pipeline/gate is expected" when pushing `release/<sprint>`** → a required status check also applies when a branch is *created*, and main's commit never carries `pipeline/gate` (only PR heads do). → The release ruleset sets `do_not_enforce_on_create: true`: creating the sprint branch from a green main is allowed, every merge into it is still gated.

## Playwright against Lightning

- **`JSON.parse` fails on `sf org open --json` inside Playwright** → Playwright sets `FORCE_COLOR`, so the CLI colours its JSON. → `login.ts` sets `FORCE_COLOR=0` for the CLI call.
- **`Cannot navigate to invalid URL`** → no `baseURL` (the org's domain is known only after login). → `openPath(page, path)`.
- **"logged out due to inactivity" at login, intermittently** → a front-door login bounce in shaped orgs. → `login()` retries once with a fresh URL.
- **Screenshots as evidence leak a session, or bloat the repo** → `page.url()` right after login is a front-door URL with a session id, and full-page PNGs are megabytes that live in git history forever. → `evidence()` keeps only the Lightning *path*, shrinks in the browser (canvas → WebP, 960 px, ≤100 KB; no image library), the trusted job re-checks WebP magic, size and count before publishing, each publish replaces the story's folder in one commit, and the janitor squashes the `evidence` branch to one parentless commit of open stories.
- **A screenshot call made a passing UI test fail** → `locator.scrollIntoViewIfNeeded()` and `evaluate()` wait for the element up to the test timeout when nothing matches, and that timeout cannot be caught. → Give both `{ timeout: 5000 }`, use `.first()` when several match, and let the AI's trial runs really take shots (into a throwaway folder) so it sees `evidence: ... skipped` before CI does.
- **A caption from test code is posted by the bot** → captions could @mention a team or carry a live link. → plain words only (no markdown, `@`, `#`), with `://` and `www.` broken by a zero-width space. On Jira the comment is found by a distinctive title, never plain "UI evidence", so a person's comment is never overwritten.
- **Squashing a branch can lose a concurrent write** → REST's forced ref PATCH has no compare. → GraphQL `updateRefs` with `beforeOid` (atomic). A stale `beforeOid` answers with a *generic* error and leaves the ref alone, so re-read the ref to tell "moved" from "failed".
- **WebP from GitHub in a comment** → `blob/<branch>/<file>.webp?raw=true` renders for anyone with access to the private repo (raw serves `image/webp`). The comment links records by path on the story org's instance URL (no secret); people get in with the card's **Send me a login to this story's scratch org**.
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

## Planning

- **A story asked for something the platform cannot do** (a negative Flow test) and it was found only in review. →
  `/plan` before `/start`: Claude proposes the build and asks; the agreed plan and the answers join the story file
  every agent reads (`pipe tracker story`), so the review holds the build to them. Jev's readiness check flags
  untestable criteria on `/start`.
- **The plan's next step said `/start` on a started story** → `plan-post --started` makes it `/build`.
- **The agent's plan must never touch the repo or comment** → plan tools are `Read,Glob,Grep,Write` (one file); an
  agent-free step posts it. No Salesforce login and no scratch org: planning costs no allowance.

## Scale and cost (final review)

- **Lane polling could exhaust the token's 1,000 requests/hour**: each 20 s poll created a claim commit, tried the ref,
  read the holder and its run. → Read the ref first; the claim commit once per acquire; holders cached; the run checked
  every few minutes; 30 s polls with jitter (about 120 requests an hour per waiter).
- **Live checks were PATCHed every 15 s for up to an hour.** → Only when the title changes, at most once a minute.
- **The gate gathered the PR's facts twice** (decision, then card). → `gate evaluate --card`, one process.
- **Release PRs ran the full suite twice** (CI in the staging org and the staging regression). → CI passes release/*
  and backmerge-* heads; the required staging regression is their full test.
- **20-minute test cap** fails a large org's full run. → 60 minutes for "all"; an unfinished run is aborted
  (ApexTestQueueItem Status=Aborted) so the next lane holder does not deploy under running tests. Release deploy and
  gate ship jobs allow 100 minutes.
- **Every field change ran every test.** → Fields, validation rules, record types and objects run the tests that name
  their object; a permission set the tests that name it.
- **Story orgs expired after 3 days**, and later jobs dead-ended in `attach`. → 7 days; agent jobs call `org ensure`
  (rebuilds an expired org); `ORG_RESERVE` keeps slots for staging, UAT and CI.
- **The auto-fixer started on infrastructure failures** (lane timeout, full Dev Hub). → Only on static, deploy or test
  failures.
- **Events dropped under concurrent writes**, and metrics fetched every event commit. → Six retries with jitter; a
  shallow fetch of the branch tip. METRICS.md shows one DORA table (the event log's) once it covers the window.

## Final-review fixes (correctness)

- **A person's story PR could open into `main`**: story-pr chose the base by git ancestry, false as soon as anything
  merged into the sprint after `/start`. → `pipe story base <key>` (the story's labels, the same rule as `/start`).
- **A UAT sign-off was silently reset**: every staging nudge redeployed UAT, which set `pipeline/uat` back to pending on
  the same commit. → uat-deploy skips a commit UAT already has (the card's "Deploy to UAT again" forces it); the nudge
  redeploys only after a staging run that really tested a new head; superseded staging runs stop before the lane.
- **The merge button unlocked before production validation** (`pipeline/gate` = success at decide). → Routes that
  validate post pending until production accepts; a rejection sets it to failure.
- **`gh pr list` returns 30 by default**: close-out and renudge pass `--limit 1000`.
- **A back-merge with conflicts can never merge** (resolving adds a commit not in main). → The PR says to resolve on a
  branch from the release branch and open that as a normal PR.

## Agent isolation

- **An agent can change the trusted pipeline copy (`.pipeline/`) in its own workspace, or the runner (`$GITHUB_ENV`,
  `NODE_OPTIONS`)**, and later steps in the same job run it. If that job's token can post statuses, a prompt-injected
  story could forge `pipeline/*` verdicts as `github-actions[bot]`. → Agent jobs set their own `permissions:` with no
  `statuses: write` and no `actions: write`; verdicts and dispatches run in a separate job on a fresh runner.
- **The review/fix chain looped for ever at the round limit** (the limit run re-requested a review on an unchanged head,
  which said "changes" again and re-labelled `ai:fix`). → The follow-up re-reviews only a new head; the chain never adds
  `ai:fix` to a blocked PR or past the limit.

## Cards and tick boxes

- **The card said "CI is deploying" while CI waited up to 45 minutes for the org.** → While a job waits for a story
  org's lane, the card's Now line says who is using the org (with a link to that run).
- **A carried-over story's card ended at "closed without merging".** → It says how to pick it up again, with a
  **Start** box.

- **On a release PR it was hard to tell what was next**: story PRs had a card, release PRs only scattered comments. →
  A release card (contents, CI, staging, UAT, approval, validation, merge, production), refreshed by release-cut, the
  gate, UAT, staging and the release itself.
- **Commands had to be remembered.** → Tick boxes on the card. GitHub comments cannot hold buttons, but ticking a task
  list item edits the comment (`issue_comment: edited`, with `changes.body.from`); compare before and after, check the
  sender's permission (`collaborators/<login>/permission`), skip bots (the pipeline's own card edits fire the same event).
- **A sign-off by tick cannot be a label the App adds** (the gate ignores bot labels). → The agent-free job posts the
  trusted status `pipeline/sign-off` on the head; the gate counts it like an approval for PRs into the sprint.

## Code layout and API budget

- **The story card refresh cost hundreds of API calls per CI run**: every progress tick (once a minute) re-gathered all
  the gate's facts (6 + 2N calls), listed the comments to find the card, and moved the board. → The code host
  (`pipeline/src/github.mjs`) fetches each fact once per process; the tracker remembers the comment it edits; a
  `light` refresh every ~2 minutes during tests is two comment edits.
- **`pipe.mjs` had grown real logic no test reached** (check runs, deletions manifests, App tokens, card refresh). → It
  is a command table; the logic lives in the module that owns it (`tests.runForCheckout`, `production.validateCheckout`,
  `card.storyCards`, `closeout.releaseNotes`, `shipping.renudge` / `watchdogFacts`, `io.sourceFiles`), tested there.

## Settings and telemetry

- **A new switch (`AI_PLAN`) was missing from 9 workflows' env blocks**, so the card and the gate read it as off there.
  → One line per workflow, `PIPELINE_VARS: ${{ toJSON(vars) }}`; `pipe` reads every setting from it. A test fails any
  workflow that lists a switch by hand.
- **Metrics reconstructed from leftovers were wrong**: lead time stopped at the sprint branch, hotfix releases counted as
  releases, rollbacks were not counted, and AI cost needed every transcript downloaded. → The event log
  (`pipeline/src/events.mjs`): the command that knows an outcome records it (one Contents API call, a new file each, on
  `metrics`); `metrics` reads the branch once with `git cat-file --batch`. Jobs that record need `contents: write`.
- **The fix-round limit counted `fix(review)` commits**, so an agent that named its commit differently could loop. →
  `pipe verdict rounds --pr N` counts earlier completed `ai-fix PR #N` runs (`run-name`).
- **`run-name: ${{ format('PR #{0}', ...) }}` broke the YAML**: an unquoted ` #` starts a comment. Quote the value.

## Lanes and orgs

- **A queued fix (or a release PR's required CI) silently vanished**: jobs sharing an org shared a GitHub concurrency
  group, which keeps only the newest pending run and cancels the one before. → Lanes (`pipe lane acquire|release`): an
  atomic `refs/locks/<org>` ref, polled, taken over (fast-forward only) when its holder's run has finished. Every job that
  uses a story or staging org takes the org's lane and releases it with `if: always()`.
- **CI tested code another job had just deployed** (CI, ai-fix and ui-test used three different locks for one story
  org). → One lane name per org: `orgFor(target).lock`.
- **A half-made org was trusted for ever** (created, then packages or the deploy failed). → `org ensure` finishes any org
  without the ready marker (admin user's Title `pipeline: ready`), skipping packages already installed.
- **The release PR's CI waited 30 minutes for a lane that was free**: the claim commit used the tree of the job's
  `GITHUB_SHA` (a PR's test-merge commit); when the base moved, GitHub replaced that merge commit, every new claim
  failed, and the loop read the failure as "still waiting". → Claims use `main`'s tree, and a failed claim or create
  is logged and retried (five in a row fail the step).
- Lane refs need `contents: write` in the job; keep the token out of steps that run branch code (`GH_TOKEN: ""`).

## Shipping

- **`/uat-pass` (and `/ship`) failed: "unable to determine default branch ... Resource not accessible by integration"**:
  `gh workflow run` without `--ref` looks up the default branch, which a token without `contents: read` cannot.
  → Every dispatch names `--ref main` (a test enforces it); `commands` also gets `contents: read`.

- **Validation checked GitHub's merge preview** (`refs/pull/N/merge`), which can lag the base. → The gate builds the
  candidate itself (`pipe ship candidate`: base tip + decided head) under the `main` lock.
- **The release tagged `main`'s tip, not the merge it was started for**, and self-validated from a depth-1 checkout (no
  tags, so no deletions). → `release.yml` takes `sha` (+ `validated_job`, `validated_tree`); `pipe ship plan` decides skip
  / quick / validate; checkouts use `fetch-depth: 0`.
- **Close-out found the previous release with `HEAD^`.** → `--sha` and `--previous` from the release's plan job.
- **A queued ship vanished**: GitHub keeps one pending run per concurrency group and cancels the older one. → After
  each ship, `pipe ship renudge` re-runs the gate for the other approved PRs; `pipe ship watchdog` (janitor) catches a
  lost release.
- **`/uat-pass` signed the release PR's head even when UAT still ran an older commit.** → It signs only a commit with
  uat-deploy's "In UAT" status.
- **A production validation that could not start said only "could not start".** → It reports the CLI's error per level.

## Skills on GitHub

- **Local skills do not help a team that works from GitHub.** → The useful ones run in the pipeline, adapted: to-spec and
  to-tickets as `/spec` and `/tickets` (Claude writes; a person approves the breakdown with a tick; an agent-free step
  creates the issues), pr / code-review / diagnosing-bugs / tdd inside the build, review and fix prompts.
- **Never let the agent create issues itself**: it writes a JSON breakdown; `parseTickets` validates it (criteria,
  blockers point backwards, at most 15) and only a person's tick creates them, once.

## Ticks on pull requests did nothing ("@null cannot act here")

- **Every tick box and comment command on a PR was refused** after `--pr` became a value flag (for `ship candidate
  --pr N`): `act --pr --by me` read `--by` as the PR number and the person as nobody. Issues worked (no `--pr`), so
  it went unnoticed until the release's UAT tick. → The switch is `--is-pr`; a test fails any `has("x")` switch that is
  also a value flag, and parses the workflows' own `act` arguments.

## Completion review (6 Oct)

- **A ticked Sign off never merged later**: `gate.nudge` re-ran the gate for approvals only, not the `pipeline/sign-off`
  status. → It counts the trusted sign-off too.
- **Hotfix stories closed when their PR merged**, before production: PRs into main said `Closes #N`. → PR bodies say
  `Story #N`; close-out closes the story when the release is live (and still comments on one closed early).
- **A failed release had no way forward on its card.** → The staging follow-up runs after a failure too; the release
  card offers **Open a fix story** (a sprint story listing the failing tests), **UAT passed** again after a UAT failure,
  and **Start the next sprint** once shipped. Merged story cards offer **Cut the sprint's release**.
- **Approvers could not see a story's org without the CLI.** → **Send me a login to this story's scratch org**
  (the same emailed-tester flow as UAT).
- **A failed UI test could not be fixed by Claude.** → The card offers the fix; ai-fix's feedback includes the Playwright
  error.
- **Rollback left stories "Done" and did not stop the next release.** → It reopens the stories it took out; the gate
  refuses routes into main while a "Production rolled back" issue is open.
- **"Blocked by" was decoration.** → The gate holds a story until its blockers are merged into the sprint or shipped.
- **The spec issue's card never moved on.** → It follows the spec: written, breakdown proposed, stories created.

## UAT access

- **The release card asked for a UAT sign-off with no way to get into UAT** (the stand-in scratch org has no human
  logins; opening it needed the CI key). → The UAT status links the org's login page; a **Send me a UAT login** box
  (`uat-login.yml`) creates a Standard User tester with the release's permission sets and runs
  `System.resetPassword(id, true)`, so Salesforce emails the set-password link. Never put a frontdoor URL, session or
  password in a comment: anyone who can read the repo could use it. Emails come from `UAT_TESTERS` or the public
  GitHub email.

## Live spec test

- **The spec said a field "is not in the repo"**: `ai-spec` read `main`, but the field lived in the open sprint. → It
  reads the open sprint (else main), as `/plan` does.
- **New labels existed only after a manual `pipe labels sync`.** → `labels.yml` syncs them whenever
  `pipeline/src/conventions.mjs` changes on main.

## Story labels

- **Stories looked unfinished on the issue list** (`start`, `ai:implement` stayed on for ever; nothing said "merged,
  waiting for the release"). → Workflows remove their button label when done; the gate adds `in-sprint` when a story
  merges into the sprint; close-out removes it and closes the story when the release is in production.

## Agent context and access

- **Production rejected a release that passed CI, staging and UAT**: 7 tests read or wrote custom fields as the running
  user. In scratch orgs `org prepare` gives that user every permission set; in production the CI user (System
  Administrator) has none, so the fields were invisible ("No such column", "fields being inaccessible"). → CI and the
  staging regression run Apex and Flow tests with the story permission sets taken from the running user
  (`orgRegistry.asProductionUser`, given back afterwards); CLAUDE.md: set up and read test data in system mode and test
  access inside `System.runAs` with a user you create.

- **`/build` refused "issue-106 was not cut from release/…" once another story (or a back-merge) landed in the sprint
  after `/start`**: the route check demanded the branch contain the whole base. → `pipe gate route-check` refuses only
  what it was for (a branch aimed at `main` carrying unreleased sprint work); a base that moved is merged in next.
- **The builder worked on a stale story branch** (cut at `/start`; other stories merged into the sprint since), while
  the planner read the sprint: it could add a second trigger on an object. → `ai-implement` merges the base into the
  story branch before the agent starts (a conflict is a warning; the PR shows it).
- **A "limited user" test passed only because Opportunity is Public Read/Write** and a record-triggered Flow runs as the
  system: it proved nothing about access. → The context pack gives production's org-wide defaults per object, CLAUDE.md
  says a permission test proves a boundary, and REVIEW.md makes a test that relies on a public OWD a major.
- **PMD's Apex security rules never failed CI**: `ApexCRUDViolation`, `ApexSharingViolations` and `ApexSOQLInjection`
  are Moderate (3), below `--severity-threshold 2`. → Raise them in `code-analyzer.yml` (`rules: pmd: <rule>: { severity: 2 }`).
- **PMD cannot see metadata access** (permission sets, profiles, Flow run mode, OWD). → `pipe access check`.
- **A story could loosen its own review** by editing `REVIEW.md`, `CLAUDE.md` or `code-analyzer.yml`. → They are
  pipeline paths: CI's guard fails a story PR that touches them.

## UI tests and platform behaviour

- **A UI test failed on a correct feature** → it typed a future Close Date and expected to see it; Salesforce sets a
  closed Opportunity's future Close Date to today, and the Flow copied that. → UI tests use past dates and assert what
  the platform stores (read the record back). Jev's failure triage is a guess: it said "feature" here.

## Following the agent

- **A PR command showed only 👀** and the progress was on the issue. → The story card is mirrored onto the PR (same
  marker, edited in place) and every agent step sets its **Now** line with the run link. Before `/start`, `/plan`
  shows the same line in its Build plan comment; a placeholder is never read as the agreed plan.
