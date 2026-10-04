#!/bin/bash
# Usage: bootstrap.sh <target-repo-dir>
# Copies the pipeline template into a Salesforce DX repo. Keeps the target's force-app/ and any file it already
# has under docs/. Prints every path it wrote. Run from anywhere.
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$SKILL/assets/template"
TARGET="${1:?target repo dir}"
[ -d "$TEMPLATE/pipeline" ] || { echo "Template is empty: run scripts/sync-template.sh <reference-repo> first." >&2; exit 1; }
mkdir -p "$TARGET"
cd "$TEMPLATE"
find . -type f ! -path "./force-app/*" | sort | while read -r f; do
  dest="$TARGET/${f#./}"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
  echo "wrote ${f#./}"
done
[ -d "$TARGET/force-app" ] || { mkdir -p "$TARGET/force-app/main/default"; echo "created force-app/main/default"; }
chmod +x "$TARGET"/scripts/ci/*.sh "$TARGET"/pipeline/bin/pipe.mjs 2>/dev/null || true
cat <<EOF

Next:
  1. Replace __PROD_ORG_ID__ in config/scratch-*.json after Phase 2 step 4 (Org Shape).
  2. Replace __OWNER__ in .github/CODEOWNERS.
  3. Edit CLAUDE.md and REVIEW.md for this project.
  4. cd "$TARGET" && npm install && npm run test:pipeline
EOF
