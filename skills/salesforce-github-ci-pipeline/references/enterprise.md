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

## 4b. RunRelevantTests (which Apex tests run)

CI and the production validation use `RunRelevantTests` (Salesforce beta from Winter '27, API 66+): the platform
runs the tests a change affects, so a story in a large org runs minutes of tests, not hours. The pipeline guards
it: CI validates just the changed components in the story org and reads the tests Salesforce chose; if the org
rejects the level or it runs 0 tests (it can, and still pass), CI runs its own selection and production runs every
test class. Each deployed class still needs 75% coverage of its own. Flow tests are never part of it. The staging
regression always runs every test, so a test the analysis missed is caught before a release.

Adopting it in an org with years of tests:
1. Run side by side for a sprint: `CI_TEST_LEVEL=selector` and `PROD_TEST_LEVEL=RunLocalTests`, then switch one
   on and compare what each ran (the Salesforce tests check lists the classes).
2. Annotate the busiest test classes first: `@IsTest(testFor='ApexClass:X,ApexTrigger:Y')` at class level
   (REVIEW.md makes it a major finding on new tests).
3. Keep a small `critical=true` set (sharing, access, the money paths): they always run.
4. Quick deploy after a RunRelevantTests validation is not documented by Salesforce; it worked on the reference
   org. If yours refuses it, set `PROD_TEST_LEVEL=RunLocalTests` until the feature is GA.

## 5. A sandbox before production (optional)

Enterprises often want UAT in a full-copy or partial sandbox. Add it as a release step, not a branch:
`release` deploys the validated release to the UAT sandbox, a person signs off there, then the production quick
deploy runs. Authenticate the sandbox with the same JWT app (`--instance-url https://test.salesforce.com`).
On GitHub Enterprise, a `uat` environment with required reviewers gives a native "approve to continue" button;
on Team it must be a PR approval or a workflow_dispatch.

## 6. People, approvers and Slack

- **Approvers.** Set the repository variable `APPROVERS` to the team's approvers, default first
  (`@lead,@senior1,@senior2`). Every story then carries an `### Approver` section (Make it a story fills in the
  default; the story form asks; edit the line to hand a story over). The gate counts an approval, a ticked
  **Sign off**, `/ship` or `/review-ok` only from that approver, or from anyone in `APPROVERS` when none is
  named or the approver pushed the latest change themselves, and **never from whoever pushed the latest change**.
  The card says who must approve and why an approval did not count. Unset, anyone with write access approves.
- The `main` ruleset has `require_last_push_approval` on (GitHub's own form of the same rule, for PRs into main).
- CODEOWNERS with the Salesforce team as owners of `force-app/`, so approvals come from the right group.
- Slack: post the story card's **Next** line to a channel when it changes (incoming webhook), with an
  **Approve here** link button. Threads per story need a bot token.
- Jira: see `jira.md`; the story card is mirrored as a Jira comment (no diagram, Jira does not render Mermaid).

## 6b. Admins, Setup and drift

- Admins keep their production logins; the pipeline never needs them. For story work they tick **Send me an admin
  login** on the story (System Administrator in its scratch org), build in Setup, then **Bring my Setup changes into
  the story**: the changes become a commit on the story branch with the admin as co-author (so another approver
  approves), CI tests them, and a PR opens.
- Changes made directly in production show up in the **drift PR** (after each release, weekly, or nightly with
  `BASELINE_NIGHTLY`), opened with a count and a "made in production, outside a story" warning. Have the approvers
  review it weekly; anything the team should own becomes a story.
- Production baseline for an established org: start `BASELINE=soft`, read the first drift PR with the approvers,
  tune `config/baseline.json` exclusions (named credentials stay: Apex compiles against them; their secrets are
  never captured), then `BASELINE=strict` once a few snapshots build cleanly.

## 6c. What a story records (reports)

Close-out writes a **Delivery record** comment on each shipped story: the named approver, who approved and when, who
pushed the latest change, the AI review or who overruled it with the full reason, the UI test and its evidence, the
UAT signer, the release tag and production validation id, and hours per stage. A JSON line in it carries the same
fields, so a GitHub or Jira report (or a script) can chart lead time and approvals without the pipeline. The weekly
metrics document has median and p90 minutes per stage.

## Next steps (not built yet)

- Parallel release trains (one staging per train) for teams shipping more than one release at a time.
- Secrets from a company vault over OIDC instead of GitHub secrets.
- Delivery record fields written to Jira custom fields (today: the comment, readable by Jira automation).
- `SEPARATE_RELEASE_APPROVER`: the release approved by someone who signed off none of its stories.

## 7. If the company runs Buildkite

See `buildkite.md`.
