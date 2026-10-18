#!/bin/bash
# Usage: coverage-gate.sh <org-alias> [floor-percent]
# Every local Apex test and every Flow test in git, failing on any failure or coverage of this repo's code below the floor.
# The logic lives in pipeline/src/tests.mjs (selection, live progress, verdict); this is the all-tests entry point.
set -euo pipefail
ORG="${1:?org alias}"; MIN="${2:-75}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p test-results
node "$HERE/pipeline/bin/pipe.mjs" tests run "$ORG" --all --base HEAD --floor "$MIN" --out test-results
