#!/bin/bash
# Usage: bootstrap.sh <target-repo-dir> --owner <github-owner> [--project <repo-name>] [--org <prod-org-id-18>]
#                     [--alias <prod-alias>] [--no-fflib] [--no-test]
#        bootstrap.sh <repo-dir> --owner <github-owner> --org <prod-org-id-18> --fill-only
# Copies the pipeline template into a Salesforce DX repo and fills its placeholders: the GitHub owner (CODEOWNERS, the
# pipeline App's bot name <owner>-pipeline), the project name, production's org ID (config/scratch-*.json; it can come
# later, after Phase 2 step 4) and its CLI alias. Keeps the target's force-app/.
# - git: a directory that is not the top of its own repository (a new one, or one inside another repository) becomes
#   a repository on main; an existing repository is kept, and Next says how to bring this in through a PR.
# - FFLib: vendored (fflib-apex-common and fflib-apex-mocks, with scripts/vendor.sh, at the commits the reference repo
#   runs: assets/fflib-pins.tsv, written by sync-template.sh from its docs/vendor.md) unless --no-fflib, FFLib is
#   already in force-app, or docs/vendor.md already has those commits. The template's Apex test standard (CLAUDE.md,
#   docs/agents/apex-testing.md) is written for it.
# - --fill-only: only fills the placeholders in a repo made earlier (production's org ID after Phase 2); copies nothing,
#   touches no git, vendors nothing.
# Then proves the copy: npm ci and the pipeline's own tests (skip with --no-test). Prints every path it wrote.
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$SKILL/assets/template"
PINS="$SKILL/assets/fflib-pins.tsv"
TARGET="${1:?target repo dir}"; shift
OWNER="" PROJECT="" ORG="" ALIAS="prod" TEST=1 FFLIB=1 FILL_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --alias) ALIAS="$2"; shift 2 ;;
    --no-fflib) FFLIB=0; shift ;;
    --no-test) TEST=0; shift ;;
    --fill-only) FILL_ONLY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OWNER" ] || { echo "--owner <github-owner> is required (the repository's owner: a user or organisation)" >&2; exit 2; }
[ -d "$TEMPLATE/pipeline" ] || { echo "Template is empty: run scripts/sync-template.sh <reference-repo> first." >&2; exit 1; }
PROJECT="${PROJECT:-$(basename "$(cd "$TARGET" 2>/dev/null && pwd || echo "$TARGET")")}"
OWNER_LC=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')   # the App's slug is lowercase: <owner>-pipeline

# the placeholders, everywhere the template has them (production's org ID only when given: it comes in Phase 2)
fill() {
  grep -rlI -e "__project__" -e "__OWNER__" -e "__owner__" -e "__PROD_ALIAS__" -e "__PROD_ORG_ID__" "$TARGET" --exclude-dir=node_modules --exclude-dir=force-app --exclude-dir=.claude --exclude-dir=.git | while read -r f; do
    sed -i.bak -e "s#__project__#$PROJECT#g" -e "s#__OWNER__#$OWNER#g" -e "s#__owner__#$OWNER_LC#g" -e "s#__PROD_ALIAS__#$ALIAS#g" \
      ${ORG:+-e "s#__PROD_ORG_ID__#$ORG#g"} "$f" && rm -f "$f.bak"
  done
  LEFT=$(grep -rlI -e "__project__" -e "__OWNER__" -e "__owner__" -e "__PROD_ALIAS__" "$TARGET" --exclude-dir=node_modules --exclude-dir=force-app --exclude-dir=.claude --exclude-dir=.git || true)
  [ -z "$LEFT" ] || { echo "placeholders left in: $LEFT" >&2; exit 1; }
  echo "filled: owner $OWNER (bot ${OWNER_LC}-pipeline), project $PROJECT, alias $ALIAS${ORG:+, org $ORG}"
}

if [ "$FILL_ONLY" = 1 ]; then
  [ -d "$TARGET/pipeline" ] || { echo "--fill-only: $TARGET has no pipeline yet; run bootstrap.sh without it first" >&2; exit 2; }
  [ -n "$ORG" ] || { echo "--fill-only needs --org <production's 18-character org ID>" >&2; exit 2; }
  TARGET="$(cd "$TARGET" && pwd -P)"
  fill
  echo "Commit config/scratch-*.json through a PR (Phase 2 step 5)."
  exit 0
fi

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd -P)"
# whether TARGET is the top of its own repository, before anything is written (a parent repository does not count)
TOP=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null || true)
[ -z "$TOP" ] || TOP="$(cd "$TOP" && pwd -P)"
EXISTING=0; [ "$TOP" = "$TARGET" ] && EXISTING=1

cd "$TEMPLATE"
find . -type f ! -path "./force-app/*" | sort | while read -r f; do
  dest="$TARGET/${f#./}"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
  echo "wrote ${f#./}"
done
[ -d "$TARGET/force-app" ] || { mkdir -p "$TARGET/force-app/main/default"; echo "created force-app/main/default"; }
chmod +x "$TARGET"/scripts/ci/*.sh "$TARGET"/scripts/vendor.sh "$TARGET"/pipeline/bin/pipe.mjs 2>/dev/null || true
fill

# a git repository of its own on main: vendor.sh writes into the top of the repository it runs in
if [ "$EXISTING" = 0 ]; then
  git -C "$TARGET" init -q -b main && echo "git repository created (branch main)"
fi

if [ "$FFLIB" = 1 ]; then
  [ -s "$PINS" ] || { echo "no $PINS: run scripts/sync-template.sh <reference-repo>, or bootstrap with --no-fflib" >&2; exit 1; }
  PINNED=1
  while IFS=$'\t' read -r name _ sha _; do
    grep -q "^| \`$name\` | .* | \`$sha\` |" "$TARGET/docs/vendor.md" 2>/dev/null || PINNED=0
  done < "$PINS"
  OWN=$(find "$TARGET/force-app" -name 'fflib_*.cls' ! -path "$TARGET/force-app/vendor/fflib-apex-*" 2>/dev/null | head -1)
  if [ "$PINNED" = 1 ]; then echo "FFLib already vendored at the pinned commits (docs/vendor.md): not cloned again"
  elif [ -n "$OWN" ]; then echo "FFLib is already in force-app (${OWN#"$TARGET"/}): not vendored, so no class is duplicated"
  else
    while IFS=$'\t' read -r name url sha dirs; do
      # shellcheck disable=SC2086  # dirs: the library's folders, one argument each
      (cd "$TARGET" && scripts/vendor.sh "$name" "$url" "$sha" "Apex Enterprise Patterns, for the Apex test standard (docs/agents/apex-testing.md); vendored by the pipeline skill's bootstrap" $dirs)
    done < "$PINS"
  fi
  echo "With FFLib, set PROD_TEST_LEVEL=RunLocalTests in Phase 3: some of FFLib's own classes stay below the 75% per class that the default RunRelevantTests needs in production. Check after the first deploy: sf apex run test -o <prod> --test-level RunLocalTests --code-coverage --result-format human --synchronous (or Setup > Apex Classes > Estimate your organization's code coverage)."
fi

if [ "$TEST" = 1 ]; then
  (cd "$TARGET" && npm ci --no-audit --no-fund >/dev/null && npm run test:pipeline)
fi

echo
echo "Next:"
if [ "$EXISTING" = 0 ]; then
  cat <<EOF
  1. First push, the one direct push to main (Phase 3's rulesets refuse any after it):
     git remote add origin https://github.com/$OWNER/$PROJECT.git && git add -A && git commit -m "chore: pipeline from the template" && git push -u origin main
EOF
else
  BRANCH=$(git -C "$TARGET" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  ORIGIN=$(git -C "$TARGET" remote get-url origin 2>/dev/null || echo "none: git remote add origin https://github.com/$OWNER/$PROJECT.git")
  cat <<EOF
  1. An existing repository (branch $BRANCH, origin $ORIGIN): bring this in through a PR, never a direct push:
     git switch -c pipeline-setup && git add -A && git commit -m "chore: pipeline from the template" && git push -u origin pipeline-setup && gh pr create --base main --fill
EOF
  [ "$BRANCH" = main ] || echo "     !! The pipeline ships from main, and this repository is on $BRANCH: rename the default branch to main first (gh api -X POST repos/$OWNER/$PROJECT/branches/$BRANCH/rename -f new_name=main, then git fetch && git switch main)."
fi
cat <<EOF
  2. ${ORG:+(done) }Production's org ID after Phase 2 step 4 (Org Shape): bootstrap.sh $TARGET --owner $OWNER --org <id> --fill-only.
     Commit it with devhub-setup/ (Phase 2) through a PR (Phase 2 step 5).
  3. Phase 2 (Salesforce) and Phase 3 (GitHub) of SKILL.md. CLAUDE.md and REVIEW.md work as they are; tune them for the project any time (through a PR).
EOF
