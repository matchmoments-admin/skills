# An existing enterprise org

The template was proven on a fresh Developer Edition org. An established Enterprise or Unlimited org (years of
Setup changes, Flows, managed packages, no source control) needs these steps first. Do them in order; each one is
done when its check passes.

## 1. Dev Hub and allowances

- Enable Dev Hub in production (Setup › Dev Hub). It is one-way, creates no data, and is what most enterprises use.
  Allowances: Enterprise 40 active / 80 a day, Unlimited and Performance 100 / 200 (Developer Edition 3 / 6).
- Ask the Salesforce admin for a dedicated **integration user** for CI (API Only profile or permission set), so the
  JWT login is not a person's account. Assign it the `Pipeline_CI` permission set from `make-ci-cert.sh`.

Done when: `sf org list limits -o <prod>` shows `ActiveScratchOrgs` with the expected max.

## 2. Bring production into source

```bash
sf project generate manifest --from-org <prod> --name full --output-dir manifest   # everything production has
sf project retrieve start -o <prod> --manifest manifest/full.xml --ignore-conflicts
```

Then curate, because the first retrieve is far bigger than what a team owns:
- Keep what the team changes: objects and fields, Flows, layouts, FlexiPages, permission sets, validation rules,
  record types, custom metadata types (definitions), Apex and LWC.
- Drop or `.forceignore` what it does not: managed package components (namespaced, `xyz__Thing__c` where `xyz` is
  a package namespace), profiles (use permission sets), standard value sets nobody edits, reports and dashboards
  (unless the team versions them), `*.settings` except the few the pipeline owns.
- Commit that as the baseline on `main`, tagged `baseline`: from here on, git is the source of truth and changes
  made directly in production are drift (the weekly org-shape refresh and `sf project retrieve` diff show them).

Done when: a scratch org from `config/scratch-dev.json` deploys the curated `force-app` with no errors (expect a
few rounds: missing features in the definition, package dependencies, references to deleted components).

## 3. Managed packages

Org Shape copies edition, features and settings, not installed packages. List them and put the ones the source
depends on in `config/packages.json`; the org registry installs them in every new scratch org before deploying:

```bash
sf package installed list -o <prod>      # SubscriberPackageVersionId = the 04t id
```

```json
[{ "name": "DocuSign eSignature", "id": "04t...", "keyEnv": "DOCUSIGN_INSTALL_KEY" }]
```

`keyEnv` names a repository secret for packages that need an installation key. Some packages cannot be installed
in scratch orgs (licence-bound); exclude the components that need them, or develop those stories in a sandbox.

## 4. Flows-first teams

Most enterprise orgs are built in Flow Builder. The template handles Flows as first-class:
- `scripts/ci/flow-tests.sh` runs every Flow test in CI and in the staging regression.
- `CLAUDE.md` / `REVIEW.md` Flow rules: before-save first, a Flow test and an Apex test per record-triggered Flow,
  no data elements in loops, fault paths.
- Production must have **Deploy processes and flows as active** on (`FlowSettings.enableFlowDeployAsActiveEnabled`,
  `devhub-setup/.../Flow.settings-meta.xml`). It is off by default: without it every deployed Flow arrives
  inactive, the pipeline is green and the automation silently does nothing. With it on, production deploys need
  Apex tests that run the active Flows, which the Apex-test rule provides.
- Jev review triage never skips a Flow, workflow rule or approval process: they are logic.

## 5. A sandbox before production (optional)

Enterprises often want UAT in a full-copy or partial sandbox. Add it as a release step, not a branch:
`release` deploys the validated release to the UAT sandbox, a person signs off there, then the production quick
deploy runs. Authenticate the sandbox with the same JWT app (`--instance-url https://test.salesforce.com`).
On GitHub Enterprise, a `uat` environment with required reviewers gives a native "approve to continue" button;
on Team it must be a PR approval or a workflow_dispatch.

## 6. People and Slack

- CODEOWNERS with the Salesforce team as owners of `force-app/`, so approvals come from the right group.
- Slack: post the story card's **Next** line to a channel when it changes (incoming webhook), with an
  **Approve here** link button. Threads per story need a bot token.
- Jira: see `jira.md`; the story card is mirrored as a Jira comment (no diagram, Jira does not render Mermaid).

## 7. If the company runs Buildkite

See `buildkite.md`.
