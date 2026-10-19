#!/usr/bin/env bash
# Usage: scratch-org-step.sh <ready|login|changes|delete|sweep|baseline|snapshot>
# One entry point for every Buildkite step (copy to scripts/scratch-org/ in the repo, next to scratch-org.mjs and engine/).
#   - logs in to the Dev Hub by JWT (secrets: SF_DEVHUB_CLIENT_ID, SF_DEVHUB_USERNAME, SF_DEVHUB_JWT_KEY)
#   - checks out the default branch beside the build as the TRUSTED config (config/, baseline/, data/seed/): a feature
#     branch never chooses its own org shape, packages, production baseline or seed (CONFIG_ROOT)
#   - runs the command, and annotates the build with what happened (never a password or a session URL)
set -euo pipefail
ACTION="${1:?ready|login|changes|delete|sweep|baseline|snapshot}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export SF_AUTOUPDATE_DISABLE=true SF_SKIP_NEW_VERSION_CHECK=true SF_DISABLE_TELEMETRY=true
DEFAULT_BRANCH="${DEFAULT_BRANCH:-${BUILDKITE_PIPELINE_DEFAULT_BRANCH:-main}}"

# the JWT key: a 600 file for this job only, removed on exit; later commands re-attach to scratch orgs with it
KEY="$(mktemp)"; chmod 600 "$KEY"
cleanup() { rm -f "$KEY"; [ -n "${TRUSTED:-}" ] && git worktree remove --force "$TRUSTED" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if [ -n "${SF_DEVHUB_JWT_KEY:-}" ]; then printf '%s\n' "$SF_DEVHUB_JWT_KEY" > "$KEY"
elif command -v buildkite-agent >/dev/null && buildkite-agent secret get SF_DEVHUB_JWT_KEY >/dev/null 2>&1; then buildkite-agent secret get SF_DEVHUB_JWT_KEY > "$KEY"
else echo "SF_DEVHUB_JWT_KEY is not set (Buildkite secret or agent environment hook)" >&2; exit 2; fi
export SF_DEVHUB_JWT_KEY_FILE="$KEY" SF_CI_KEY_FILE="$KEY"

# the trusted config: the default branch, checked out beside the build (the baseline step works on the default branch itself)
if [ "$ACTION" != "baseline" ]; then
  git fetch --quiet origin "$DEFAULT_BRANCH"
  TRUSTED="$(mktemp -d)/trusted"
  git worktree add --quiet --detach "$TRUSTED" "origin/$DEFAULT_BRANCH"
  export CONFIG_ROOT="$TRUSTED"
fi

node "$HERE/scratch-org.mjs" auth >/dev/null
annotate() { command -v buildkite-agent >/dev/null && buildkite-agent annotate --style "$1" --context "scratch-org-$ACTION" < "$2" || cat "$2"; }
BRANCH="${BUILDKITE_BRANCH:?}"

case "$ACTION" in
  ready)
    set +e; node "$HERE/scratch-org.mjs" ready --branch "$BRANCH" --commit "${BUILDKITE_COMMIT:-HEAD}" --annotation org.md; rc=$?; set -e
    if [ "$rc" = 3 ]; then printf 'No scratch org could be made for `%s`: the Dev Hub has no free slot or daily allowance. It is retried on the next push, or run the step again later.\n' "$BRANCH" > org.md; annotate warning org.md; exit 3; fi
    [ "$rc" = 0 ] || exit "$rc"
    annotate success org.md ;;
  login)
    # the email comes from the block step's field (key: login-email); never echoed whole
    EMAIL="${LOGIN_EMAIL:-$(buildkite-agent meta-data get login-email 2>/dev/null || true)}"
    ADMIN="$(buildkite-agent meta-data get login-admin 2>/dev/null || echo no)"
    node "$HERE/scratch-org.mjs" login --branch "$BRANCH" --email "$EMAIL" $([ "$ADMIN" = "yes" ] && echo --admin) > login.md
    annotate info login.md ;;
  changes)
    # pull what people changed in Setup into the branch, as a commit by the person who asked (needs push rights on the agent)
    node "$HERE/scratch-org.mjs" changes --branch "$BRANCH" --retrieve > changes.txt
    if git status --porcelain | grep -q .; then
      git add -A && git -c user.name="${BUILDKITE_UNBLOCKER:-scratch-org}" -c user.email="${BUILDKITE_UNBLOCKER_EMAIL:-scratch-org@invalid}" commit -q -m "chore(setup): changes made in the scratch org"
      git push origin "HEAD:$BRANCH"
      { echo "Pulled these Setup changes into \`$BRANCH\`:"; echo; sed 's/^/- /' changes.txt; } > changes.md
    else echo "No Setup changes to pull from \`$BRANCH\`'s org." > changes.md; fi
    annotate info changes.md ;;
  delete) node "$HERE/scratch-org.mjs" delete --branch "$BRANCH" ;;
  sweep)  node "$HERE/scratch-org.mjs" sweep --from-git ;;
  baseline)
    # on the default branch: capture production, then hand the diff to a person as a PR (VCS-specific: BASELINE_PR_COMMAND)
    node "$HERE/scratch-org.mjs" baseline capture --out drift.md
    if git status --porcelain -- baseline | grep -q .; then
      git checkout -q -B baseline-refresh
      git add baseline && git -c user.name=scratch-org -c user.email=scratch-org@invalid commit -q -m "chore(baseline): production drift"
      git push -f -q origin baseline-refresh
      if [ -n "${BASELINE_PR_COMMAND:-}" ]; then eval "$BASELINE_PR_COMMAND"; fi   # e.g. a Bitbucket or GitHub CLI/API call, reading drift.md
      annotate warning drift.md
    else echo "Production matches baseline/: nothing to review." > drift.md; annotate success drift.md; fi ;;
  snapshot) node "$HERE/scratch-org.mjs" snapshot refresh --if-older-than "${SNAPSHOT_MAX_AGE_HOURS:-20}" ;;
  *) echo "unknown action $ACTION" >&2; exit 2 ;;
esac
