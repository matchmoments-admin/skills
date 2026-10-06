#!/usr/bin/env bash
# Usage: select-tests.sh <base-ref>        (run from the Salesforce DX project root)
# Prints the tests relevant to the change between <base-ref> and HEAD, one per line:
#   none                 no Salesforce source changed: no org needed
#   all                  run every local Apex test (TEST_MODE=all forces this), followed by each "flow <Flow>.<Test>"
#   apex <ClassName>     an Apex test class
#   flow <Flow>.<Test>   a Flow Builder test
# Rules (safe by default: when in doubt, "all"):
#   - a changed test class runs itself; a changed class runs every test class that names it
#   - a changed trigger or record-triggered Flow runs the test classes that name its object, plus the Flow's tests
#   - any other metadata (objects, fields, layouts, permission sets, validation rules...) can affect anything: all
#   - a deletion, or a changed class or trigger that no test names: all
# The rules are the GitHub pipeline's own, tested ones (engine/tests.mjs, a verbatim copy); this script runs them.
# SOURCE_DIRS: the source folders to consider (default: every packageDirectory in sfdx-project.json).
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/engine/select.mjs" "$@"
