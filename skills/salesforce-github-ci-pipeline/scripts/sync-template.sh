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
copy pipeline .github scripts/ci scripts/skills-sync.sh scripts/vendor.sh config e2e/support playwright.config.ts \
     devhub-setup/main/default/settings \
     CLAUDE.md REVIEW.md GLOSSARY.md package.json package-lock.json .prettierrc .prettierignore .eslintrc.json jest.config.js .forceignore \
     sfdx-project.json code-analyzer.yml .gitignore docs/agents docs/handbook.md GLOSSARY-MAP.md \
     .claude/skills/apex-testing   # the Apex test standard as a project skill (it points at docs/agents/apex-testing.md)   # .github, copied whole, holds the issue forms
# the test data: the template ships it with standard fields only (custom fields are the business's own) and no story data
if [ -d "$SRC/data/seed" ]; then
  rm -f "$T/config/packages.json"   # production's managed packages are per org: each team lists its own
  mkdir -p "$T/data" && cp -R "$SRC/data/seed" "$T/data/seed" && rm -rf "$T/data/seed/stories" "$T"/data/seed/story-*.json
  # shipped stories' seeds folded into the baseline (seed-fold) are the project's own: their plan steps go too
  node -e 'const fs=require("fs"),f=process.argv[1];if(fs.existsSync(f)){const p=JSON.parse(fs.readFileSync(f,"utf8"));fs.writeFileSync(f,JSON.stringify(p.filter((s)=>!s.files.every((x)=>x.startsWith("story-"))),null,2))}' "$T/data/seed/plan.json"
  for f in "$T"/data/seed/*.json; do
    node -e 'const fs=require("fs"),f=process.argv[1],j=JSON.parse(fs.readFileSync(f,"utf8"));if(j.records){for(const r of j.records)for(const k of Object.keys(r))if(/__c$/.test(k))delete r[k];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")}' "$f"
  done
fi
# the baseline excludes the CI permission set make-ci-cert.sh creates (Pipeline_CI); the reference repo's own older
# name (Lifecycle_CI) is not a new repo's
if [ -f "$T/config/baseline.json" ]; then
  sed -i.bak -e 's#"PermissionSet:Lifecycle_CI", ##' -e 's#; Lifecycle_CI is the same for the repo the template came from##' "$T/config/baseline.json" && rm -f "$T/config/baseline.json.bak"
  grep -q '"PermissionSet:Pipeline_CI"' "$T/config/baseline.json" || { echo "!! config/baseline.json must exclude PermissionSet:Pipeline_CI (make-ci-cert.sh's)" >&2; exit 1; }
  ! grep -q 'Lifecycle_CI' "$T/config/baseline.json" || { echo "!! the template's config/baseline.json still names Lifecycle_CI: the reference repo's text changed, update the rewrite above" >&2; exit 1; }
fi
# FFLib's pinned commits for bootstrap.sh: the reference repo's docs/vendor.md rows, never a second copy by hand
# (name, repository, commit, folders; tab-separated; the why is the new repo's own, written by bootstrap.sh)
if [ -f "$SRC/docs/vendor.md" ]; then
  node -e 'const fs=require("fs");const rows=[...fs.readFileSync(process.argv[1],"utf8").matchAll(/^\| `(fflib-apex-[a-z]+)` \| (\S+) \| `([0-9a-f]{40})` \| (.+?) \| .+? \|$/gm)].map((m)=>[m[1],m[2],m[3],m[4].replace(/`/g,"")].join("\t"));if(rows.length!==2){console.error("!! docs/vendor.md: expected fflib-apex-common and fflib-apex-mocks rows, found "+rows.length);process.exit(1)}fs.writeFileSync(process.argv[2],rows.join("\n")+"\n")' "$SRC/docs/vendor.md" "$SKILL/assets/fflib-pins.tsv"
fi
# the org's business glossary is the project's own: the template starts it empty
mkdir -p "$T/docs/org" && printf '# The Salesforce org: domain glossary\n\nThe business words specs and stories use, and what each one is in the org.\n\n| Term | Meaning | In the org |\n| --- | --- | --- |\n' > "$T/docs/org/GLOSSARY.md"
rm -rf "$T/pipeline/test/fixtures/"*.json.tmp "$T/node_modules"
# the handbook links the reference repo's own files (run logs, its README): a link the template does not ship becomes text
node -e 'const fs=require("fs"),path=require("path"),f=process.argv[1];if(fs.existsSync(f)){const d=path.dirname(f);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/\[([^\]]+)\]\(((?!https?:|#|mailto:)[^)#\s]+)(#[^)]*)?\)/g,(m,t,l)=>fs.existsSync(path.join(d,l))?m:t))}' "$T/docs/handbook.md"
# placeholders for anything project-specific
OWNER=$(git -C "$SRC" remote get-url origin | sed -E 's#.*github.com[:/]([^/]+)/.*#\1#')
PROD=$(jq -r '.sourceOrg // empty' "$SRC/config/scratch-dev.json" 2>/dev/null || true)
OWNER_LC=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')   # the App's slug is lowercase (owner-pipeline)
PROJECT=$(basename "$(git -C "$SRC" remote get-url origin)" .git)   # the repository's name (package.json, sfdx-project.json)
grep -rlI . "$T" | while read -r f; do
  sed -i.bak -e "s#$PROJECT#__project__#g" -e "s#$OWNER#__OWNER__#g" -e "s#$OWNER_LC#__owner__#g" ${PROD:+-e "s#$PROD#__PROD_ORG_ID__#g"} \
    -e 's#orgfarm-[a-z0-9]*-dev-ed\.develop\.[a-z.]*force\.com#__PROD_DOMAIN__#g' -e 's#ts-dev#__PROD_ALIAS__#g' \
    -e 's#/Users/[^ "]*#<path>#g' "$f" && rm -f "$f.bak"
done
# CODEOWNERS owner is a person, not the org
sed -i.bak -E 's#@[A-Za-z0-9_-]+#@__OWNER__#g' "$T/.github/CODEOWNERS" && rm -f "$T/.github/CODEOWNERS.bak"
echo "template refreshed from $SRC ($(find "$T" -type f | wc -l | tr -d ' ') files); placeholders: __project__, __OWNER__, __owner__, __PROD_ORG_ID__, __PROD_DOMAIN__, __PROD_ALIAS__"
# nothing of the reference repo may remain: its owner, project, people, org domain or alias (scripts/bootstrap.sh fills
# the placeholders for a new repo)
grep -rniI -e "$OWNER" -e "$PROJECT" -e "orgfarm-" -e "ts-dev" -e "matchmoments" -e "Brendan" "$T" && { echo "!! project names still present above" >&2; exit 1; } || true
