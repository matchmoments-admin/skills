# The engine

These modules are copied from sf-lifecycle-labs' `pipeline/src/` (main at `2f20a1e`, 2026-10-18), where they build
every story's scratch org. They talk to Salesforce only through the `sf` CLI. Nothing here calls GitHub.

`scripts/sync-engine.sh` compares this copy with sf-lifecycle-labs. Any difference not listed below is an upstream
change to bring across by hand.

## Copied unchanged

`org/snapshot.mjs`. `org/data.mjs` has only a header line added, and the volume accounts no longer set a billing
country.

## Changed, and why

| File | Change | Why |
| --- | --- | --- |
| `conventions.mjs` | Rewritten small. It keeps only `storyOf` and `orgFor`, and adds `descriptionFor` and `isPipelineOrg`. Any branch gets an org: its Jira key if it has one, otherwise a slug of the branch. Names over 80 characters are cut and given a hash. `ORG_PREFIX`, `SCRATCH_DEF` and `ORG_DAYS` are settings. No sprint, UAT or staging kinds. | Upstream accepts only `issue-N` or Jira-key branches, and carries GitHub labels, AI switches and sprints. |
| `settings.mjs` | Removed. Settings are plain environment variables (`references/settings.md`). | Upstream reads GitHub repository variables (`PIPELINE_VARS`). |
| `io.mjs` | `gh`, `ghPages` and `sourceFiles` are removed. `CONFIG_ROOT` (default: the working directory) replaces `PIPELINE_ROOT`. New `sourceDirs()` reads `SOURCE_DIRS`, else `sfdx-project.json`'s package directories (not `baseline/`), else `force-app`. | No GitHub. The trusted checkout is a setting. Repos at work often have more than one package directory. |
| `baseline.mjs` | New `ownedKey()`. `subtractOwned()` takes several folders and matches on metadata identity (`classes/A.cls`), not on the path under `force-app/main/default`. `composeProject()` takes `sourceDirs` and `cwd`. `capture()` takes `sourceDirs`. | Ownership has to hold whatever the folder layout. |
| `org.mjs` | Removed: `advanceCovered` (CI's delta-deploy bookkeeping), `sameSourceVia` (the GitHub compare API), the sprint volume step, and the `story*` re-exports. New: `sameSourceGit(git)` (same check, from git), `activeOrgs()`, `attach()` reusing an alias already logged in as the org's admin (no JWT key needed on a laptop), a `dirs` option, `CONFIG_ROOT` paths, the `keyFile` default in the OS temp folder, and a neutral snapshot `orgName`. | No GitHub. Several source folders. |
| `org/fleet.mjs` | `findOrphans()` decides by **open branches** (`openBranches`), not by PRs and the tracker. `DEVHUB` is `DEVHUB_ALIAS` (default `devhub`). Removed: `createRefusal`, `storyRefusal`, `mergedBefore`, `doneStoryOrgs`. | Works on any VCS. If the branch list is unknown, no feature org is ever deleted. |
| `org/users.mjs` | `permissionSets()` reads several folders. The country is `COUNTRY_CODE` (unset by default). The tester's time zone and locale come from the org's admin, unless `TESTER_TIMEZONE` or `TESTER_LOCALE` is set. The username suffix is `USERNAME_SUFFIX` (default `pipeline`). | Upstream hard-codes Australia. |
| `org/setup-changes.mjs` | Uses `USERNAME_SUFFIX` to find the people whose Setup changes count. | Matches `users.mjs`. |

## Re-syncing

1. Run `scripts/sync-engine.sh <path to sf-lifecycle-labs>`. It shows each file's diff against upstream.
2. Bring each upstream fix across. Keep the changes above.
3. Run `node --test tests/*.test.mjs`.
4. Update the commit at the top of this file.
