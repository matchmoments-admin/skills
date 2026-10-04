# Jira as the tracker

Only the tracker changes. Branches, PRs, gates, approvals, scratch orgs and deploys stay as they are: every Salesforce step reads the branch, and the gates read GitHub checks and reviews.

## Set-up

1. Install **GitHub for Jira** (Atlassian Marketplace) and connect the GitHub organisation. Keys in branch names, commits and PR titles then link branches, PRs, builds and the `production` environment's deployments to each issue.
2. A Jira service account and API token. Repo secrets `JIRA_EMAIL`, `JIRA_API_TOKEN`; repo variable `JIRA_BASE_URL` (`https://<site>.atlassian.net`) and `TRACKER=jira`. Expose them to the workflows' `env`.
3. A token Jira can use to call GitHub, stored as a Jira Automation secret. Start with a fine-grained token limited to the repo (Contents: read and write, for `repository_dispatch`). For production use, a small relay that mints the pipeline App's installation token, so no long-lived token sits in Jira.
4. Add a `repository_dispatch` trigger beside the label trigger in `issue-start` (`types: [jira-start]`), `ai-implement` (`jira-implement`), `sprint-start` (`jira-sprint-start`) and `release-cut` (`jira-release-cut`), reading `github.event.client_payload.key` / `.sprint`.
5. Jira Automation rules, each "Send web request" `POST https://api.github.com/repos/<owner>/<repo>/dispatches` with body `{"event_type":"jira-start","client_payload":{"key":"{{issue.key}}"}}`:
   - issue transitioned to *In Progress* → `jira-start`
   - issue transitioned to *AI Build* (or label `ai-implement`) → `jira-implement`
   - sprint started → `jira-sprint-start` with `{"sprint":"{{sprint.name}}"}`
   - version released, or the sprint marked ready → `jira-release-cut`

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
