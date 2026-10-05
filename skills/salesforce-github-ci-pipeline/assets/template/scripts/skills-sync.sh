#!/usr/bin/env bash
# Keeps the salesforce-github-ci-pipeline skill in step with this pipeline. Run it after changing the pipeline.
#   scripts/skills-sync.sh           1. take the skill's text (SKILL.md, references, scripts) from the skills repo when it
#                                       is on this machine (SKILLS_REPO, default ~/Desktop/projects/skills), which is the
#                                       source of truth for the text;
#                                    2. regenerate the skill's template from this repo (names scrubbed) in .claude/skills;
#                                    3. copy the result back to the skills repo, and say what to commit there.
#   scripts/skills-sync.sh --check   fail if .claude/skills' template is older than the pipeline (CI runs this)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME=salesforce-github-ci-pipeline
COPY="$ROOT/.claude/skills/$NAME"
SKILLS="${SKILLS_REPO:-$HOME/Desktop/projects/skills}/skills/$NAME"

if [ "${1:-}" = "--check" ]; then
  [ -x "$COPY/scripts/sync-template.sh" ] || { echo "no $NAME skill in .claude/skills: nothing to check"; exit 0; }
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  cp -R "$COPY" "$TMP/$NAME"
  "$TMP/$NAME/scripts/sync-template.sh" "$ROOT" >/dev/null
  if ! diff -rq "$TMP/$NAME/assets/template" "$COPY/assets/template" >/dev/null; then
    diff -rq "$TMP/$NAME/assets/template" "$COPY/assets/template" | sed "s#$TMP/$NAME#(fresh)#; s#$COPY#(committed)#" | head -20
    echo "::error::The $NAME skill's template is out of date with the pipeline. Run scripts/skills-sync.sh and commit .claude/skills."
    exit 1
  fi
  echo "skill template is up to date"; exit 0
fi

if [ -d "$SKILLS" ]; then rsync -a --delete --exclude assets/template "$SKILLS/" "$COPY/"; echo "took the skill text from $SKILLS"; fi
"$COPY/scripts/sync-template.sh" "$ROOT" | tail -1
if [ -d "$SKILLS" ]; then
  rsync -a --delete "$COPY/" "$SKILLS/"
  echo "updated $SKILLS; commit it there:"; git -C "$SKILLS" status --short -- . | head -10
fi
