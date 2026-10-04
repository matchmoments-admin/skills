#!/bin/bash
# Usage: create-app.sh <owner> <repo> [app-name]
# Creates the pipeline's GitHub App with the manifest flow, so the person only clicks "Create" and "Install":
#   1. writes and opens a page that posts the pre-filled manifest to GitHub
#   2. the person clicks Create; GitHub redirects to the repo with ?code=... in the address bar
#   3. paste the code here; it is exchanged (single use, 1 hour) for the App ID and private key,
#      which go straight into repo secrets PIPELINE_APP_ID / PIPELINE_APP_PRIVATE_KEY (never printed)
#   4. the person installs the App on the repo (link printed)
set -euo pipefail
OWNER="${1:?owner}"; REPO="${2:?repo}"; NAME="${3:-$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')-pipeline}"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
MANIFEST=$(sed -e "s/__APP_NAME__/$NAME/" -e "s/__OWNER__/$OWNER/g" -e "s/__REPO__/$REPO/g" "$SKILL/assets/github-app-manifest.json" | jq -c .)
ESCAPED=$(printf '%s' "$MANIFEST" | sed 's/&/\&amp;/g; s/"/\&quot;/g')
if [ "$(gh api "users/$OWNER" --jq .type)" = "Organization" ]; then ACTION="https://github.com/organizations/$OWNER/settings/apps/new"; else ACTION="https://github.com/settings/apps/new"; fi
cat > "$TMP/create-app.html" <<EOF
<!doctype html><meta charset="utf-8"><title>Create the pipeline App</title>
<body style="font:16px system-ui;max-width:620px;margin:40px auto;line-height:1.5">
<h2>Create the pipeline GitHub App</h2>
<p>App <code>$NAME</code> for <b>$OWNER</b>: no webhook; Contents, Pull requests, Issues, Actions, Workflows (read and write), Checks (read).</p>
<form action="$ACTION" method="post"><input type="hidden" name="manifest" value="$ESCAPED">
<button type="submit" style="font-size:18px;padding:10px 18px">Continue to GitHub</button></form>
<p>Click <b>Create GitHub App</b> there, then copy the <code>code</code> from the address bar of the page you land on.</p></body>
EOF
open "$TMP/create-app.html" 2>/dev/null || xdg-open "$TMP/create-app.html" 2>/dev/null || echo "Open $TMP/create-app.html in a browser"
read -r -p "Paste the code: " CODE
umask 077
curl -s -X POST -H "Accept: application/vnd.github+json" "https://api.github.com/app-manifests/$CODE/conversions" > "$TMP/app.json"
jq -e .id "$TMP/app.json" >/dev/null || { echo "Exchange failed: $(jq -r .message "$TMP/app.json")" >&2; exit 1; }
gh secret set PIPELINE_APP_ID -R "$OWNER/$REPO" --body "$(jq -r .id "$TMP/app.json")"
jq -r .pem "$TMP/app.json" | gh secret set PIPELINE_APP_PRIVATE_KEY -R "$OWNER/$REPO"
gh variable set PIPELINE_BOTS -R "$OWNER/$REPO" --body "github-actions,$(jq -r .slug "$TMP/app.json")"   # bots allowed to start agents
echo "App $(jq -r .slug "$TMP/app.json") (id $(jq -r .id "$TMP/app.json")) created; secrets and PIPELINE_BOTS stored."
echo "Install it on the repo: https://github.com/apps/$(jq -r .slug "$TMP/app.json")/installations/new"
