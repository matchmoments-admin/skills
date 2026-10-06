#!/usr/bin/env bash
# Throwaway scratch org per CI build: create -> deploy -> run the relevant tests -> delete (always).
#
#   scratch-ci.sh run              from the Salesforce DX project root, on the build's checkout
#   scratch-ci.sh sweep [hours]    delete CI scratch orgs older than <hours> (default 3) that a killed build left behind
#
# Environment (CI secrets; nothing is printed):
#   SF_DEVHUB_CLIENT_ID      consumer key of the CI connected app in the Dev Hub (production)
#   SF_DEVHUB_USERNAME       the CI integration user
#   SF_DEVHUB_JWT_KEY        the PEM private key (or SF_DEVHUB_JWT_KEY_FILE: a path to it)
#   SF_LOGIN_URL             default https://login.salesforce.com
# Options:
#   BASE_REF       what the change is compared with; default origin/$BUILDKITE_PULL_REQUEST_BASE_BRANCH, else origin/main
#   TEST_MODE      relevant (default) | all
#   SCRATCH_DEF    scratch org definition; default config/project-scratch-def.json
#   SCRATCH_DAYS   1 (an org that outlives its build expires the next day)
#   RESULTS_DIR    test-results (JUnit and JSON for the CI's test reports)
#   SOURCE_DIRS    source folders to deploy and test, space-separated; default every packageDirectory. Leave out
#                  folders that only make sense in production (a CI connected app, org-wide settings).
#   NO_ORG_EXIT    exit code when the Dev Hub has no free scratch org (default 1; use a soft-fail code in Buildkite)
# Exit codes: 0 pass or nothing to test, 1 test or deploy failure, NO_ORG_EXIT when no allowance.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEVHUB=ci-devhub
export SF_AUTOUPDATE_DISABLE=true SF_DISABLE_TELEMETRY=true FORCE_COLOR=0 NO_COLOR=1
say() { printf '%s\n' "$*" >&2; }
annotate() {   # Buildkite annotation when running on an agent; harmless elsewhere
  command -v buildkite-agent >/dev/null 2>&1 && printf '%s\n' "$2" | buildkite-agent annotate --style "$1" --context scratch-org-tests || true
}

login_devhub() {
  local key="${SF_DEVHUB_JWT_KEY_FILE:-}"
  if [ -z "$key" ]; then
    key=$(mktemp); chmod 600 "$key"; printf '%s\n' "${SF_DEVHUB_JWT_KEY:?set SF_DEVHUB_JWT_KEY or SF_DEVHUB_JWT_KEY_FILE}" > "$key"
    KEY_TO_DELETE="$key"
  fi
  sf org login jwt --client-id "${SF_DEVHUB_CLIENT_ID:?}" --jwt-key-file "$key" --username "${SF_DEVHUB_USERNAME:?}" \
    --instance-url "${SF_LOGIN_URL:-https://login.salesforce.com}" --alias "$DEVHUB" --set-default-dev-hub >/dev/null
  say "logged in to the Dev Hub as ${SF_DEVHUB_USERNAME}"
}

remaining() {   # remaining allowance: "<active> <daily>"
  sf limits api display -o "$DEVHUB" --json | jq -r '[.result[] | select(.name=="ActiveScratchOrgs" or .name=="DailyScratchOrgs")] | sort_by(.name) | map(.remaining) | "\(.[0]) \(.[1])"'
}

delete_org() {   # by its ActiveScratchOrg record in the Dev Hub: works without logging in to the org itself
  local user="$1"
  [ -n "$user" ] || return 0
  if sf data delete record -o "$DEVHUB" -s ActiveScratchOrg -w "SignupUsername='$user'" >/dev/null 2>&1; then say "deleted scratch org $user"
  else say "could not delete $user; 'scratch-ci.sh sweep' will"; fi
}

run_flow_tests() {   # by name (<Flow>.<Test>): the org holds exactly what this commit deploys
  local alias="$1"; shift
  local args=() t id outcome failing
  for t in "$@"; do args+=(--tests "$t"); done
  id=$(sf flow run test -o "$alias" --test-level RunSpecifiedTests "${args[@]}" --json | jq -r '.result.testRunId // empty')
  [ -n "$id" ] || { say "could not start the Flow tests"; return 1; }
  for _ in $(seq 1 90); do
    sf flow get test -o "$alias" --test-run-id "$id" --output-dir "$RESULTS_DIR/flow" --json > "$RESULTS_DIR/flow.json" 2>/dev/null || true
    outcome=$(jq -r '.result.summary.outcome // empty' "$RESULTS_DIR/flow.json")
    case "$outcome" in Passed|Failed|Completed) break ;; esac
    sleep 10
  done
  jq -r '.result.tests[]? | "  \(.Outcome // .outcome)  \(.FullName // .fullName)  \(.Message // .message // "")"' "$RESULTS_DIR/flow.json" >&2
  failing=$(jq -r '.result.summary.failing // 1' "$RESULTS_DIR/flow.json")
  say "flow tests: $(jq -r '.result.summary | "\(.testsRan) ran, \(.passing) passing, \(.failing) failing"' "$RESULTS_DIR/flow.json")"
  [ "$outcome" = Passed ] && [ "$failing" = 0 ]
}

run() {
  : "${RESULTS_DIR:=test-results}"; mkdir -p "$RESULTS_DIR"
  local base="${BASE_REF:-origin/${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-main}}"
  [ "$base" != "origin/" ] || base=origin/main
  git fetch -q origin "${base#origin/}" 2>/dev/null || true

  "$HERE/select-tests.sh" "$base" > "$RESULTS_DIR/selected.txt"
  if grep -qx none "$RESULTS_DIR/selected.txt"; then
    say "no Salesforce source changed against $base: no scratch org needed"; annotate info "Scratch org tests: no Salesforce changes."; return 0
  fi
  say "tests for this change (against $base):"; sed 's/^/  /' "$RESULTS_DIR/selected.txt" >&2

  login_devhub
  read -r active daily < <(remaining)
  if [ "${active:-0}" -le 0 ] || [ "${daily:-0}" -le 0 ]; then
    say "no free scratch org (active left: $active, created today left: $daily)"
    annotate warning "Scratch org tests skipped: the Dev Hub has no free scratch org (active $active, daily $daily)."
    return "${NO_ORG_EXIT:-1}"
  fi

  local build="${BUILDKITE_BUILD_NUMBER:-local-$$}" slug="${BUILDKITE_PIPELINE_SLUG:-local}"
  ALIAS="ci-$slug-$build"; ORG_USER=""
  local desc="ci:$slug:$build:${BUILDKITE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
  trap 'delete_org "$ORG_USER"; [ -z "${KEY_TO_DELETE:-}" ] || rm -f "$KEY_TO_DELETE"' EXIT
  trap 'exit 130' INT TERM   # a cancelled build still deletes its org (EXIT runs)

  for attempt in 1 2; do   # creation fails transiently now and then
    if ORG_USER=$(sf org create scratch --definition-file "${SCRATCH_DEF:-config/project-scratch-def.json}" --alias "$ALIAS" \
        --description "$desc" --duration-days "${SCRATCH_DAYS:-1}" --target-dev-hub "$DEVHUB" --wait 30 --json | jq -re '.result.username'); then break; fi
    [ "$attempt" = 2 ] && { say "scratch org creation failed twice"; return 1; }
    say "scratch org creation failed; retrying once"; sleep 20
  done
  say "created $ALIAS ($ORG_USER)"

  if [ -f config/packages.json ]; then   # production's managed packages: Org Shape does not copy them
    jq -c '.[]' config/packages.json | while read -r p; do
      id=$(jq -r .id <<<"$p"); keyvar=$(jq -r '.keyEnv // empty' <<<"$p")
      say "installing $(jq -r '.name // .id' <<<"$p")"
      sf package install --package "$id" --target-org "$ALIAS" --wait 30 --publish-wait 10 --no-prompt --security-type AdminsOnly \
        ${keyvar:+--installation-key "${!keyvar}"} >/dev/null
    done
  fi

  local srcs=() d
  for d in ${SOURCE_DIRS:-$(jq -r '.packageDirectories[].path' sfdx-project.json)}; do srcs+=(--source-dir "$d"); done
  if ! sf project deploy start -o "$ALIAS" "${srcs[@]}" --wait 60 --json > "$RESULTS_DIR/deploy.json"; then
    jq -r '.result.details.componentFailures // [] | (if type=="array" then . else [.] end)[] | "  \(.fullName): \(.problem)"' "$RESULTS_DIR/deploy.json" >&2 || true
    annotate error "Scratch org deploy failed: see the step log."
    return 1
  fi
  say "deployed the branch to $ALIAS"

  local ok=0 apex=() flows=()
  while read -r kind name; do
    case "$kind" in apex) apex+=("$name") ;; flow) flows+=("$name") ;; esac
  done < "$RESULTS_DIR/selected.txt"
  local level=(--test-level RunLocalTests)
  if ! grep -qx all "$RESULTS_DIR/selected.txt"; then
    level=(--test-level RunSpecifiedTests); for t in ${apex[@]+"${apex[@]}"}; do level+=(--tests "$t"); done
  fi
  if grep -qx all "$RESULTS_DIR/selected.txt" || [ ${#apex[@]} -gt 0 ]; then
    # --output-dir writes JUnit (test-result-*-junit.xml) for the CI's test report alongside the JSON
    sf apex run test -o "$ALIAS" "${level[@]}" --code-coverage --output-dir "$RESULTS_DIR/apex" --wait 60 --json > "$RESULTS_DIR/apex.json" 2>/dev/null || true
    jq -r '.result.tests[]? | select(.Outcome!="Pass") | "  \(.Outcome)  \(.FullName)  \(.Message // "")"' "$RESULTS_DIR/apex.json" >&2 || true
    say "apex tests: $(jq -r '.result.summary | "\(.testsRan) ran, \(.passing) passing, \(.failing) failing; coverage \(.testRunCoverage)"' "$RESULTS_DIR/apex.json")"
    [ "$(jq -r '.result.summary.failing // 1' "$RESULTS_DIR/apex.json")" = 0 ] || ok=1
  fi
  if [ ${#flows[@]} -gt 0 ] || grep -qx all "$RESULTS_DIR/selected.txt"; then
    if [ ${#flows[@]} -eq 0 ]; then   # all: every Flow test in the source
      # shellcheck disable=SC2086   # SOURCE_DIRS is a space-separated list of folders
      while read -r ft; do flows+=("$(sed -n 's#.*<flowApiName>\(.*\)</flowApiName>.*#\1#p' "$ft" | head -1).$(basename "$ft" .flowtest-meta.xml)")
      done < <(find ${SOURCE_DIRS:-$(jq -r '.packageDirectories[].path' sfdx-project.json)} -name '*.flowtest-meta.xml' 2>/dev/null)
    fi
    if [ ${#flows[@]} -gt 0 ]; then run_flow_tests "$ALIAS" ${flows[@]+"${flows[@]}"} || ok=1; fi
  fi

  if [ "$ok" = 0 ]; then annotate success "Scratch org tests passed ($(grep -c . "$RESULTS_DIR/selected.txt") selections)."; say "PASSED"
  else annotate error "Scratch org tests failed: see the step log and the test report."; say "FAILED"; fi
  return "$ok"
}

sweep() {   # orgs whose build died before its EXIT trap (agent lost, runner killed)
  local hours="${1:-3}" cutoff
  login_devhub
  cutoff=$(date -u -d "-$hours hours" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-"$hours"H +%Y-%m-%dT%H:%M:%S)
  sf data query -o "$DEVHUB" -q "SELECT SignupUsername, Description, CreatedDate FROM ScratchOrgInfo WHERE Status = 'Active'" --json \
    | jq -r --arg c "$cutoff" '.result.records[] | select((.Description // "") | startswith("ci:")) | select(.CreatedDate < $c) | .SignupUsername' \
    | while read -r u; do delete_org "$u"; done
  say "sweep done (CI orgs older than $hours h)"
}

case "${1:-}" in
  run) run ;;
  sweep) sweep "${2:-3}" ;;
  *) say "usage: scratch-ci.sh run | sweep [hours]"; exit 2 ;;
esac
