#!/bin/bash
# Usage: github-setup.sh <owner/repo> <ci-username> <repo-dir>
# Idempotent. Run from the repo after Phase 2. Needs gh logged in as an org admin with scopes repo, workflow, admin:org
# (gh auth refresh -h github.com -s admin:org). Reports each item.
set -euo pipefail
R="${1:?owner/repo}"; CI_USER="${2:?ci username}"; DIR="${3:?repo dir}"
OWNER="${R%%/*}"; SKILL="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "== secrets"
gh secret set SF_CI_CONSUMER_KEY -R "$R" --body "$(cat secrets/consumer-key.txt)" && echo "SF_CI_CONSUMER_KEY set"
gh secret set SF_CI_USERNAME -R "$R" --body "$CI_USER" && echo "SF_CI_USERNAME set"
gh secret set SF_CI_PRIVATE_KEY -R "$R" < secrets/ci.key && echo "SF_CI_PRIVATE_KEY set"
gh secret list -R "$R" | grep -q '^CLAUDE_CODE_OAUTH_TOKEN' \
  && echo "CLAUDE_CODE_OAUTH_TOKEN present" \
  || echo "!! CLAUDE_CODE_OAUTH_TOKEN missing: the user runs 'claude setup-token' then 'gh secret set CLAUDE_CODE_OAUTH_TOKEN -R $R' in their own terminal"

echo "== AI switches (all off unless the user chose them in Phase 0; set with: gh variable set AI_REVIEW -R $R --body true)"
gh variable list -R "$R" | grep -E '^(AI_|PIPELINE_BOTS)' || echo "none set: the pipeline runs without AI"
gh secret list -R "$R" | grep -q '^TYPESAFE_API_KEY' && echo "TYPESAFE_API_KEY present (Jev, for AI_TRIAGE)" || echo "TYPESAFE_API_KEY absent (only needed for AI_TRIAGE)"

echo "== Actions may open PRs (org first, then repo; JSON body, -F is ignored)"
BODY='{"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}'
if [ "$(gh api "users/$OWNER" --jq .type)" = "Organization" ]; then
  echo "$BODY" | gh api -X PUT "orgs/$OWNER/actions/permissions/workflow" --input - >/dev/null && echo "org policy set" || echo "!! org policy needs admin:org scope"
fi
echo "$BODY" | gh api -X PUT "repos/$R/actions/permissions/workflow" --input - >/dev/null && echo "repo policy set"
gh api "repos/$R/actions/permissions/workflow"

echo "== labels"
GH_REPO="$R" node pipeline/bin/pipe.mjs labels sync

echo "== production environment: deploy from main only"
echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT "repos/$R/environments/production" --input - >/dev/null
gh api "repos/$R/environments/production/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main \
  || gh api -X POST "repos/$R/environments/production/deployment-branch-policies" -f name=main -f type=branch >/dev/null
echo "production: main only"

echo "== branch rulesets"
for f in "$SKILL"/assets/rulesets/*.json; do
  NAME=$(jq -r .name "$f")
  if gh api "repos/$R/rulesets" --jq '.[].name' | grep -qxF "$NAME"; then echo "ruleset exists: $NAME"
  else gh api -X POST "repos/$R/rulesets" --input "$f" --jq '"ruleset created: " + .name'; fi
done

echo "== proof: a direct push to main must be refused"
echo "   git commit --allow-empty -m probe && git push origin HEAD:main   # expect GH013, then: git reset --hard HEAD~1"
