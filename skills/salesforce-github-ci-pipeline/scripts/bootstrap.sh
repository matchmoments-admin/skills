#!/bin/bash
# Usage: bootstrap.sh <target-repo-dir> --owner <github-owner> [--project <repo-name>] [--org <prod-org-id-18>]
#                     [--alias <prod-alias>] [--no-test]
# Copies the pipeline template into a Salesforce DX repo and fills its placeholders: the GitHub owner (CODEOWNERS, the
# pipeline App's bot name <owner>-pipeline), the project name, production's org ID (config/scratch-*.json; it can come
# later, after Phase 2 step 4) and its CLI alias. Keeps the target's force-app/. Then proves the copy: npm ci and the
# pipeline's own tests (skip with --no-test). Prints every path it wrote.
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$SKILL/assets/template"
TARGET="${1:?target repo dir}"; shift
OWNER="" PROJECT="" ORG="" ALIAS="prod" TEST=1
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --alias) ALIAS="$2"; shift 2 ;;
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

if [ "$TEST" = 1 ]; then
  (cd "$TARGET" && npm ci --no-audit --no-fund >/dev/null && npm run test:pipeline)
fi
cat <<EOF

Next:
  1. ${ORG:+(done) }Production's org ID in config/scratch-*.json after Phase 2 step 4 (Org Shape): re-run with --org, or replace __PROD_ORG_ID__.
  2. Edit CLAUDE.md and REVIEW.md for this project.
  3. Phase 2 (Salesforce) and Phase 3 (GitHub) of SKILL.md.
EOF
