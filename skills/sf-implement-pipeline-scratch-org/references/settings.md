# Settings

Settings are environment variables: on the step, in the pipeline's `env`, or from the agent's environment hook.
Secrets come only from Buildkite Secrets or the agent's hook, never from YAML.

| Name | Default | What it does |
| --- | --- | --- |
| `SF_DEVHUB_CLIENT_ID` | (secret) | The connected app's consumer key (`make-ci-cert.sh` in salesforce-scratch-org-tests). |
| `SF_DEVHUB_USERNAME` | (secret) | The CI user in the Dev Hub. It must hold the `Pipeline_CI` permission set. |
| `SF_DEVHUB_JWT_KEY` | (secret) | The PEM private key. The step script writes it to a 600 temp file, removed on exit. |
| `SF_LOGIN_URL` | `https://login.salesforce.com` | The Dev Hub's login URL (its My Domain works too). |
| `DEVHUB_ALIAS` | `devhub` | The CLI alias of the Dev Hub. |
| `DEFAULT_BRANCH` | the pipeline's default branch | The trusted checkout (`CONFIG_ROOT`). |
| `CONFIG_ROOT` | the working directory | Set by the step script to the trusted checkout. |
| `SOURCE_DIRS` | `sfdx-project.json` package directories | The branch's source folders, space separated. |
| `SCRATCH_DEF` | `config/scratch-feature.json` | The scratch definition, relative to `CONFIG_ROOT`. It names production as `sourceOrg`. |
| `ORG_PREFIX` | `feat-` | The prefix of feature orgs' Dev Hub descriptions and aliases. The sweep deletes any org with this prefix whose branch is gone, so the prefix must be one **no other tool or person uses** on the same Dev Hub. Check with `sf data query -o devhub -q "SELECT Description FROM ScratchOrgInfo WHERE Status='Active'"` before choosing it. |
| `ORG_DAYS` | `7` | A feature org's lifetime (1 to 30). An expired org is rebuilt by the next `ready`. |
| `ORG_RESERVE` | `0` | Slots a new feature org leaves free, for CI test orgs and people working by hand. |
| `BASELINE` | `soft` | `soft`, `strict` or `off` (`baseline.md`). |
| `SEED` | `on` | `off` loads no test data. |
| `SCRATCH_SNAPSHOT` | (newest `LCB…` snapshot) | Force a snapshot, or `off`. Snapshots are optional; see `buildkite.md`. |
| `COUNTRY_CODE` | (unset) | Set it (for example `GB`) when production uses State and Country picklists, so users get a valid country. |
| `TESTER_TIMEZONE`, `TESTER_LOCALE` | the org admin's | For people's logins. |
| `USERNAME_SUFFIX` | `pipeline` | People's logins are `<name>.uat@<orgid>.<suffix>`. `changes` counts only these users' Setup changes. |
| `BASELINE_PR_COMMAND` | (unset) | The shell command that opens the drift PR from branch `baseline-refresh` (`buildkite.md`). |
| `SNAPSHOT_MAX_AGE_HOURS` | `20` | The snapshot step does nothing while the newest snapshot is younger than this. |
