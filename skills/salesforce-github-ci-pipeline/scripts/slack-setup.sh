#!/bin/bash
# Usage: slack-setup.sh <owner/repo> <repo-dir> [--notices-only] [--app-name "SF Pipeline"]
# Optional Slack for the pipeline (references/slack.md), in the order that works, asking the person only for what
# only they can do, and never printing a secret:
#   1. (buttons) deploys the Slack actions Worker to Cloudflare and learns its URL
#   2. opens Slack's "create app from manifest" page, pre-filled: incoming webhook + chat:write, interactivity on with
#      the Worker's URL, Socket Mode OFF (with it on, every button shows a bare warning)
#   3. reads the webhook URL, signing secret, bot token and a GitHub token from the keyboard (hidden) and stores them:
#      GitHub secret SLACK_WEBHOOK_URL; Worker secrets SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GITHUB_TOKEN, SLACK_USERS
#   4. sets SLACK_ACTIONS=true (buttons) and sends a test message (Actions › slack-test)
# Re-runnable: each step says what it found, and Enter skips a value that is already set.
set -euo pipefail
REPO="${1:?owner/repo}"; DIR="$(cd "${2:?repo dir}" && pwd)"; shift 2
BUTTONS=true; NAME="SF Pipeline"
while [ $# -gt 0 ]; do case "$1" in --notices-only) BUTTONS=false ;; --app-name) NAME="$2"; shift ;; esac; shift; done
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local v; read -r -s -p "$1 (hidden; Enter to skip): " v; echo >&2; printf '%s' "$v"; }
gh auth status >/dev/null 2>&1 || { echo "Log in to GitHub first: gh auth login"; exit 1; }
[ -f "$DIR/.github/workflows/slack-test.yml" ] || { echo "$DIR has no slack-test workflow: update it from the template first"; exit 1; }

URL=""
if $BUTTONS; then
  say "1/4 The Slack actions Worker (Cloudflare, free tier)"
  [ -f "$DIR/pipeline/slack/worker.mjs" ] || { echo "no pipeline/slack/worker.mjs in $DIR"; exit 1; }
  ( cd "$DIR/pipeline/slack" && npx --yes wrangler whoami 2>/dev/null | grep -q "logged in" ) || ( cd "$DIR/pipeline/slack" && npx --yes wrangler login )
  URL=$(cd "$DIR/pipeline/slack" && npx --yes wrangler deploy 2>&1 | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
  [ -n "$URL" ] || { echo "the deploy printed no workers.dev URL: run 'npx wrangler deploy' in pipeline/slack and read why"; exit 1; }
  echo "Worker: $URL (it refuses anything not signed by Slack)"
else
  say "1/4 Notices only: no Worker"
fi

say "2/4 The Slack app (from a manifest: nothing to click through, Socket Mode off)"
MANIFEST=$(sed -e "s#__APP_NAME__#$NAME#g" -e "s#__REQUEST_URL__#${URL:-https://example.invalid}#" "$SKILL/assets/slack-app-manifest.json")
$BUTTONS || MANIFEST=$(printf '%s' "$MANIFEST" | jq -c '.settings.interactivity = {is_enabled: false} | .oauth_config.scopes.bot = ["incoming-webhook"]')
LINK="https://api.slack.com/apps?new_app=1&manifest_json=$(printf '%s' "$MANIFEST" | jq -c . | tr -d '\n' | jq -sRr @uri)"
open "$LINK" 2>/dev/null || xdg-open "$LINK" 2>/dev/null || echo "Open: $LINK"
cat <<EOF
In the page that opened: pick the workspace, Next, Create. Then:
  - Install App (left) › Install to Workspace › pick the channel for notices › Allow
  - Incoming Webhooks › copy the Webhook URL (the row for your channel)
$($BUTTONS && echo "  - Basic Information › App Credentials › Signing Secret (Show, copy)
  - OAuth & Permissions › Bot User OAuth Token (xoxb-…)")
If the page did not open the manifest, choose "From a manifest" and paste:
$MANIFEST
EOF

say "3/4 Secrets (typed, never shown)"
HOOK=$(ask "Webhook URL")
if [ -n "$HOOK" ]; then
  [[ "$HOOK" =~ ^https://hooks\.slack\.com/services/ ]] || { echo "that is not a Slack webhook URL"; exit 1; }
  printf '%s' "$HOOK" | gh secret set SLACK_WEBHOOK_URL -R "$REPO" && echo "GitHub secret SLACK_WEBHOOK_URL set"
fi
if $BUTTONS; then
  put() { printf '%s' "$2" | (cd "$DIR/pipeline/slack" && npx --yes wrangler secret put "$1" >/dev/null) && echo "Worker secret $1 set"; }
  S=$(ask "Signing Secret"); [ -z "$S" ] || put SLACK_SIGNING_SECRET "$S"
  T=$(ask "Bot User OAuth Token (xoxb-…)"); if [ -n "$T" ]; then [[ "$T" == xoxb-* ]] || { echo "a bot token starts xoxb-"; exit 1; }; put SLACK_BOT_TOKEN "$T"; fi
  echo "A GitHub token for the Worker: fine-grained, this repository only, Repository permissions › Contents: Read and write."
  open "https://github.com/settings/personal-access-tokens/new" 2>/dev/null || echo "Create it at https://github.com/settings/personal-access-tokens/new"
  G=$(ask "GitHub token")
  if [ -n "$G" ]; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $G" "https://api.github.com/repos/$REPO")" = 200 ] || { echo "that token cannot read $REPO"; exit 1; }
    put GITHUB_TOKEN "$G"
  fi
  echo "Who may act from Slack, and as whom: Slack member IDs (profile › ⋮ › Copy member ID) with GitHub logins,"
  echo "for example: U0123ABCD=octocat U0456EFGH=hubot   (Enter to keep the current list)"
  read -r -p "People: " PEOPLE
  if [ -n "$PEOPLE" ]; then
    for p in $PEOPLE; do [[ "$p" =~ ^[UW][A-Z0-9]+=[A-Za-z0-9-]+$ ]] || { echo "not SlackID=github-login: $p"; exit 1; }; done
    JSON=$(tr -s ' ' '\n' <<<"$PEOPLE" | jq -Rn '[inputs | split("=") | {(.[0]): .[1]}] | add')
    put SLACK_USERS "$(printf '%s' "$JSON" | jq -c .)"
  fi
  gh variable set SLACK_ACTIONS -R "$REPO" --body true && echo "SLACK_ACTIONS=true: notices carry buttons"
fi

say "4/4 A test message"
gh workflow run slack-test.yml -R "$REPO" --ref main && sleep 8
ID=$(gh run list -R "$REPO" -w slack-test -L 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$ID" -R "$REPO" --exit-status >/dev/null 2>&1 && echo "Sent: look in the channel." || echo "The test did not send: gh run view $ID -R $REPO --log"
$BUTTONS && echo "Try a button: Actions › slack-test › Run workflow with an issue number sends that card with its buttons. Logs: npx wrangler tail (in pipeline/slack)."
