# Gotchas

Every one of these happened in sf-lifecycle-labs. The test-run gotchas are in salesforce-scratch-org-tests'
`references/gotchas.md`. These are the ones that bite long-lived feature orgs.

## Creating orgs

- **"The org shape version is outdated"**: production's shape ages out after a release. `create()` refreshes it
  (`sf org create shape`, about 2 to 10 minutes) and retries once. Snapshot builds hit this first.
- **No free slot, with another team's org holding it**: the Dev Hub's allowance is shared. The error lists the
  descriptions holding slots, marking any that aren't this pipeline's. `ORG_RESERVE` keeps slots free for others.
- **The daily allowance resets at 00:00 UTC** on the Developer Edition Dev Hubs we saw, not on a rolling 24 hours.
- **A failed creation can still hold a slot**: `create()` deletes the half-made org by its description before
  retrying or falling back.
- **A snapshot Salesforce refuses** (expired, or from an old shape) costs a daily org on every try. The engine falls
  back to the shape. A login or network error isn't the snapshot's fault and is retried once instead.
- **`ScratchOrgInfo.Description` can't be filtered in SOQL** (long text): the engine lists active orgs and matches in
  code.

## Logging in and users

- **`sf org create user` fails with a JWT login on Hyperforce.** People's logins are created as `User` records
  instead, and then `System.resetPassword` emails them.
- **Roles copied by the org shape can't be assigned** ("invalid cross reference id"). New orgs from the shape get their
  roles rebuilt as metadata, before the deploy, because sharing rules attach to them.
- **Permission sets deploy, but nobody holds them**, so new fields are invisible. `prepare()` assigns every permission
  set in the source to the org's admin. `login` gives a person all of them, or none for an admin.
- **A full org can't add a user** (`LICENSE_LIMIT_EXCEEDED`): `login` deactivates the UI tests' `persona.*` users and
  retries.
- **Re-attaching:** a later job reaches an org with the Dev Hub's JWT key and the org's admin username. Scratch org
  admins inherit the connected app's trust. Nothing needs an `sfdxAuthUrl`.
- **Logging the same user in under a new alias drops its old alias** on that machine. It doesn't matter on CI agents,
  but it does on a laptop.

## Deploying

- **Baseline and source reference each other** (a layout names a field the branch adds; a branch's Flow uses a
  production field), so they go in one deploy. Two deploys fail.
- **A pending async Apex job blocks redeploying its classes.** A seed record that fires automation queuing a job makes
  every later `ready` retry those baseline files. Keep such records out of the seed.
- **Components dated 1970-01-01** are how production lists custom metadata records, assignment rules and workflows.
  The capture treats them as customised, not as "never modified".
- **Sharing rules on an object a scratch org lacks**: production lists a sharing file for every object, even empty
  ones. Capture drops the empty shells.
- **An approval process missing from the org**: check `drift.md`'s "production has, scratch orgs don't" list.
  `ApprovalProcess` must be in `types`.
- **`FORCE_COLOR` breaks `sf --json`**: the engine sets `FORCE_COLOR=0` and `NO_COLOR=1`.

## CI

- **Two jobs in one org corrupt each other.** Every step that touches a branch's org needs the same
  `concurrency_group: scratch-org/<branch>`, including login and changes.
- **A shallow clone**: `sameSourceGit` needs the previous commit. Without it the org is simply redeployed, which is
  slower but correct.
- **A sweep with an empty branch list would delete every feature org.** The CLI refuses an empty list. A failed
  `ls-remote` gives none, and then it deletes only CI orgs.
