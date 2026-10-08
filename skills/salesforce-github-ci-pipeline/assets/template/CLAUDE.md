# Conventions for this repository

This repo is a Salesforce DX project. Humans and AI agents both change it only through GitHub issues and pull requests.

## Rules for every change
- Work only on the branch you were given: the story key in branch form (`issue-12`, or a Jira key such as `LIFE-123`). Never push to `main`.
- Never edit `.github/` or `pipeline/` in story work (the delivery pipeline itself; see `GLOSSARY.md`). Pipeline
  maintenance happens on non-story branches into main, reviewed against `REVIEW.md` only; CI blocks story PRs that touch it.
- Keep the change scoped to the issue's acceptance criteria. Do not refactor unrelated code.
- Pipeline maintenance: after changing `pipeline/`, `.github/`, `scripts/` or `config/`, run `scripts/skills-sync.sh`
  and commit `.claude/skills` (and the skills repo), so the reusable skill rebuilds exactly this. CI checks it.
- Never commit secrets, auth URLs, keys or `.sfdx`/`.sf` folders.
- Commit messages: `type(scope): summary (#<issue>)`, for example `feat(account): add tier field (#12)`.
- The PR body starts with `Story #<issue>` (never `Closes #`: the pipeline closes the story when it is in production)
  and has a short test plan.

## Apex
- One trigger per object, logic in a handler class, `with sharing` by default.
- Bulk-safe: no SOQL or DML in loops; handle 200 records.
- Use `WITH USER_MODE` or `Security.stripInaccessible` on user-facing queries.
- No hard-coded IDs, URLs or credentials. Use custom metadata or Named Credentials.
- Every class needs tests covering: a positive case, a negative case, a permission case (run as a limited user) and a bulk case (200+ records). Use `Assert` class methods, not `System.assert`.
- Overall coverage must stay at or above 75%; new classes should reach 90%.

## Metadata
- API version 67.0. Every new custom field and object needs a permission set entry. Metadata deploys grant no field access by themselves.
- A component users see must be on the Lightning record page they use. Ship the FlexiPage in `force-app` and activate it as the org default for the object with an `actionOverrides` entry (View, Large, Flexipage) in the object's `.object-meta.xml`, so every environment shows the same page.
- A field users edit must also be on the page layout they use. Retrieve the layout from the scratch org first (`sf project retrieve start -o issue-12 -m "Layout:Account-Account Layout"`), add the field, and commit the layout. Scratch orgs copy production's shape, so a retrieved layout only references what production has.
- Reference data (settings an admin changes) goes in custom metadata, not hard-coded constants.

## Access (permissions, sharing, org-wide defaults)
Least privilege: a user gets exactly the access the story needs, and every grant can be reviewed. CI's **access check**
(`pipe access check`) fails the build on the blockers below; the review checks the rest.
- Grant access with **permission sets** (grouped in permission set groups for a persona), never by editing profiles.
- No administrator permissions in a story's permission set (Modify All Data, View All Data, Manage Users, Author Apex,
  Customize Application...), and no View All / Modify All on an object: they ignore the sharing model.
- New custom objects start with org-wide default **Private** (internal and external); open access with sharing rules or
  teams, and say in the plan who must see what. If an object must be public, the plan says why.
- Record access comes from the sharing model, not code. The story file's **"The codebase today"** section gives
  production's org-wide defaults for the objects the story touches: know whether the change relies on them.
- Apex: `with sharing` by default, `inherited sharing` for utilities called from both sides. `without sharing` only with
  a `// sharing: <why>` comment above the class. User-facing queries and DML run in user mode (`WITH USER_MODE`,
  `AccessLevel.USER_MODE`); `@AuraEnabled` methods always.
- Flows: record-triggered Flows run as the system (they see and change records the user cannot); say so in the plan
  when that matters. Screen and autolaunched Flows keep the default run mode; `SystemModeWithoutSharing` only with
  `sharing: <why>` in the Flow's description.
- Tests run as production's CI user does: a System Administrator with **none** of the story permission sets (CI takes
  them away from the scratch org's user for the test run). So set up and read test data in system mode
  (`Database.insert(records, AccessLevel.SYSTEM_MODE)`, `[SELECT ... WITH SYSTEM_MODE]`), and test access inside
  `System.runAs` with a user you create and assign the permission set to. A test that needs the running user to have a
  story permission set passes in a scratch org and fails in production.
- The permission test proves a boundary: a user **without** the story's permission set is refused (or does not see the
  field), and a user with it succeeds. A test that passes only because the org-wide default is Public Read/Write
  proves nothing; create the record as another user, or assert on access (`UserRecordAccess`, `Schema` describe).

## Engineering skills and their conventions
The pipeline runs adapted versions of these on GitHub (`/spec`, then **Make it a story**, and inside the build,
review and fix prompts; a story made from a spec carries the whole spec to every agent). `to-spec`, `to-tickets`, `tdd`, `diagnosing-bugs`, `pr`, `code-review` and `improve-codebase-architecture` read
`docs/agents/` (issue tracker and story format, label mapping, domain docs) and **`docs/agents/salesforce.md`**, which
says what their advice means for Apex, Flows and metadata (seams, slices, tests, debugging, PR bodies, review). The
business glossary is `docs/org/GLOSSARY.md`; `GLOSSARY.md` is the pipeline's.

## Tests (what makes a good one)
- Test behaviour at a seam (`docs/agents/salesforce.md`): the record after DML, a public method, the Flow's outcome, the
  page. Never private helpers or a Flow's internal elements.
- One test method per acceptance criterion and case (positive, negative, permission, bulk); name it after the behaviour
  (`firstWinSetsCustomerSince`).
- A bug fix starts with a test that fails for the reported reason.
- A test that cannot fail (asserts what it just set, or nothing) is a blocker in review.

## The agreed plan
When the story file has an "Agreed plan" (from `/plan`) and "Answers", build what the plan says; where an answer
differs from the plan, the answer wins. Do not build anything the plan and the acceptance criteria do not ask for.

## Flows
- Prefer a record-triggered Flow for declarative automation. Before-save (`RecordBeforeSave`) for field updates on the
  same record; after-save only for related records or actions. One flow per object and trigger type where possible.
- Every new or changed record-triggered Flow ships with at least one Flow test in `force-app/main/default/flowtests/`.
  A Flow test's triggering record must meet the Flow's entry criteria (a record that does not start the Flow fails
  the test), so Flow tests cover the paths inside the Flow; cover "the Flow does not run" in the Apex test. File and API names use letters, digits and single underscores only, e.g.
  `Case_Default_Web_Priority_Web_Medium.flowtest-meta.xml`.
- Put the conditions that decide whether the Flow runs in the trigger's entry criteria (the Start element's
  filters), not in a Decision after it. Without entry criteria the Flow runs on every save, and Code Analyzer's
  Flow scanner fails CI (`flow:TriggerEntryCriteria`).
- No Get Records, Create, Update or Delete inside a Loop. Every element that touches data has a fault path.
- Also add an Apex test that inserts or updates records so the Flow runs, and asserts its result. Production deploys
  Flows as active (`enableFlowDeployAsActiveEnabled`), which needs Apex tests that exercise the active Flows.
- Commit the Flow with `<status>Active</status>`. Run its tests with `sf flow run test -o issue-12 --test-level RunLocalTests`
  then `sf flow get test -o issue-12 --test-run-id <id>`.

## Deploying and testing in the scratch org
The workflow gives you the story (title, acceptance criteria, where to see it) as a file, and an authenticated scratch org alias (for example `issue-12`) in the prompt. Type it literally: shell variables in commands are blocked by the agent's safety checks.
- Deploy: `sf project deploy start -o issue-12 -d force-app --ignore-conflicts`
- Test: `sf apex run test -o issue-12 --test-level RunLocalTests --code-coverage --result-format human --wait 20`
- Fix failures before committing. Do not commit with failing tests.

## UI tests
UI tests check what the platform **stores**, not what was typed: Salesforce changes some values when a record
changes state (closing an Opportunity with a future Close Date sets it to today; a Lead conversion copies fields). Use
realistic dates in the past, read the record back (`sf data get record`) for the expected value, and assert that.

Playwright specs live in `e2e/`. A story's own spec is `e2e/story-<key>.spec.ts` (for example `e2e/story-28.spec.ts`); label the PR `test` to run it, with or without AI. Use role and label locators (`getByRole`, `getByLabel`), never CSS class selectors. Log in with `login(page)` from `e2e/support/login.ts`, then navigate with `openPath(page, "/lightning/...")` from the same file. There is no Playwright `baseURL`, so `page.goto("/relative")` fails. Run a spec with `SCRATCH_ALIAS=<alias> npx playwright test <file>`. After each acceptance criterion's assertion, call `evidence(page, "AC<n>: <what it shows>", <locator>)` from `e2e/support/evidence.ts` (at most 6): with `UI_EVIDENCE=true` a passing run posts those screenshots on the story; otherwise, and in every local or staging run, it does nothing. It keeps only the page's Lightning path, never a URL (a front-door URL carries a session). It never fails a test: a locator that finds nothing is skipped after 5 seconds with a warning (`evidence: "..." skipped`), so fix the locator when you see one.
