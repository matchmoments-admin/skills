# Domain glossary

The words the pipeline and its code use. Module names in `pipeline/` follow these terms.

| Term | Meaning |
| --- | --- |
| **Story** | One unit of work with acceptance criteria. Lives in the **tracker** (a GitHub issue today, a Jira issue later). Identified by its **story key**: `12` on GitHub, `LIFE-123` on Jira. |
| **Story branch** | The git branch for a story. Its name is the story key in branch form: `issue-12`, or `LIFE-123` for Jira. Nothing else; the title stays on the PR. |
| **Sprint** | A time box with a name such as `2026-w41`. Has a **release branch** `release/<sprint>`, a tracker container (GitHub milestone `Sprint <sprint>` or a Jira sprint) and a **staging org**. Only one sprint is open at a time. |
| **Release candidate** | The open release branch, proposed for production by the **release PR** into `main`. |
| **Hotfix** | A story labelled `hotfix`: its branch starts from `main` and its PR targets `main`. |
| **Tracker** | Where stories and sprints live. One module with two adapters: GitHub Issues and Jira. |
| **Issue org** | The scratch org for one story (alias `issue-12`), built from production's **shape** and the story branch. Lives 3 days; deleted when the story merges. |
| **Staging org** | The scratch org for one sprint (alias `staging`), holding the whole release branch. Lives 30 days; deleted when the sprint ships. |
| **Org registry** | How a later job finds an org an earlier job made: the Dev Hub's `ScratchOrgInfo` records, matched on Description (`issue-12`, `staging-2026-w41`). |
| **Shape** | Production's edition, features and settings, captured in the Dev Hub. Scratch orgs copy it; code and data never come from it. |
| **Verdict** | A gate input produced by an agent-free job as a commit status on the exact commit it judged: `pipeline/ai-review` and `pipeline/ui-test`. Labels such as `review:pass` are for people only. A failed verdict on the code always blocks. |
| **AI feature flag** | A repository variable (`AI_IMPLEMENT`, `AI_REVIEW`, `AI_FIX`, `AI_UI_TEST`, `AI_AUTO_CHAIN`, `AI_TRIAGE`) that turns one AI step on. Unset = off; with all off the pipeline is manual. Each flag replaces exactly one manual step, and the gate requires an AI verdict only when its flag is on. |
| **Triage** | A cheap typed decision by Jev (TypeSafe), behind `AI_TRIAGE`: review risk, and UI failure kind (flake, test, feature). It never writes, and any failure falls back to what the pipeline does without it. |
| **Gate** | The decision whether a PR may merge, and how. Routes: **feature** (story into the release branch, squash), **hotfix** (into `main`, squash, then release), **release** (release branch into `main`, merge commit, then release), **back-merge** (`main` into the release branch). |
| **Sign-off** | The human input to a gate: an approving review, or the `ready` label on a PR the person wrote themselves. PRs into `main` need an approving review. A back-merge needs none: it only carries code already approved and in production. |
| **Production validation** | A check-only deploy of the merge result to production with all tests. A gate input for PRs into `main`; the release quick-deploys exactly that validation. |
| **Close-out** | What the release does after deploying: close shipped stories, carry over unfinished ones, close the sprint, delete its orgs and branch. |
| **Pipeline identity** | The GitHub App the pipeline acts as, so its PRs and pushes trigger CI like a person's. |
