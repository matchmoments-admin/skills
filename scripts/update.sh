#!/usr/bin/env bash
# Pull the latest skills from the remote and re-run install.sh to pick up new
# entries. Existing symlinks survive the pull untouched (they point to the
# repo's working tree, which the pull updates in place).
#
# Usage: ./scripts/update.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT"

if [[ ! -d ".git" ]]; then
  echo "error: $REPO_ROOT is not a git repository. Did you clone it?"
  exit 1
fi

# Stash any local edits before pulling so the FF doesn't fail.
stashed=0
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Local changes detected — stashing before pull."
  git stash push -u -m "skills update.sh auto-stash $(date -Iseconds)"
  stashed=1
fi

git pull --ff-only
echo ""

"$REPO_ROOT/scripts/install.sh"

if [[ "$stashed" -eq 1 ]]; then
  echo ""
  echo "Re-applying stashed changes."
  git stash pop || {
    echo "Conflict applying stash — your changes are still in 'git stash list'."
    exit 1
  }
fi
