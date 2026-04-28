#!/usr/bin/env bash
# Install (or refresh) every skill in skills/ into ~/.claude/skills/ via symlink.
#
# Usage:
#   ./scripts/install.sh           # default — back up conflicts to .bak
#   ./scripts/install.sh --force   # overwrite conflicts without backup
#   ./scripts/install.sh --dry-run # show what would happen, change nothing
#
# Idempotent. Re-run after `git pull` to pick up new skills.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
SKILLS_DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
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

mkdir -p "$SKILLS_DEST"

linked=0
skipped=0
backed_up=0
overwritten=0

# Iterate over top-level entries (each skill = a .md file + optional sibling directory).
shopt -s nullglob
for src_path in "$SKILLS_SRC"/*; do
  name="$(basename "$src_path")"
  dest_path="$SKILLS_DEST/$name"

  # Already a symlink to the right place? Skip.
  if [[ -L "$dest_path" ]]; then
    actual="$(readlink "$dest_path")"
    if [[ "$actual" == "$src_path" ]]; then
      skipped=$((skipped + 1))
      continue
    fi
  fi

  # Conflict: something exists at dest, not pointing here.
  if [[ -e "$dest_path" || -L "$dest_path" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      run rm -rf "$dest_path"
      overwritten=$((overwritten + 1))
    else
      backup="$dest_path.bak"
      counter=1
      while [[ -e "$backup" ]]; do
        backup="$dest_path.bak.$counter"
        counter=$((counter + 1))
      done
      run mv "$dest_path" "$backup"
      echo "  backed up existing $name → $(basename "$backup")"
      backed_up=$((backed_up + 1))
    fi
  fi

  run ln -s "$src_path" "$dest_path"
  echo "  linked $name"
  linked=$((linked + 1))
done

echo ""
echo "✓ Install complete."
echo "  Linked:      $linked"
echo "  Already up-to-date: $skipped"
[[ "$backed_up" -gt 0 ]] && echo "  Backed up:   $backed_up (existing files preserved as *.bak)"
[[ "$overwritten" -gt 0 ]] && echo "  Overwritten: $overwritten (--force was used)"
echo ""
echo "Skills installed at: $SKILLS_DEST"
echo "Source:             $SKILLS_SRC"
echo ""
echo "Tip: run 'git pull && ./scripts/install.sh' to pick up new skills."
