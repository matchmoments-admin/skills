#!/bin/bash
# Usage: bootstrap.sh <target-repo-dir> --owner <github-owner> [--project <repo-name>] [--org <prod-org-id-18>]
#                     [--alias <prod-alias>] [--no-fflib] [--no-test]
# Copies the pipeline template into a Salesforce DX repo and fills its placeholders: the GitHub owner (CODEOWNERS, the
# pipeline App's bot name <owner>-pipeline), the project name, production's org ID (config/scratch-*.json; it can come
# later, after Phase 2 step 4) and its CLI alias. Keeps the target's force-app/. Makes the target a git repository
# (branch main) when it is not one. Vendors FFLib (fflib-apex-common and fflib-apex-mocks, with scripts/vendor.sh, at
# the commits the reference repo runs) unless --no-fflib: the template's Apex test standard (CLAUDE.md,
# docs/agents/apex-testing.md) is written for it. Then proves the copy: npm ci and the pipeline's own tests (skip with
# --no-test). Prints every path it wrote.
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$SKILL/assets/template"
TARGET="${1:?target repo dir}"; shift
OWNER="" PROJECT="" ORG="" ALIAS="prod" TEST=1 FFLIB=1
# FFLib at the commits the reference repo vendors and tests (its docs/vendor.md); a pipeline test keeps them equal
FFLIB_COMMON=c91fa6f32781c02969dc57d9fd1453478b541f6a
FFLIB_MOCKS=d81e9e1833e27e6d704281ae7ffa39cbc304edea
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --alias) ALIAS="$2"; shift 2 ;;
    --no-fflib) FFLIB=0; shift ;;
    --no-test) TEST=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OWNER" ] || { echo "--owner <github-owner> is required (the repository's owner: a user or organisation)" >&2; exit 2; }
[ -d "$TEMPLATE/pipeline" ] || { echo "Template is empty: run scripts/sync-template.sh <reference-repo> first." >&2; exit 1; }
PROJECT="${PROJECT:-$(basename "$(cd "$TARGET" 2>/dev/null && pwd || echo "$TARGET")")}"
OWNER_LC=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')   # the App's slug is lowercase: <owner>-pipeline

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
cd "$TEMPLATE"
find . -type f ! -path "./force-app/*" | sort | while read -r f; do
  dest="$TARGET/${f#./}"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
  echo "wrote ${f#./}"
done
[ -d "$TARGET/force-app" ] || { mkdir -p "$TARGET/force-app/main/default"; echo "created force-app/main/default"; }
chmod +x "$TARGET"/scripts/ci/*.sh "$TARGET"/pipeline/bin/pipe.mjs 2>/dev/null || true

# the placeholders, everywhere the template has them (production's org ID only when given: it comes in Phase 2)
grep -rlI -e "__project__" -e "__OWNER__" -e "__owner__" -e "__PROD_ALIAS__" -e "__PROD_ORG_ID__" "$TARGET" --exclude-dir=node_modules --exclude-dir=force-app --exclude-dir=.claude | while read -r f; do
  sed -i.bak -e "s#__project__#$PROJECT#g" -e "s#__OWNER__#$OWNER#g" -e "s#__owner__#$OWNER_LC#g" -e "s#__PROD_ALIAS__#$ALIAS#g" \
    ${ORG:+-e "s#__PROD_ORG_ID__#$ORG#g"} "$f" && rm -f "$f.bak"
done
LEFT=$(grep -rlI -e "__project__" -e "__OWNER__" -e "__owner__" -e "__PROD_ALIAS__" "$TARGET" --exclude-dir=node_modules --exclude-dir=force-app --exclude-dir=.claude || true)
[ -z "$LEFT" ] || { echo "placeholders left in: $LEFT" >&2; exit 1; }
echo "filled: owner $OWNER (bot ${OWNER_LC}-pipeline), project $PROJECT, alias $ALIAS${ORG:+, org $ORG}"

# a git repository on main: vendor.sh needs one, and Phase 1 pushes it as the first commit
if ! git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$TARGET" init -q -b main && echo "git repository created (branch main)"
fi
if [ "$FFLIB" = 1 ]; then
  (cd "$TARGET" \
    && scripts/vendor.sh fflib-apex-common https://github.com/apex-enterprise-patterns/fflib-apex-common "$FFLIB_COMMON" \
         "Apex Enterprise Patterns: domain, selector and unit of work base classes (the template's Apex test standard)" \
         sfdx-source/apex-common/main sfdx-source/apex-common/test \
    && scripts/vendor.sh fflib-apex-mocks https://github.com/apex-enterprise-patterns/fflib-apex-mocks "$FFLIB_MOCKS" \
         "Apex Enterprise Patterns: mocking framework for DML-free unit tests; apex-common's tests need it" \
         sfdx-source/apex-mocks/main sfdx-source/apex-mocks/test)
  echo "FFLib vendored. Set PROD_TEST_LEVEL=RunLocalTests in Phase 3: vendored fflib_SObjectSelector is at 73.99%, and the default RunRelevantTests needs 75% per class in production."
fi

if [ "$TEST" = 1 ]; then
  (cd "$TARGET" && npm ci --no-audit --no-fund >/dev/null && npm run test:pipeline)
fi
cat <<EOF

Next:
  1. Commit and push this as the repo's first commit (Phase 1): git add -A && git commit -m "chore: pipeline from the template" && git push -u origin main
     It is the one direct push to main: Phase 3's rulesets refuse any after it.
  2. ${ORG:+(done) }Production's org ID in config/scratch-*.json after Phase 2 step 4 (Org Shape): re-run with --org, or replace __PROD_ORG_ID__.
  3. Phase 2 (Salesforce) and Phase 3 (GitHub) of SKILL.md. CLAUDE.md and REVIEW.md work as they are; tune them for the project any time (through a PR).
EOF
