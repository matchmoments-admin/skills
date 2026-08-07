#!/usr/bin/env bash
# Copy the project-template starter skills into a project's .claude/skills/.
# These are the six book-derived agentic coding skills (clean-code, refactoring,
# pragmatic-programmer, clean-architecture, software-architecture,
# data-intensive-design). They are deliberately NOT symlinked globally by
# install.sh — installed per-project so they can be adapted to each codebase
# without clashing with the globally-installed vocabulary skills
# (codebase-design, domain-modeling, improve-codebase-architecture, tdd).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$REPO_ROOT/project-template"

usage() {
  echo "Usage: $(basename "$0") <project-dir>"
  echo "Copies project-template/ skills into <project-dir>/.claude/skills/"
}

if [[ $# -ne 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 1
fi

PROJECT_DIR="$1"
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "Error: project directory not found: $PROJECT_DIR" >&2
  exit 1
fi

DEST="$PROJECT_DIR/.claude/skills"
mkdir -p "$DEST"

copied=0
skipped=0
for src in "$TEMPLATE_DIR"/*/; do
  name="$(basename "$src")"
  if [[ -e "$DEST/$name" ]]; then
    echo "skip: $name (already exists in $DEST)"
    skipped=$((skipped + 1))
  else
    cp -R "$src" "$DEST/$name"
    echo "copy: $name"
    copied=$((copied + 1))
  fi
done

echo "Done: $copied copied, $skipped skipped -> $DEST"
echo "Commit .claude/skills/ so the project keeps its starter skills."
