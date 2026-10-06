#!/bin/bash
# Usage: validate-prod.sh            (run from a checkout of the code about to ship)
# Check-only deploy to production (alias devhub), watched live; prints the validation ID on success, for the quick
# deploy. On failure prints each component and test error and exits 1. Changes nothing in production.
# The logic lives in pipeline/src/production.mjs: RunRelevantTests (beta) with a fallback to every test class,
# deletions since the last release tag, and the live "Production validation" check when VALIDATE_SHA is set.
# DELETIONS_FROM overrides the last tag (rollback passes main); PROD_TEST_LEVEL overrides the test level.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$HERE/pipeline/bin/pipe.mjs" prod validate ${VALIDATE_SHA:+--sha "$VALIDATE_SHA"} ${DELETIONS_FROM:+--deletions-from "$DELETIONS_FROM"}
