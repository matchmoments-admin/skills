#!/usr/bin/env bash
# Sync the vendored mattpocock/skills into skills/ (flattened), keeping our local edits.
#
#   scripts/sync-upstream.sh [ref]     ref: an upstream commit, tag or branch (default: main)
#
# What it does (what was done by hand for v1.3.1):
#   1. clones upstream at <ref>;
#   2. copies every skill under skills/{engineering,productivity,misc,in-progress}/ to skills/<name>/ (flattened), except
#      the ones we do not vendor (SKIP below: code-review clashes with the built-in /code-review; the other two are
#      Total-TypeScript specific);
#   3. re-applies our local edits, kept as patches/<skill>.patch (git apply: one that no longer fits stops the script);
#   4. records the upstream commit in skills/.upstream-ref and the vendored names in skills/.upstream-skills (the
#      validator skips upstream's example links there), and lists skills upstream retired (delete them yourself).
# Run it on a branch, review `git diff`, run ./scripts/validate_skills.py and ./scripts/install.sh, then commit.
# To change a vendored skill locally: edit it, then regenerate its patch (see patches/README.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${1:-main}"
SKIP="code-review scaffold-exercises migrate-to-shoehorn"
CATEGORIES="engineering productivity misc in-progress"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

git clone -q https://github.com/mattpocock/skills.git "$TMP/up"
git -C "$TMP/up" checkout -q "$REF"
SHA=$(git -C "$TMP/up" rev-parse --short HEAD)

: > "$TMP/names"
for c in $CATEGORIES; do
  [ -d "$TMP/up/skills/$c" ] || continue
  for d in "$TMP/up/skills/$c"/*/; do
    name=$(basename "$d")
    case " $SKIP " in *" $name "*) continue ;; esac
    rsync -a --delete "$d" "$ROOT/skills/$name/"
    echo "$name" >> "$TMP/names"
  done
done
sort -o "$TMP/names" "$TMP/names"

for p in "$ROOT"/patches/*.patch; do
  [ -s "$p" ] || continue
  git -C "$ROOT" apply "$p" || { echo "✗ $(basename "$p") no longer applies: resolve, then regenerate it"; exit 1; }
  echo "re-applied $(basename "$p")"
done

if [ -f "$ROOT/skills/.upstream-skills" ]; then
  retired=$(comm -23 "$ROOT/skills/.upstream-skills" "$TMP/names" | tr '\n' ' ')
  [ -z "$retired" ] || echo "retired upstream (delete if you no longer want them): $retired"
fi
cp "$TMP/names" "$ROOT/skills/.upstream-skills"
printf '# mattpocock/skills %s\n' "$SHA" > "$ROOT/skills/.upstream-ref"
echo "synced to upstream $SHA ($(wc -l < "$TMP/names" | tr -d ' ') skills). Next: git diff, ./scripts/validate_skills.py, ./scripts/install.sh"
