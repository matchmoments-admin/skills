#!/bin/bash
# Usage: validate-prod.sh            (run from a checkout of the code about to ship)
# Check-only deploy of force-app to production (alias devhub = __PROD_ALIAS__) with every test class in the repo.
# Components deleted since the last release tag are validated as post-destructive changes, so the quick deploy
# removes them from production too (needs the tags: check out with fetch-depth 0).
# Prints the validation job ID on success (quick deploy can ship it within 10 days without re-running tests).
# On failure prints the component and test errors and exits 1. Changes nothing in production.
set -euo pipefail
TESTS=$(grep -rli '@istest' force-app --include='*.cls' | xargs -n1 basename | sed 's/.cls$//' | paste -sd' ' -)
ARGS=""; for t in $TESTS; do ARGS="$ARGS --tests $t"; done
SOURCE="-d force-app"
LAST_TAG=${DELETIONS_FROM:-$(git describe --tags --abbrev=0 HEAD 2>/dev/null || true)}   # rollback passes main
if [ -n "$LAST_TAG" ]; then
  OUT=$(mktemp -d)
  sf sgd source delta --from "$LAST_TAG" --to HEAD --output-dir "$OUT" --source-dir force-app >/dev/null 2>&1 || true
  if grep -q '<members>' "$OUT/destructiveChanges/destructiveChanges.xml" 2>/dev/null; then
    echo "Deleting since $LAST_TAG:" >&2; grep -o '<members>[^<]*' "$OUT/destructiveChanges/destructiveChanges.xml" | sed 's/<members>/  - /' >&2
    sf project generate manifest --source-dir force-app --output-dir "$OUT" --name full >/dev/null
    SOURCE="--manifest $OUT/full.xml --post-destructive-changes $OUT/destructiveChanges/destructiveChanges.xml"
  fi
fi
# shellcheck disable=SC2086
sf project deploy validate -o devhub $SOURCE --test-level RunSpecifiedTests $ARGS --wait 40 --json > validate.json 2>/dev/null || true
STATUS=$(jq -r '.result.status // .name // "unknown"' validate.json)
if [ "$STATUS" = "Succeeded" ]; then jq -r '.result.id' validate.json; exit 0; fi
{
  echo "Production validation failed ($STATUS):"
  jq -r '.message // empty' validate.json | head -20
  jq -r '.result.details.componentFailures // [] | (if type=="array" then . else [.] end)[] | "- \(.fullName): \(.problem)"' validate.json 2>/dev/null | head -20
  jq -r '.result.details.runTestResult.failures // [] | (if type=="array" then . else [.] end)[] | "- test \(.name).\(.methodName): \(.message)"' validate.json 2>/dev/null | head -20
} >&2
exit 1
