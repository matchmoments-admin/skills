# Gotchas (each one happened)

## Orgs and the Dev Hub

- **`The consumer key is already taken`** while deploying to the scratch org → the deploy included a production-only
  folder (the CI connected app). → `SOURCE_DIRS` lists only the folders that belong in a scratch org.
- **`client identifier invalid`** at JWT login → the client ID was empty or for another app. → Check
  `SF_DEVHUB_CLIENT_ID` is the connected app's consumer key and the CI user has the app's permission set.
- **Deleting an org you are not logged in to** → delete its `ActiveScratchOrg` record in the Dev Hub
  (`sf data delete record -s ActiveScratchOrg -w "SignupUsername='…'"`); no org login needed.
- **`ScratchOrgInfo.Description` cannot be filtered in SOQL** (long text). → Query active orgs, filter in jq.
- **A failed creation can still use allowance**; creation also fails transiently. → One retry; the sweep cleans up.
- **Daily allowance is a rolling 24 hours** in the docs; observed resets at 00:00 UTC on Developer Edition.
- **Org Shape copies edition, features and settings, not managed packages** → `config/packages.json`.
- **Source-tracking conflicts** when deploying to an org this runner did not create → not an issue here (every org
  is new); for long-lived orgs use `--ignore-conflicts`.

## Tests

- **Flow tests: `This class name's value is invalid: flowtesting`** → `--tests` needs `<FlowApiName>.<TestName>`.
- **Flow tests run asynchronously** → start, then poll `sf flow get test --test-run-id`.
- **A Flow test fails though the Flow is right** → its triggering record must meet the Flow's entry criteria; Flow
  tests cannot test "the Flow does not run". Cover that in Apex.
- **Run Flow tests by name from git**, not RunLocalTests: an org can hold tests a branch deleted.
- **`flow:TriggerEntryCriteria`** from Code Analyzer → put a record-triggered Flow's conditions in the Start element.
- **Production deploys Flows inactive** unless `FlowSettings.enableFlowDeployAsActiveEnabled` is on.
- **`FORCE_COLOR` breaks `sf --json`** (Playwright and some CI images set it) → the script sets `FORCE_COLOR=0`.

## Shell

- **macOS bash 3.2**: no `mapfile`, and `"${arr[@]}"` of an empty array fails under `set -u` → the scripts use
  `${arr[@]+"${arr[@]}"}` and temp files.
- **A cancelled build** sends TERM: the script traps INT/TERM to exit, so its EXIT trap deletes the org.
