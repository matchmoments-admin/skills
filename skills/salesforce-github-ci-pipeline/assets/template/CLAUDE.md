# Conventions for this repository

This repo is a Salesforce DX project. Humans and AI agents both change it only through GitHub issues and pull requests.

## Rules for every change
- Work only on the branch you were given: the story key in branch form (`issue-12`, or a Jira key such as `LIFE-123`). Never push to `main`.
- Never edit `.github/` or `pipeline/` in story work (the delivery pipeline itself; see `CONTEXT.md`). Pipeline
  maintenance happens on non-story branches into main, reviewed against `REVIEW.md` only; CI blocks story PRs that touch it.
- Keep the change scoped to the issue's acceptance criteria. Do not refactor unrelated code.
- Pipeline maintenance: after changing `pipeline/`, `.github/`, `scripts/` or `config/`, run `scripts/skills-sync.sh`
  and commit `.claude/skills` (and the skills repo), so the reusable skill rebuilds exactly this. CI checks it.
- Never commit secrets, auth URLs, keys or `.sfdx`/`.sf` folders.
- Commit messages: `type(scope): summary (#<issue>)`, for example `feat(account): add tier field (#12)`.
- The PR body must contain `Closes #<issue>` and a short test plan.

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
Playwright specs live in `e2e/`. A story's own spec is `e2e/story-<key>.spec.ts` (for example `e2e/story-28.spec.ts`); label the PR `test` to run it, with or without AI. Use role and label locators (`getByRole`, `getByLabel`), never CSS class selectors. Log in with `login(page)` from `e2e/support/login.ts`, then navigate with `openPath(page, "/lightning/...")` from the same file. There is no Playwright `baseURL`, so `page.goto("/relative")` fails. Run a spec with `SCRATCH_ALIAS=<alias> npx playwright test <file>`.
