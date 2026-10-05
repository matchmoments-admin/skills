#!/usr/bin/env bash
# Usage: select-tests.sh <base-ref>        (run from the Salesforce DX project root)
# Prints the tests relevant to the change between <base-ref> and HEAD, one per line:
#   none                 no Salesforce source changed: no org needed
#   all                  run every local Apex test (TEST_MODE=all forces this)
#   apex <ClassName>     an Apex test class
#   flow <Flow>.<Test>   a Flow Builder test
# Rules (safe by default: when in doubt, "all"):
#   - a changed test class runs itself; a changed class runs every test class that names it
#   - a changed trigger or record-triggered Flow runs the test classes that name its object, plus the Flow's tests
#   - any other metadata (objects, fields, layouts, permission sets, validation rules...) can affect anything: all
#   - a deletion, or a changed class or trigger that no test names: all
# SOURCE_DIRS: the source folders to consider (default: every packageDirectory in sfdx-project.json).
# Portable: bash 3.2 (macOS) and Linux; needs git, jq, grep, sed.
set -euo pipefail
BASE="${1:?base ref, e.g. origin/main}"
MODE="${TEST_MODE:-relevant}"
DIRS="${SOURCE_DIRS:-$(jq -r '.packageDirectories[].path' sfdx-project.json 2>/dev/null || echo force-app)}"   # SOURCE_DIRS overrides
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# shellcheck disable=SC2086   # DIRS is a space-separated list of package directories
git diff --name-only --diff-filter=ACMR "$BASE"...HEAD -- $DIRS > "$TMP/changed"
# shellcheck disable=SC2086
git diff --name-only --diff-filter=D "$BASE"...HEAD -- $DIRS > "$TMP/deleted"
if [ ! -s "$TMP/changed" ] && [ ! -s "$TMP/deleted" ]; then echo none; exit 0; fi
[ "$MODE" != all ] || { echo all; exit 0; }
[ ! -s "$TMP/deleted" ] || { echo all; exit 0; }   # a deletion can break anything that referenced it

# every Apex test class: "<Name> <path>"
# shellcheck disable=SC2086
grep -rliE '@istest' --include='*.cls' $DIRS 2>/dev/null | while read -r p; do echo "$(basename "$p" .cls) $p"; done > "$TMP/tests" || true
is_test() { grep -q "^$1 " "$TMP/tests"; }
naming() { while read -r t p; do grep -qw "$1" "$p" && echo "$t"; done < "$TMP/tests"; return 0; }   # test classes that name $1

: > "$TMP/out"
while read -r f; do
  case "$f" in
    *.cls|*.cls-meta.xml)
      n=$(basename "${f%-meta.xml}" .cls)
      if is_test "$n"; then echo "apex $n" >> "$TMP/out"; continue; fi
      naming "$n" > "$TMP/hit"
      [ -s "$TMP/hit" ] || { echo all; exit 0; }
      sed 's/^/apex /' "$TMP/hit" >> "$TMP/out" ;;
    *.trigger|*.trigger-meta.xml)
      tf="${f%-meta.xml}"
      obj=$(sed -nE 's/^[[:space:]]*trigger[[:space:]]+[A-Za-z0-9_]+[[:space:]]+on[[:space:]]+([A-Za-z0-9_]+).*/\1/p' "$tf" | head -1)
      { naming "$(basename "$tf" .trigger)"; [ -z "$obj" ] || naming "$obj"; } | sort -u > "$TMP/hit"
      [ -s "$TMP/hit" ] || { echo all; exit 0; }
      sed 's/^/apex /' "$TMP/hit" >> "$TMP/out" ;;
    */flows/*.flow-meta.xml)
      flow=$(basename "$f" .flow-meta.xml)
      obj=$(sed -n '/<start>/,/<\/start>/s#.*<object>\(.*\)</object>.*#\1#p' "$f" | head -1)
      # shellcheck disable=SC2086
      grep -rl --include='*.flowtest-meta.xml' "<flowApiName>$flow</flowApiName>" $DIRS 2>/dev/null \
        | while read -r ft; do echo "flow $flow.$(basename "$ft" .flowtest-meta.xml)"; done >> "$TMP/out" || true
      [ -z "$obj" ] || naming "$obj" | sed 's/^/apex /' >> "$TMP/out" ;;
    */flowtests/*.flowtest-meta.xml)
      flow=$(sed -n 's#.*<flowApiName>\(.*\)</flowApiName>.*#\1#p' "$f" | head -1)
      echo "flow $flow.$(basename "$f" .flowtest-meta.xml)" >> "$TMP/out" ;;
    *) echo all; exit 0 ;;   # any other metadata: run everything
  esac
done < "$TMP/changed"
[ -s "$TMP/out" ] || { echo all; exit 0; }
sort -u "$TMP/out"
