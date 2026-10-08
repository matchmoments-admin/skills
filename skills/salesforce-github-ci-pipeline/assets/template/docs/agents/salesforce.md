# Salesforce for the engineering skills

The engineering skills (`to-spec`, `to-tickets`, `tdd`, `diagnosing-bugs`, `pr`, `code-review`,
`improve-codebase-architecture`) were written for TypeScript apps with fast local tests. This page says what their advice
means here, where the code is Apex, record-triggered Flows (XML), permission sets, layouts and LWC, and every test runs
in a scratch org after a deploy. CLAUDE.md's rules still win.

## Seams (where a spec says "we test it here")

Test at the highest seam a user or another system touches; prefer one that exists.

| What changes | The seam | A test there |
| --- | --- | --- |
| Record automation (Flow or trigger) | **The record**: insert or update it, then read it back | Apex test: DML in system mode, assert the stored field |
| A record-triggered Flow's paths | The Flow's entry criteria and outcome | Flow test (`flowtests/`), triggering record meets the entry criteria |
| Apex used by a page or another class | The public static method (`AccountSelector.goldTier()`) | Apex test calling it, as a limited user in `System.runAs` |
| An LWC | Its `@AuraEnabled` controller method (Apex test) and what the page shows (Playwright) | both |
| Who may see or change it | `System.runAs` a user **with** and one **without** the permission set | Apex permission test: one refused, one allowed |
| What a person sees | The record page in the scratch org | Playwright spec `e2e/story-<key>.spec.ts` |

Not seams: private helpers, a Flow's internal elements, a trigger's handler internals.

## Specs (`to-spec`)

Publish a **Spec** issue (`docs/agents/issue-tracker.md`). In its template:

- **User stories**: "As a <Salesforce persona: sales rep, service agent, admin>, I want..., so that...".
- **Implementation decisions** say, for each object touched: new fields (type, required?), the automation (record-triggered
  Flow before or after save, or a trigger handler; one per object and trigger type), the permission set that grants it,
  the layout or Lightning page it appears on, and the **Access** decision (org-wide default, run mode). No file paths.
- **Testing decisions** use the seams above; prior art is the existing test class for the same object.
- **One-way doors** (list them): deleting or retyping a field, changing an org-wide default, data changes in production,
  removing a permission users rely on.

## Stories (`to-tickets`)

**One story per spec by default** ("Make it a story" on the spec; every agent on the story reads the whole spec). Split
only when one slice cannot pass the production validation alone, by hand, with `Blocked by #N` (the pipeline will not
start, or merge, a story before #N has merged). When you do split, each story is a **vertical slice that deploys on its own and passes the production validation**: the field, its
permission set entry, the automation, the layout or page, and its tests together. Never a "fields first, tests later"
slice: production rejects a deploy whose tests do not cover it. Write each in the story body format
(`docs/agents/issue-tracker.md`), label `feature`, link blockers natively. Expand-contract for a field rename or retype:
add the new field and copy (story 1), move every reference (story 2..n), delete the old field (last story, a one-way door).

## Tests (`tdd`)

The loop is red → green, but each run is a deploy plus a scratch-org test run (minutes, holding the org's lane), so:

- Batch per acceptance criterion: write the tests for one criterion, deploy, run them (`--tests Class.method`), then the code.
- Tests run as production's CI user does: no story permission set. Set up and read data in system mode
  (`AccessLevel.SYSTEM_MODE`, `WITH SYSTEM_MODE`); test access only inside `System.runAs`.
- Every class: positive, negative, permission (refused without the permission set) and bulk (200 records) cases.
- Mocks: `Test.setMock` for callouts, `Test.loadData` or small factories for data; never mock the database.
- Flows: a Flow test per path whose triggering record meets the entry criteria; "the Flow does not run" is an Apex test.

## Facts agents got wrong (check these before flagging or "fixing" them)

- **Report date intervals** (`<timeFrameFilter><interval>`): `INTERVAL_CURY` is the current **calendar** year,
  `INTERVAL_CURFY` the current **fiscal** year (`INTERVAL_PREVY`/`INTERVAL_NEXTY` likewise). `INTERVAL_CALYEAR` does
  not exist. `describeReport` reports `INTERVAL_CURY` as the duration `THIS_YEAR`. (PR #144's review called it fiscal.)
- **Tests run as production's CI user, without the story's permission sets** (`asProductionUser`). Anything that
  depends on field access, such as `describeReport` groupings on a custom field, `Schema...isAccessible()` or a query
  `WITH USER_MODE`, must run inside `System.runAs` a user who holds the permission set. Otherwise it passes in your
  story org and fails in CI (PR #144: `List index out of bounds: 0` on `getGroupingsDown()[0]`).
- **Everything a story needs reaches production by the deploy: no run-once scripts.** Nothing runs a `data/*.apex` or
  "run this after the deploy" step in UAT or production. Some things cannot be deployed as metadata, notably a
  **public group's members**. Design around them: share a report folder (`folderShares`), a sharing rule or a queue with
  **Roles** (`Role`, not `RoleAndSubordinates`, when subordinates must not get it) instead of a group whose members
  would arrive empty (PR #144).
- **Report folder sharing cannot be asserted in an Apex test.** As a user who cannot see the folder, a query on its
  reports fails with `Data Not Available`, which the test cannot catch. Verify folder shares by the deploy (every
  `folderShares` role or group must exist) and in the UI test, never with a `System.runAs` Apex test (PR #144).
- **Org Shape scratch orgs: their roles cannot be given to a user** ("invalid cross reference id"). Org provisioning
  rebuilds them (delete, leaves first; recreate as Role metadata) before the deploy, so personas and role-shared
  folders work. A role you create in the org is fine.
- **Scratch orgs have very few user licences** (`LICENSE_LIMIT_EXCEEDED` after a handful of users). `loginAs` frees
  licences by deactivating other persona users; never create users per test run.
- **`sf org create user` refuses JWT-authorised orgs on Hyperforce.** Create users as records (`sf data create record -s
  User`) with permission set assignments as records.
- **UI tests log in as a persona with `loginAs(page, { role, permsets })`** (Salesforce's "Log in as", turned on in
  scratch orgs by org provisioning): no password exists. A report or record hidden from the user shows "The requested
  resource does not exist".
- **Test data:** Apex tests make their own (they cannot see org data). The org's seed (`data/seed`, synthetic) is for
  UI tests, Flow checks and people: read seed records by name, create only what a test changes.
- **Every Apex test class declares what it tests:** `@IsTest(testFor='ApexClass:CaseHandler,ApexTrigger:CaseTrigger')`
  at class level (not on methods), and sharing or access tests add `critical=true` (they always run). CI and the
  production validation use `RunRelevantTests` (Salesforce beta, API 66+): the platform picks the tests a change
  affects, and each deployed class still needs 75% coverage on its own. It can run 0 tests and pass; the pipeline
  then runs its own selection (CI) or every test class (production). Flow tests are never part of it.
- **Reports in Apex tests** need `@IsTest(SeeAllData=true)` to find the org's report definitions; suppress
  `PMD.ApexUnitTestShouldNotUseSeeAllDataTrue` on exactly those methods and keep the data assertions in SOQL tests
  without SeeAllData.

## Debugging (`diagnosing-bugs`)

The tight loop is **one test method** in the story's org: `sf apex run test -o <alias> --tests Class.method --synchronous`
(or `sf flow run test --tests Flow.Test`, or one Playwright spec). Read the failure and its stack first; for more, run with
a debug log (`sf apex run test ... --detailed-coverage` and `sf apex get log -o <alias> --number 1`); never a streaming
`sf apex tail log` in CI. Write the regression test that fails first, then fix. Common causes here: the test relied on
the running user's access, a Flow's entry criteria never matched, a validation rule or another Flow on the same object,
a 200-record bulk limit (SOQL or DML in a loop).

## PR bodies (`pr`)

Summary: the smallest metadata view, for example a tree of what changed per object
(`Account → Sales_Region__c (picklist) → Sales_Region_Access → Account Layout`) or a Flow's decision path. Evidence: the
Apex and Flow test results for this change (class.method pass/fail, coverage of changed classes) and what the UI test
saw (link the story's **UI evidence** comment when there is one); before and after for a fix. Merge Danger: one-way doors above; blast radius in Salesforce terms (one object, every
user of a page, every Opportunity save). Keep `Closes #N` and the test plan.

## Review (`code-review`)

Two axes. **Spec**: each acceptance criterion met, missing or partly met; anything built that no criterion asked for.
**Standards**: REVIEW.md (sharing, field access, bulk safety, Flow rules, Access) instead of a generic smell list.

## Architecture (`improve-codebase-architecture`)

Deep modules here: one trigger per object delegating to a handler with a small public interface; one record-triggered
Flow per object and trigger type; selectors that own the queries for an object (user mode). Shallow signs: several Flows
on one object and event, logic split between a Flow and a trigger for the same field, queries scattered across classes.
