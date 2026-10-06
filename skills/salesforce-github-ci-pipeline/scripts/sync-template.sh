#!/bin/bash
# Usage: sync-template.sh <reference-repo-dir>
# Refreshes assets/template/ from a working pipeline repo, so the template always matches code that has shipped.
# Copies only pipeline files (never force-app/ business code, docs/, secrets/, org-specific connected apps) and
# replaces project identifiers with placeholders. Re-run after fixing the pipeline in the reference repo.
set -euo pipefail
SRC="$(cd "${1:?reference repo dir}" && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
T="$SKILL/assets/template"
rm -rf "$T" && mkdir -p "$T"
copy() { for p in "$@"; do [ -e "$SRC/$p" ] || continue; mkdir -p "$T/$(dirname "$p")"; cp -R "$SRC/$p" "$T/$p"; done; }
copy pipeline .github scripts/ci scripts/skills-sync.sh config e2e/support playwright.config.ts \
     devhub-setup/main/default/settings \
     CLAUDE.md REVIEW.md GLOSSARY.md package.json .prettierrc .eslintrc.json jest.config.js .forceignore \
     sfdx-project.json code-analyzer.yml .gitignore docs/agents GLOSSARY-MAP.md .github/ISSUE_TEMPLATE
# the org's business glossary is the project's own: the template starts it empty
mkdir -p "$T/docs/org" && printf '# The Salesforce org: domain glossary\n\nThe business words specs and stories use, and what each one is in the org.\n\n| Term | Meaning | In the org |\n| --- | --- | --- |\n' > "$T/docs/org/GLOSSARY.md"
rm -rf "$T/pipeline/test/fixtures/"*.json.tmp "$T/node_modules"
# placeholders for anything project-specific
OWNER=$(git -C "$SRC" remote get-url origin | sed -E 's#.*github.com[:/]([^/]+)/.*#\1#')
PROD=$(jq -r '.sourceOrg // empty' "$SRC/config/scratch-dev.json" 2>/dev/null || true)
OWNER_LC=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')   # the App's slug is lowercase (owner-pipeline)
grep -rlI . "$T" | while read -r f; do
  sed -i.bak -e "s#$OWNER#__OWNER__#g" -e "s#$OWNER_LC#__owner__#g" ${PROD:+-e "s#$PROD#__PROD_ORG_ID__#g"} \
    -e 's#orgfarm-[a-z0-9]*-dev-ed\.develop\.[a-z.]*force\.com#__PROD_DOMAIN__#g' -e 's#ts-dev#__PROD_ALIAS__#g' \
    -e 's#/Users/[^ "]*#<path>#g' "$f" && rm -f "$f.bak"
done
# CODEOWNERS owner is a person, not the org
sed -i.bak -E 's#@[A-Za-z0-9_-]+#@__OWNER__#g' "$T/.github/CODEOWNERS" && rm -f "$T/.github/CODEOWNERS.bak"
echo "template refreshed from $SRC ($(find "$T" -type f | wc -l | tr -d ' ') files); placeholders: __OWNER__, __owner__, __PROD_ORG_ID__, __PROD_DOMAIN__, __PROD_ALIAS__"
grep -rniI -e "$OWNER" -e "orgfarm-" -e "ts-dev" "$T" && { echo "!! project names still present above" >&2; exit 1; } || true
