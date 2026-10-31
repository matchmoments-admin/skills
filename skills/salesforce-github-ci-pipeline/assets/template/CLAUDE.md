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
- Third-party Apex libraries (FFLib and the like) are **vendored**: unmodified, under `force-app/vendor/<library>/`, and
  listed in `docs/vendor.md`. Add or update one only with `scripts/vendor.sh <name> <https://github.com/owner/repo>
  <commit SHA> "<why>" <folder>...` (for example the repo's `sfdx-source/<x>/main` and `.../test`): it copies upstream
  byte for byte at that commit and writes the docs row. Never copy, retype or edit vendored files yourself (keep
  upstream's API versions; they deploy as they are), and never put our own code there: the access check, Code
  Analyzer and Prettier skip that folder. Our code that uses the library follows every rule below.
- One trigger per object, logic in its FFLib domain class (see Record automation), `with sharing` by default.
- Bulk-safe: no SOQL or DML in loops; handle 200 records.
- Use `WITH USER_MODE` or `Security.stripInaccessible` on user-facing queries.
- No hard-coded IDs, URLs or credentials. Use custom metadata or Named Credentials.
- Every class needs tests covering: a positive case, a negative case, a permission case (run as a limited user) and a bulk case (200+ records). Use `Assert` class methods, not `System.assert`.
- Overall coverage must stay at or above 75%; new classes should reach 90%.

## Metadata
- `baseline/` is production's copy of everything not in `force-app` (the production baseline: refreshed by a bot PR after
  each release). It is deployed into every scratch org with `force-app` and **never** to production. Never edit it. To
  change one of its components, retrieve it from your story's org into `force-app` (`sf project retrieve start -m
  <Type>:<Name>`): `force-app` then owns it and the next capture drops it from `baseline/`.
- API version 67.0. Every new custom field and object needs a permission set entry. Metadata deploys grant no field access by themselves.
- A component users see must be on the Lightning record page they use. Ship the FlexiPage in `force-app` and activate it as the org default for the object with an `actionOverrides` entry (View, Large, Flexipage) in the object's `.object-meta.xml`, so every environment shows the same page.
- A field users edit must also be on the page layout they use. Retrieve the layout from the scratch org first (`sf project retrieve start -o issue-12 -m "Layout:Account-Account Layout"`), add the field, and commit the layout. Scratch orgs copy production's shape, so a retrieved layout only references what production has.
- Reference data (settings an admin changes) goes in custom metadata, not hard-coded constants.
- A behaviour that must be switched on separately from its deploy (a gradual rollout, a quick off switch) checks a
  custom permission `Feature_<Name>` (`FeatureManagement.checkPermission('Feature_<Name>')`) granted by a permission set
  of the same name: on for the users who hold it, off for everyone else. Test both states with `System.runAs`.

## Access (permissions, sharing, org-wide defaults)
Least privilege: a user gets exactly the access the story needs, and every grant can be reviewed. CI's **access check**
(`pipe access check`) fails the build on the blockers below; the review checks the rest.
- Grant access with **permission sets**, never by editing profiles. A permission set is one capability
  (`<Thing>_Access`), and it is listed in the **permission set group** of every persona that needs it
  (`permissionsetgroups/<Persona>.permissionsetgroup-meta.xml`, one group per business role or process, such as
  `Support_Agent`). Users hold groups, never loose sets, so a deploy that adds a set to a group reaches everyone in that
  role. CI fails a new permission set that no group lists (except a `Feature_<Name>` switch, which goes to chosen users). Assigning a group to people is an admin's job in each org (or
  a User Access Policy), never a deploy step. To take a permission away from one persona, use the group's muting
  permission set rather than a second, narrower set.
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
  them away from the scratch org's user for the test run), but **with production's own permission sets** (it holds
  `Timesheet_Self_Approve`, for one), which a scratch org's user does not have. So set up and read test data in system
  mode (`Database.insert(records, AccessLevel.SYSTEM_MODE)`, `[SELECT ... WITH SYSTEM_MODE]`), and run anything that
  depends on who the user is (field access, a custom permission, `FeatureManagement.checkPermission`) inside
  `System.runAs` with a user you create and assign exactly the permission sets the case needs, mock unit tests included.
  A test that relies on the running user's permissions, either way, passes in a scratch org and fails in production
  (story #381).
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
- Every Apex class or trigger the change touches reaches **85% coverage** (CI fails below it). Write the tests as
  `docs/agents/apex-testing.md` says: DML-free unit tests with fflib mocks for the logic, a few seam tests with
  `System.runAs` for what a mock cannot prove, and records from `<Object>Builder` classes. The fflib mocks need FFLib
  vendored (`docs/vendor.md`); a repo without it yet uses the same two layers with `Test.StubProvider` stubs.

## The agreed plan
When the story file has an "Agreed plan" (from `/plan`) and "Answers", build what the plan says; where an answer
differs from the plan, the answer wins. Do not build anything the plan and the acceptance criteria do not ask for.

## Record automation (Apex first)
Salesforce's record-triggered automation guide: **one entry point per object**, never Flow and Apex triggers mixed on
it. Here that entry point is Apex, with FFLib (`docs/fflib.md`). CI's automation check (`pipe automation check`) fails
a mix, and a new record-triggered Flow with no reason.
- One trigger per object, one line: `fflib_SObjectDomain.triggerHandler(<Objects>.class);`, listing the events the
  domain handles. The **domain** class `<Objects>` (plural, `Cases`) holds the object's rules: before-save field defaults
  in `onBeforeInsert`/`onBeforeUpdate` (no DML needed), related records and actions in `onAfterInsert`/`onAfterUpdate`
  ("changed to" by comparing with `ExistingRecords`). Queries go in a selector, DML in the unit of work from
  `Application` (`Application.UnitOfWork.newInstance()`; the first story that needs it adds `Application` as
  `docs/fflib.md` shows), one `commitWork()`. Never logic in the trigger body.
- An object whose automation is already Apex (the story file's "The codebase today": **Automation entry point**) gets
  the new rule in its domain. An object with no automation gets a trigger and a domain. An existing static handler
  (`HealthCheckTriggerHandler`) moves into a domain when a story changes it.
- A record-triggered Flow only for a named reason, written in its description as `flow: <why>` (an admin owns and
  changes the rule, say), and only on an object with no Apex trigger. Adding a trigger to an object that has
  record-triggered Flows means moving those Flows into the domain, and deleting them, in the same story. Screen,
  scheduled and autolaunched Flows are not entry points: use them as before.

### When a Flow is used
- Before-save (`RecordBeforeSave`) for field updates on the same record; after-save only for related records or
  actions. One flow per object and trigger type.
- Every new or changed record-triggered Flow ships with at least one Flow test in `force-app/main/default/flowtests/`.
  A Flow test's triggering record must meet the Flow's entry criteria (a record that does not start the Flow fails
  the test), so Flow tests cover the paths inside the Flow; cover "the Flow does not run" in the Apex test. File and
  API names use letters, digits and single underscores only, e.g. `Case_Default_Web_Priority_Web_Medium.flowtest-meta.xml`.
- Put the conditions that decide whether the Flow runs in the trigger's entry criteria (the Start element's
  filters), not in a Decision after it. Without entry criteria the Flow runs on every save, and Code Analyzer's
  Flow scanner fails CI (`flow:TriggerEntryCriteria`).
- No Get Records, Create, Update or Delete inside a Loop. Every element that touches data has a fault path.
- Also add an Apex test that inserts or updates records so the Flow runs, and asserts its result. Production deploys
  Flows as active (`enableFlowDeployAsActiveEnabled`), which needs Apex tests that exercise the active Flows.
- Commit the Flow with `<status>Active</status>`. Run its tests with `sf flow run test -o issue-12 --test-level RunLocalTests`
  then `sf flow get test -o issue-12 --test-run-id <id>`.
- Removing a Flow: a deploy cannot delete a Flow version that is active. Deactivate it first (commit the Flow with
  `<status>Obsolete</status>`), and delete it in a later story; say in the plan which release does which.

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
