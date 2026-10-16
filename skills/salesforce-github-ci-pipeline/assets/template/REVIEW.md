# Review rubric

Review the pull request diff against the linked issue's acceptance criteria and `CLAUDE.md`.
Before calling a Salesforce detail wrong (a report interval, a metadata value, a test annotation), check
`docs/agents/salesforce.md` "Facts agents got wrong"; a confident false blocker costs a fix round. The Playwright spec
(`e2e/story-<key>.spec.ts`) is written by the UI test step **after** this review, so its absence here is never a
finding. Comments on the story and its spec since they were written win over the spec text (the story file lists them). Check what CI's
**Salesforce tests** check run says failed: a failing test is always at least a major.

## Severity
- **blocker**: wrong behaviour, security issue (missing sharing or FLS, injection, hard-coded secret), data loss, missing bulk safety, tests that cannot fail.
- **major**: anything the change needs that the deploy does not carry (a run-once script, "add these members by hand",
  a public group's members): production would get it empty. See `docs/agents/salesforce.md`.
- **major**: missing test category (negative, permission, bulk), missing permission set entry, an acceptance criterion not met, a field or component missing from the page layout or UI the issue's "Where to see it" describes.
- **major**: a new or changed Apex test class without `@IsTest(testFor='ApexClass:X,ApexTrigger:Y')` naming the classes
  and triggers it tests (class level). CI and the production validation run `RunRelevantTests`: an unannotated test
  is only picked by Salesforce's own dependency analysis, which can miss it. Sharing and access tests also say `critical=true`.
  `testFor` names only Apex classes and triggers: a test class whose subject is a Flow (or other metadata) with no
  class or trigger to name uses `@IsTest(critical=true)` instead, and that is correct (never ask for `testFor='Flow:...'`).
- **minor**: naming, duplication, comment quality, small clarity issues.

## What already exists (the story file's "The codebase today")
Check the change against what is already there, including names marked **(production)**: production's own components,
built outside this pipeline, in every scratch org and in production.
- **major**: a second trigger on an object that has one; a new Flow or Apex doing what an existing one already does on
  the same object and event; a change that duplicates a production component instead of using it.
- **major**: a change the existing automation would break or fight: data that an active validation, duplicate or
  workflow rule refuses or rewrites, a field an existing Flow or Apex also sets, access that a sharing rule already
  gives or takes away. Name the existing component in the finding.

## Flows
- **blocker**: a Get, Create, Update or Delete element inside a Loop; a recursive trigger (a flow updating the record that
  triggers it, after save, with no entry condition that stops it); hard-coded record IDs.
- **major**: a record-triggered Flow without entry criteria on its Start element (conditions only in a Decision);
  a Flow test that does not cover the Flow's paths (a missing Flow test already fails CI: `pipe tests flow-gaps`).
  A Flow that reads or writes a related record (the parent Account, its owner) cannot have a Flow test (it faults):
  an Apex test that declares `// Flow test: <Flow API name>: <why>` and asserts what the Flow did covers it, CI accepts
  it, and it meets a story's "A Flow test covers it". Never ask for a Flow test then (docs/agents/salesforce.md, Tests);
  a data element without a fault path; entry
  criteria broader than the story needs (the flow runs on every save); an after-save flow doing what a before-save
  flow could.

## Access (CLAUDE.md "Access")
CI's access check already fails profiles, administrator permissions, View All / Modify All, a class with no sharing
keyword, unexplained `without sharing`, and new fields or objects no permission set grants. Its findings (warnings
too) are in the access report you are given. Review what it cannot judge:
- **blocker**: a query or DML a user triggers that runs in system mode without a reason (`@AuraEnabled`, invocable
  Apex, a screen Flow); `without sharing` whose stated reason does not hold; a new object or field public to external users.
- **major**: a new custom object not Private with no reason in the plan; a permission test that would pass with no
  permission set at all (it relies on a Public Read/Write org-wide default or a system-context Flow and asserts nothing
  about access); a permission set broader than the story needs (edit where read is enough, objects it never uses).
- **minor**: a permission set without a description of who it is for.

## How to report
1. Leave inline comments on the exact lines. Start each with `[blocker]`, `[major]` or `[minor]` and say how to fix it.
2. Post one summary comment that ends with exactly one verdict line:
   - `AI-REVIEW: PASS` when there are no blockers or majors.
   - `AI-REVIEW: CHANGES` otherwise.
3. Do not approve or merge. Do not push commits. Be specific and brief.
