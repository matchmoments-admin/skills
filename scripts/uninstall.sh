#!/usr/bin/env bash
# Remove symlinks created by install.sh from ~/.claude/skills/.
# Only removes symlinks that point into THIS repo — leaves other skills (and
# any *.bak files install.sh created) untouched.
#
# Usage:
#   ./scripts/uninstall.sh           # remove repo-symlinks
#   ./scripts/uninstall.sh --restore # also restore .bak files in place
#   ./scripts/uninstall.sh --dry-run

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
SKILLS_DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

RESTORE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --restore) RESTORE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *)
      echo "unknown arg: $arg"; exit 2 ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY: $*"
  else
    "$@"
  fi
}

if [[ ! -d "$SKILLS_DEST" ]]; then
  echo "Nothing to uninstall — $SKILLS_DEST does not exist."
  exit 0
fi

removed=0
restored=0
skipped=0

shopt -s nullglob
for entry in "$SKILLS_DEST"/*; do
  # Only act on symlinks that point into this repo's skills dir.
  if [[ -L "$entry" ]]; then
    target="$(readlink "$entry")"
    if [[ "$target" == "$SKILLS_SRC"/* ]]; then
      run rm "$entry"
      echo "  removed $(basename "$entry")"
      removed=$((removed + 1))

      # Restore .bak if requested and present.
      if [[ "$RESTORE" -eq 1 && -e "${entry}.bak" ]]; then
        run mv "${entry}.bak" "$entry"
        echo "    restored $(basename "$entry") from .bak"
        restored=$((restored + 1))
      fi
    else
      skipped=$((skipped + 1))
    fi
  fi
done

echo ""
echo "✓ Uninstall complete."
echo "  Removed:  $removed symlinks"
[[ "$restored" -gt 0 ]] && echo "  Restored: $restored from .bak"
[[ "$skipped" -gt 0 ]] && echo "  Skipped:  $skipped (symlinks not from this repo)"

if [[ "$RESTORE" -ne 1 ]]; then
  remaining_baks=$(find "$SKILLS_DEST" -maxdepth 1 -name "*.bak" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$remaining_baks" -gt 0 ]]; then
    echo ""
    echo "Note: $remaining_baks .bak file(s) remain in $SKILLS_DEST."
    echo "      Re-run with --restore to put them back, or delete manually."
  fi
fi
