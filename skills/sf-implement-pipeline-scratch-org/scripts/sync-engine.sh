#!/usr/bin/env bash
# Usage: sync-engine.sh <sf-lifecycle-labs dir> [file...]
# Shows how this skill's engine differs from sf-lifecycle-labs' pipeline/src (the source it was derived from), file by
# file, so an upstream fix can be brought across by hand. Changes nothing. The intended differences: engine/ENGINE.md.
set -euo pipefail
UP="${1:?path to sf-lifecycle-labs}"; shift || true
HERE="$(cd "$(dirname "$0")/engine" && pwd)"
[ -d "$UP/pipeline/src" ] || { echo "$UP has no pipeline/src" >&2; exit 2; }
echo "upstream: $(git -C "$UP" log -1 --format='%h %cs %s' 2>/dev/null || echo unknown)"
FILES=("$@"); [ ${#FILES[@]} -gt 0 ] || FILES=(io.mjs conventions.mjs baseline.mjs org.mjs org/fleet.mjs org/data.mjs org/users.mjs org/snapshot.mjs org/setup-changes.mjs)
for f in "${FILES[@]}"; do
  if cmp -s "$UP/pipeline/src/$f" "$HERE/$f"; then echo "== $f: identical"; continue; fi
  echo "== $f: $(diff -u "$UP/pipeline/src/$f" "$HERE/$f" | grep -c '^[-+][^-+]' || true) changed line(s) (upstream -> skill)"
  [ "${QUIET:-}" = 1 ] || diff -u "$UP/pipeline/src/$f" "$HERE/$f" | sed -n '3,400p' || true
done
