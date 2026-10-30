#!/bin/bash
# Usage: JIRA_EMAIL=<service account> JIRA_API_TOKEN=<its token> jira-setup.sh <owner/repo> <https://site.atlassian.net> <PROJECT>
# Checks what TRACKER=jira needs, sets nothing, and prints the commands to run:
#   1. the login works (GET /myself);
#   2. the project exists;
#   3. its workflow has "In Progress" (jira-start) and a Done-category status (tracker.done); "AI Build" is only for
#      AI_IMPLEMENT;
#   4. the gh commands for the variables and secrets (you run them; a secret is typed at gh's prompt, never here);
#   5. the four Jira Automation rules, with this repo filled in (references/jira.md).
# The workflows already pass JIRA_EMAIL and JIRA_API_TOKEN to every pipe step, and JIRA_BASE_URL is a setting, so no
# workflow needs editing. The token is read from the environment, never from an argument, never printed, and never on
# curl's command line (other users' ps shows that): curl reads it from a netrc file only this user can read.
set -uo pipefail
R="${1:?owner/repo}"; BASE="${2:?https://<site>.atlassian.net}"; PROJECT="${3:?Jira project key, e.g. LIFE}"
BASE="${BASE%/}"
FAIL=0
bad() { echo "!! $*"; FAIL=1; }

command -v jq >/dev/null 2>&1 || { echo "!! jira-setup.sh needs jq to read Jira's answers: install it (brew install jq, apt-get install jq) and run this again"; exit 1; }
if [ -z "${JIRA_EMAIL:-}" ] || [ -z "${JIRA_API_TOKEN:-}" ]; then
  echo "!! set JIRA_EMAIL and JIRA_API_TOKEN in this shell first (a Jira service account and its API token:"
  echo "   https://id.atlassian.com/manage-profile/security/api-tokens), then run this again"
  exit 1
fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
HOST="${BASE#*://}"; HOST="${HOST%%/*}"
( umask 077 && printf 'machine %s login %s password %s\n' "$HOST" "$JIRA_EMAIL" "$JIRA_API_TOKEN" > "$TMP/netrc" )   # printf is a builtin: no process shows it
chmod 600 "$TMP/netrc"
# get <path>: the HTTP code on stdout (000 when the network failed), the body in $TMP/body
get() {
  local code
  code=$(curl -sS --netrc-file "$TMP/netrc" -H "Accept: application/json" -o "$TMP/body" -w '%{http_code}' "$BASE$1" 2>/dev/null) || true
  echo "${code:-000}"
}
# has <jq filter over the last answer>: true when it matches (jq -e; no pipe into grep -q, which can SIGPIPE)
has() { jq -e "$1" "$TMP/body" >/dev/null 2>&1; }

echo "== 1. the login ($JIRA_EMAIL at $BASE)"
CODE=$(get /rest/api/3/myself)
if [ "$CODE" = 200 ]; then echo "login works"
else bad "login refused (HTTP $CODE): check the site URL, the email and the API token"; echo "stopped: nothing else can be checked"; exit 1; fi

echo "== 2. the project"
CODE=$(get "/rest/api/3/project/$PROJECT")
if [ "$CODE" = 200 ]; then echo "project $PROJECT: $(jq -r '.name // ""' "$TMP/body")"
else bad "project $PROJECT not found (HTTP $CODE), or the service account cannot browse it"; fi

echo "== 3. the statuses the pipeline moves stories through"
CODE=$(get "/rest/api/3/project/$PROJECT/statuses")
if [ "$CODE" = 200 ]; then
  if has 'any(.[].statuses[]; .name == "In Progress")'; then echo "In Progress: present (Automation sends jira-start)"
  else bad "no \"In Progress\" status in project $PROJECT: the jira-start rule needs it (add it to the workflow)"; fi
  if has 'any(.[].statuses[]; .statusCategory.key == "done")'; then echo "Done: a done-category status is present (the pipeline closes shipped stories)"
  else bad "no Done-category status in project $PROJECT: shipped stories cannot be closed"; fi
  if has 'any(.[].statuses[]; .name == "AI Build")'; then echo "AI Build: present (Automation sends jira-implement)"
  else echo "note: no \"AI Build\" status. It is needed only with AI_IMPLEMENT=true (the jira-implement rule); add it then"; fi
  jq -r '"issue types: " + ([.[].name] | join(", "))' "$TMP/body"
else bad "could not read project $PROJECT's statuses (HTTP $CODE)"; fi

echo "== 4. run these (gh asks for each secret's value; nothing here stores one)"
cat <<EOF
gh variable set TRACKER -R $R --body jira
gh variable set JIRA_BASE_URL -R $R --body $BASE
gh secret set JIRA_EMAIL -R $R
gh secret set JIRA_API_TOKEN -R $R
EOF

echo "== 5. Jira Automation: four rules, each a \"Send web request\" POST https://api.github.com/repos/$R/dispatches"
echo "   headers: Authorization: Bearer {{secrets.GITHUB_TOKEN}} (a fine-grained token on $R, Contents: read and write),"
echo "            Accept: application/vnd.github+json"
cat <<'EOF'
   issue transitioned to In Progress  {"event_type":"jira-start","client_payload":{"key":"{{issue.key}}"}}
   issue transitioned to AI Build     {"event_type":"jira-implement","client_payload":{"key":"{{issue.key}}"}}
   sprint started                     {"event_type":"jira-sprint-start","client_payload":{"sprint":"{{sprint.name}}"}}
   version released                   {"event_type":"jira-release-cut","client_payload":{"version":"{{version.name}}"}}
   (name each sprint's fix version after the sprint, e.g. 2026-w42: release-cut cuts only when they match)
EOF

if [ "$FAIL" = 0 ]; then echo "== Jira is ready for TRACKER=jira once the commands above have run"
else echo "== fix the items marked !! and run this again"; fi
exit "$FAIL"
