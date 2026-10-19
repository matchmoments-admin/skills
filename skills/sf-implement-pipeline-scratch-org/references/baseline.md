# The production baseline

## What's captured

`config/baseline.json` (start from `assets/config/baseline.json`) sets what's captured:

- **`types`:** the metadata types copied.
- **`customisedOnly`:** layouts, pages, apps, quick actions, list views, compact layouts and path assistants. Only
  members a person changed after the org was created are kept, because the platform ships hundreds of untouched
  defaults.
- **Children of standard objects** (fields, rules, record types...) arrive only through those children. A custom field
  on a standard object is always kept.
- **Dropped:** managed (namespaced) members, and anything last modified by Salesforce or the Automated Process.
- **`exclude`:** `Type` or `Type:Name` with `*` wildcards. The defaults exclude connected apps, certificates, auth
  providers, profiles, and the CI user's own `Pipeline_CI` permission set. Add the org's own exclusions here.
- **`watch`:** types listed in the drift report but never copied: Experience sites, territories, entitlements,
  translations, Email Services. Each needs a feature switched on in the scratch definition first. Then move it to
  `types`.
- **`folders`:** reports, dashboards and email templates are listed per folder.

## Capture

`scratch-org baseline capture` (the scheduled `baseline` step):

1. List and filter, then `retrieve` into a metadata folder, then `convert` into `baseline/`.
2. One owner: subtract what the source folders hold.
3. Drop empty shells: sharing-rule files with no rules, `<CustomObject/>` left once the source owns a field.
4. Add production's org-wide defaults where a new org's differ.
5. **Sanitize** every XML file:
   - Throws if a file holds a secret (a password, a consumer secret).
   - Dashboards run as the logged-in user.
   - Users named in workflow, approval, assignment, auto-response and escalation rules become `__SCRATCH_ADMIN__`,
     which the deploy replaces with the org's admin.
   - Queue and group user members are stripped.

It writes `drift.md`: what changed since git, who changed it and when, and what production has that the baseline
doesn't copy. Production is only read.

## Reviewing drift

The step pushes `baseline-refresh` and runs `BASELINE_PR_COMMAND` to open a PR that a person reviews. A merged drift
PR changes the baseline id, so every org redeploys it on its next `ready`. Run it nightly, and after each production
release.

Drift from production means someone changed production directly in Setup. That's worth seeing even when the answer is
"merge it".

## Modes (`BASELINE`)

- **soft** (default): if components fail, those `baseline/` files are dropped and the deploy retried; if it still
  fails, the source deploys alone. Warnings name each dropped file.
- **strict:** any failure fails the build. Use it once the baseline deploys cleanly.
- **off:** the source only.

A component that fails on every build (it needs a missing feature, or async Apex jobs are pending) belongs in
`exclude`, or in `watch` until the scratch definition enables what it needs.

## Limits

- `StandardValueSet` can't be listed, so a picklist value added to a standard field (Lead Source, Industry) isn't
  copied. Put the ones that matter in the source.
- Profiles aren't copied: permission sets carry access.
- Users, roles' members and record data are never copied.
