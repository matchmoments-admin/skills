#!/bin/bash
# Usage: flow-tests.sh <org-alias>
# Runs the Flow tests that are in git (force-app/**/flowtests), by name, and fails if any fails. Only these: an org can
# hold tests a branch already deleted (added and removed within one story never reaches a destructive change).
# Skips when the repo has no Flow tests. Flow tests run asynchronously, so this polls for the result.
set -euo pipefail
ORG="$1"
N=$(find force-app -name '*.flowtest-meta.xml' | wc -l | tr -d ' ')
[ "$N" -gt 0 ] || { echo "no Flow tests in force-app"; exit 0; }
mkdir -p test-results
ARGS=()
while IFS= read -r f; do
  FLOW=$(sed -n 's#.*<flowApiName>\(.*\)</flowApiName>.*#\1#p' "$f" | head -1)
  ARGS+=(--tests "$FLOW.$(basename "$f" .flowtest-meta.xml)")   # <FlowApiName>.<TestName>
done < <(find force-app -name '*.flowtest-meta.xml' | sort)
ID=$(sf flow run test -o "$ORG" --test-level RunSpecifiedTests "${ARGS[@]}" --json | jq -r '.result.testRunId // empty')
[ -n "$ID" ] || { echo "::error::could not start the Flow tests"; exit 1; }
for _ in $(seq 1 60); do
  sf flow get test -o "$ORG" --test-run-id "$ID" --json > test-results/flow.json 2>/dev/null || true
  OUTCOME=$(jq -r '.result.summary.outcome // empty' test-results/flow.json)
  case "$OUTCOME" in Passed|Failed|Completed) break ;; esac
  sleep 10
done
jq -r '.result.tests[]? | "\(.Outcome // .outcome)  \(.FullName // .fullName)  \(.Message // .message // "")"' test-results/flow.json
jq -r '.result.summary | "flow tests: \(.testsRan) ran, \(.passing) passing, \(.failing) failing"' test-results/flow.json
FAILING=$(jq -r '.result.summary.failing // 1' test-results/flow.json)
[ "$OUTCOME" = "Passed" ] && [ "$FAILING" = "0" ] || { echo "::error::Flow tests failed (outcome ${OUTCOME:-unknown}, $FAILING failing)"; exit 1; }
echo "Flow tests passed"
