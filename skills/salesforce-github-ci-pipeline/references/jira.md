# Jira as the tracker

Only the tracker changes. Branches, PRs, gates, approvals, scratch orgs and deploys stay as they are: every Salesforce step reads the branch, and the gates read GitHub checks and reviews.

## Set-up

1. Install **GitHub for Jira** (Atlassian Marketplace) and connect the GitHub organisation. Keys in branch names, commits and PR titles then link branches, PRs, builds and the `production` environment's deployments to each issue.
2. A Jira service account and API token. Run [`scripts/jira-setup.sh`](../scripts/jira-setup.sh)
   `<owner/repo> <https://<site>.atlassian.net> <PROJECT>` with `JIRA_EMAIL` and `JIRA_API_TOKEN` in the shell: it
   checks the login, the project, *In Progress* and a Done-category status (*AI Build* only with `AI_IMPLEMENT`), sets
   nothing, and prints the commands for repo secrets `JIRA_EMAIL`, `JIRA_API_TOKEN` and repo variables `TRACKER=jira`,
   `JIRA_BASE_URL`. The workflows need no edit. `secrets.JIRA_EMAIL` and `secrets.JIRA_API_TOKEN` (empty until set)
   go only to the steps that run main's `pipe` commands that use the tracker; `pipe` builds the tracker on first use,
   so no other command needs them. No job, agent, `npm` script or Playwright spec ever gets them; a pipeline test
   checks. `JIRA_BASE_URL` is a setting carried by `PIPELINE_VARS`.
3. A token Jira can use to call GitHub, stored as a Jira Automation secret. Start with a fine-grained token limited to the repo (Contents: read and write, for `repository_dispatch`). For production use, a small relay that mints the pipeline App's installation token, so no long-lived token sits in Jira.
4. Nothing to add: `issue-start` (`jira-start`), `ai-implement` (`jira-implement`), `sprint-start`
   (`jira-sprint-start`) and `release-cut` (`jira-release-cut`) already have their `repository_dispatch` trigger beside
   the label or button, reading `github.event.client_payload.key` / `.sprint` / `.version`. Release-cut runs one at a
   time and cuts only when the released version's name is the open sprint's (name each sprint's fix version after the
   sprint); any other version, such as a hotfix's, leaves a notice and cuts nothing.
5. Jira Automation rules, each "Send web request" `POST https://api.github.com/repos/<owner>/<repo>/dispatches` with body `{"event_type":"jira-start","client_payload":{"key":"{{issue.key}}"}}` (`jira-setup.sh` prints all four with the repo filled in):
   - issue transitioned to *In Progress* → `jira-start`
   - issue transitioned to *AI Build* (or label `ai-implement`) → `jira-implement`
   - sprint started → `jira-sprint-start` with `{"sprint":"{{sprint.name}}"}`
   - version released → `jira-release-cut` with `{"version":"{{version.name}}"}` (the version named after the sprint)

## What maps to what

| GitHub Issues | Jira |
| --- | --- |
| Issue `#12`, branch `issue-12` | Issue `LIFE-123`, branch `LIFE-123` (conventions accept both) |
| Labels `start`, `ai:implement` | Transitions *In Progress*, *AI Build* |
| Milestone "Sprint 2026-w42" | Jira sprint `2026-w42` |
| Close + comment | Comment + transition to Done (`tracker.done`) |
| Carry-over (remove milestone) | Jira moves unfinished issues at sprint completion; the pipeline only comments |
| GitHub Release tag | Fix version (mark released in the release job if wanted) |

Approvals stay on GitHub; Jira's development panel links to each PR.

## Limits

- The Jira adapter is unit-tested against mocked REST; prove it once on a real site with a tracer story before relying on it.
- Jira Free limits Automation runs per month; a team needs Standard or above.
