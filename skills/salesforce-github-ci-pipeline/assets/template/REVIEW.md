# Review rubric

Review the pull request diff against the linked issue's acceptance criteria and `CLAUDE.md`.

## Severity
- **blocker**: wrong behaviour, security issue (missing sharing or FLS, injection, hard-coded secret), data loss, missing bulk safety, tests that cannot fail.
- **major**: missing test category (negative, permission, bulk), missing permission set entry, an acceptance criterion not met, a field or component missing from the page layout or UI the issue's "Where to see it" describes.
- **minor**: naming, duplication, comment quality, small clarity issues.

## Flows
- **blocker**: a Get, Create, Update or Delete element inside a Loop; a recursive trigger (a flow updating the record that
  triggers it, after save, with no entry condition that stops it); hard-coded record IDs.
- **major**: a record-triggered Flow without entry criteria on its Start element (conditions only in a Decision);
  a new or changed record-triggered Flow without a Flow test; a data element without a fault path; entry
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
