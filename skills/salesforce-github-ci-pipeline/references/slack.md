# Slack (optional)

The pipeline is complete without Slack: the story card on the issue says what is happening and what is next. Slack
adds two things, each optional, each off until set up:

| Level | What people get | Needs | Cost |
| --- | --- | --- | --- |
| **Notices** | One channel hears when a card's turn changes: **👉 your turn** (the card's Next line), **❌ something failed** (with *see what went wrong*), **🚀 shipped** (once per release). Every work item number links back to it. | A Slack app with an incoming webhook; GitHub secret `SLACK_WEBHOOK_URL` | Free |
| **Actions** | Each notice carries the card's next options as buttons, done as the person who clicked: **Start the sprint, then this story**, **Make it a story**, **Rewrite the spec**, **✍️ Answer in Slack** (a box; the text lands on the issue as theirs, then the spec or plan is rewritten), **Plan it**, **Start**, **Build it**, and on the story's PR **Fix it**, **Re-run CI**, **Review again**, **UI test**. **Approve** is a link to GitHub. | The Slack actions Worker (Cloudflare), the same app with interactivity, `SLACK_ACTIONS=true` | Free tier (100k clicks a day) |

Approvals never happen in Slack: a GitHub approval is the person's own review, and the two-person rule and the audit
trail depend on it. `ship`, `review-ok`, UAT sign-off, `gate` and `staging` are never buttons.

## Set it up

Run [`scripts/slack-setup.sh`](../scripts/slack-setup.sh) `<owner/repo> <repo-dir>` (add `--notices-only` for level 1).
It deploys the Worker, opens Slack's **create app from manifest** page pre-filled from
[`assets/slack-app-manifest.json`](../assets/slack-app-manifest.json), reads every secret from the keyboard without
showing it, stores each where it belongs, and sends a test message. What it does, by hand:

1. **Worker** (actions only): `cd pipeline/slack && npx wrangler login && npx wrangler deploy`. It prints
   `https://sf-pipeline-slack.<account>.workers.dev`: the Request URL.
2. **Slack app**, from the manifest (recommended: it sets everything below in one go), or **Create New App › From
   scratch** and then:
   - **OAuth & Permissions › Bot Token Scopes**: `incoming-webhook`, and `chat:write` for actions (it creates the bot
     token the answer box needs). No events.
   - **Socket Mode: off.** With it on, Slack sends clicks to a connection nothing holds open and every button shows a
     bare ⚠️, while *Open the card* (a plain link) still works. The "Starter app" and "AI agent" templates turn it on.
   - **Interactivity & Shortcuts**: on, **Request URL** = the Worker's URL, **Save Changes** (bottom right).
   - **Install to Workspace**, pick the channel, **Allow**. Reinstall when Slack asks after a scope change.
3. **Secrets** (never pasted into a chat, a ticket or a screenshot: the curl example on the Incoming Webhooks page
   shows the whole URL):
   - GitHub secret `SLACK_WEBHOOK_URL`: **Incoming Webhooks › Webhook URL** (the URL only, not the curl).
   - Worker secrets (`npx wrangler secret put <NAME>`, or the dashboard: **Workers › sf-pipeline-slack › Settings ›
     Variables and Secrets**, type *Secret*):
     - `SLACK_SIGNING_SECRET`: **Basic Information › App Credentials › Signing Secret**. The Worker trusts nothing
       without it.
     - `SLACK_BOT_TOKEN`: **OAuth & Permissions › Bot User OAuth Token** (`xoxb-…`), only for the answer box.
     - `GITHUB_TOKEN`: a fine-grained token, this repository only, **Contents: Read and write**. It can start the
       pipeline (`repository_dispatch`) and nothing a person could not do with a tick box.
     - `SLACK_USERS`: `{"U0123ABCD": "github-login", ...}`: who may act from Slack, and as whom (Slack profile ›
       **⋮ › Copy member ID**). A secret, not a `wrangler.toml` var: the repo stays generic and a deploy never resets
       it. An unlinked person who clicks is told their ID.
4. **Repository variable** `SLACK_ACTIONS=true` (actions only). Without it, notices carry links only.
5. **Check**: **Actions › slack-test › Run workflow** sends one test message; with an issue number it brings that card
   up to date and sends its notice with its buttons. Click one: a private "⏳ Done as @login…" note answers.

## How it works

```
Slack button ──► Worker (pipeline/slack/worker.mjs, Cloudflare)
                 1. Slack's v0 signature, under 5 minutes old (else 401)
                 2. Slack user → GitHub login (SLACK_USERS)
                 3. only the allowed actions (worker.mjs ACTS)
                 4. answers Slack at once (3-second limit); the rest in waitUntil
                 5. repository_dispatch "slack-act" {number, command, by, text, pr?}
                 6. a private note to the clicker (response_url)
            ──► .github/workflows/slack.yml: checks the payload again, posts typed answers as the person's words
                 (plan.relayBody; read as theirs only when the pipeline posted it), then `pipe act --by <login>`:
                 write access and the two-person rule apply exactly as for a comment command
```

- **Notices** come from the cards (`pipeline/src/notify.mjs`): the card before an update is compared with the card
  after it, as `notifyNeeds` does for @mentions, so a turn is announced once, never while a ⏳ row shows the pipeline
  working, and a story's shipping is left to its release's one message. Buttons are the card's own tick boxes.
- **Why a Worker**: Slack sends a click to a URL and wants an answer in 3 seconds; GitHub cannot receive it (Actions
  start only from GitHub events or a call with a GitHub token, and Slack cannot add one). The Worker checks, translates
  and dispatches; it holds no state and runs nothing between clicks.
- **Other hosts**: the Worker is one dependency-free file (Web Crypto, `fetch`). It ports to AWS Lambda (function URL)
  or Vercel in an hour; on Lambda, answer Slack first and work after, since a cold start eats into the 3 seconds.
  **Socket Mode** fits only a company that allows no inbound endpoints: the same code then runs as a small always-on
  service inside its network (and has to be kept running).

## When it does not work

| What you see | Why | Fix |
| --- | --- | --- |
| A button shows ⚠️ with no message; *Open the card* works | Socket Mode on, or no Request URL saved | Socket Mode off; Interactivity › Request URL; **Save Changes** |
| "Your Slack account is not linked to GitHub yet" | The clicker is not in `SLACK_USERS` | Add `"<their ID>": "<login>"`; the note shows their ID |
| "The pipeline was not started (GitHub said 401/403/404)" | The Worker's `GITHUB_TOKEN` cannot dispatch to this repo | A fine-grained token for this repo with Contents: Read and write |
| "The answer box did not open (…)" | No or wrong `SLACK_BOT_TOKEN`, or the trigger expired | Bot token `xoxb-…` (add `chat:write`, reinstall) |
| "Done as …" but nothing on GitHub | `slack.yml` refused the payload, or `pipe act` said no | **Actions › slack**: the run's log; a refusal is also commented on the issue |
| No notices at all | `SLACK_WEBHOOK_URL` unset, or the workspace removed the app (a trial ending does this) | **Actions › slack-test**; a new webhook if needed |
| Unit tests posted to the channel | A test built the real notifier because CI carries the secret | Already guarded: the test step blanks it and `pipeline/test/helpers.mjs` deletes it |

Logs: `npx wrangler tail` in `pipeline/slack` (one JSON line per click and per step, never a secret or typed text),
or the dashboard's **Logs** (`[observability]` in `wrangler.toml`).

## Keeping it safe

- The webhook URL is a credential (anyone with it can post to the channel); rotate it if it was shown anywhere.
- The Worker's GitHub token can do what a tick box does, as whoever `SLACK_USERS` names: keep that list to people
  with write access (`pipe act` checks it anyway) and rotate the token with the repo's other secrets.
- Remove a leaver from `SLACK_USERS` and the channel; their clicks are refused from then on.
