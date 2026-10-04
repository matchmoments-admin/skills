# Review rubric

Review the pull request diff against the linked issue's acceptance criteria and `CLAUDE.md`.

## Severity
- **blocker**: wrong behaviour, security issue (missing sharing or FLS, injection, hard-coded secret), data loss, missing bulk safety, tests that cannot fail.
- **major**: missing test category (negative, permission, bulk), missing permission set entry, an acceptance criterion not met, a field or component missing from the page layout or UI the issue's "Where to see it" describes.
- **minor**: naming, duplication, comment quality, small clarity issues.

## How to report
1. Leave inline comments on the exact lines. Start each with `[blocker]`, `[major]` or `[minor]` and say how to fix it.
2. Post one summary comment that ends with exactly one verdict line:
   - `AI-REVIEW: PASS` when there are no blockers or majors.
   - `AI-REVIEW: CHANGES` otherwise.
3. Do not approve or merge. Do not push commits. Be specific and brief.
