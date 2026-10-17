#!/bin/bash
# Usage: scripts/vendor.sh <name> <https://github.com/owner/repo> <commit> "<why it is here>" <dir> [<dir>...]
# Vendors a third-party library (GLOSSARY.md: Vendored library): clones it at exactly that commit and copies the given
# folders, unmodified, to force-app/vendor/<name>/<folder name>/, then records it in docs/vendor.md (repository,
# commit, folders, why). Run again with another commit to update it. The build agent runs this rather than copying
# files itself, so what lands is byte for byte upstream's.
set -euo pipefail
[ $# -ge 5 ] || { echo "usage: scripts/vendor.sh <name> <https://github.com/owner/repo> <commit> \"<why>\" <dir> [<dir>...]" >&2; exit 2; }
name=$1 url=$2 ref=$3 why=$4; shift 4
[[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,60}$ ]] || { echo "name: lowercase letters, digits, . _ -" >&2; exit 2; }
[[ "$url" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$ ]] || { echo "repository: https://github.com/owner/repo" >&2; exit 2; }
[[ "$ref" =~ ^[0-9a-f]{7,40}$ ]] || { echo "commit: a commit SHA (pin it; never a branch)" >&2; exit 2; }
[[ "$why" != *"|"* && -n "$why" ]] || { echo "why: one line, no |" >&2; exit 2; }
for d in "$@"; do [[ "$d" =~ ^[A-Za-z0-9._/-]+$ && "$d" != *..* && "$d" != /* ]] || { echo "folder: a path inside the repository ($d)" >&2; exit 2; }; done
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --filter=blob:none --no-checkout "$url" "$tmp/src"
git -C "$tmp/src" checkout -q "$ref"
sha=$(git -C "$tmp/src" rev-parse HEAD)
dest="$root/force-app/vendor/$name"
rm -rf "$dest" && mkdir -p "$dest"
for d in "$@"; do
  [ -d "$tmp/src/$d" ] || { echo "no folder $d at $sha" >&2; exit 2; }
  cp -R "$tmp/src/$d" "$dest/$(basename "$d")"
done
# docs/vendor.md: one row per library, replaced on update
doc="$root/docs/vendor.md"
# shellcheck disable=SC2016  # the backticks are markdown
[ -f "$doc" ] || printf '# Vendored libraries\n\nThird-party source kept unmodified under `force-app/vendor/` (GLOSSARY.md: Vendored library), added and updated\nonly with `scripts/vendor.sh`. The code checks skip it; its tests run with ours.\n\n| Library | Repository | Commit | Folders | Why |\n| --- | --- | --- | --- | --- |\n' > "$doc"
# shellcheck disable=SC2016
row="| \`$name\` | $url | \`$sha\` | $(printf '`%s` ' "$@" | sed 's/ $//') | $why |"
grep -v "^| \`$name\` |" "$doc" > "$tmp/doc" || true
printf '%s\n' "$row" >> "$tmp/doc"
cp "$tmp/doc" "$doc"
echo "vendored $name at $sha: $(find "$dest" -type f | wc -l | tr -d ' ') files in force-app/vendor/$name; docs/vendor.md updated"
