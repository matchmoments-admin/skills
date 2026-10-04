#!/bin/bash
# Usage: coverage-gate.sh <org-alias> [min-percent]
# Runs all local Apex tests, prints a summary, and fails if overall coverage is below the minimum.
set -euo pipefail
ORG="$1"; MIN="${2:-75}"
sf apex run test -o "$ORG" --test-level RunLocalTests --code-coverage --result-format json \
  --wait 30 --output-dir test-results > test-results/raw.json || true
python3 - "$MIN" <<'PY'
import json, sys, glob
mn = int(sys.argv[1])
r = json.load(open("test-results/raw.json"))["result"]
s = r["summary"]
print(f"tests: {s['testsRan']} ran, {s['passing']} passing, {s['failing']} failing; coverage {s['testRunCoverage']} (org-wide {s['orgWideCoverage']})")
cov = int(str(s["orgWideCoverage"]).rstrip("%") or 0)
bad = s["failing"] > 0 or cov < mn
if bad:
    print(f"::error::Gate failed: failing={s['failing']} coverage={cov}% (minimum {mn}%)")
    sys.exit(1)
print("Gate passed")
PY
