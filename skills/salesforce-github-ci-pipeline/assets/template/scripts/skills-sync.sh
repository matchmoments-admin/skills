#!/usr/bin/env bash
# Keeps the salesforce-github-ci-pipeline skill in step with this pipeline. Run it after changing the pipeline.
#   scripts/skills-sync.sh           1. take the skill's text (SKILL.md, references, scripts) from the skills repo when it
#                                       is on this machine (SKILLS_REPO, default ~/Desktop/projects/skills), which is the
#                                       source of truth for the text;
#                                    2. regenerate the skill's template from this repo (names scrubbed) in .claude/skills;
#                                    3. copy the result back to the skills repo, and say what to commit there.
#                                    4. the salesforce-scratch-org-tests skill: its text from the skills repo, and its engine
#                                       (scripts/engine/tests.mjs) a copy of pipeline/src/tests.mjs.
#   scripts/skills-sync.sh --check   fail if .claude/skills' template or the scratch skill's engine is older than the
#                                    pipeline (CI runs this)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME=salesforce-github-ci-pipeline
COPY="$ROOT/.claude/skills/$NAME"
SKILLS="${SKILLS_REPO:-$HOME/Desktop/projects/skills}/skills/$NAME"

# The scratch-org skill runs this pipeline's test selection: a verbatim copy of pipeline/src/tests.mjs (one engine).
SCRATCH=salesforce-scratch-org-tests
SCRATCH_COPY="$ROOT/.claude/skills/$SCRATCH"
SCRATCH_SKILLS="${SKILLS_REPO:-$HOME/Desktop/projects/skills}/skills/$SCRATCH"
ENGINE=scripts/engine/tests.mjs

if [ "${1:-}" = "--check" ]; then
  if [ -d "$SCRATCH_COPY" ] && ! cmp -s "$ROOT/pipeline/src/tests.mjs" "$SCRATCH_COPY/$ENGINE"; then
    echo "::error::The $SCRATCH skill's engine ($ENGINE) differs from pipeline/src/tests.mjs. Run scripts/skills-sync.sh and commit .claude/skills."
    exit 1
  fi
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
if [ -d "$SCRATCH_SKILLS" ]; then rsync -a --delete --exclude "$ENGINE" "$SCRATCH_SKILLS/" "$SCRATCH_COPY/"; fi
if [ -d "$SCRATCH_COPY" ]; then
  mkdir -p "$SCRATCH_COPY/scripts/engine" && cp "$ROOT/pipeline/src/tests.mjs" "$SCRATCH_COPY/$ENGINE"
  [ ! -d "$SCRATCH_SKILLS" ] || rsync -a --delete "$SCRATCH_COPY/" "$SCRATCH_SKILLS/"
  echo "the $SCRATCH skill's engine is pipeline/src/tests.mjs"
fi
"$COPY/scripts/sync-template.sh" "$ROOT" | tail -1
if [ -d "$SKILLS" ]; then
  rsync -a --delete "$COPY/" "$SKILLS/"
  echo "updated $SKILLS; commit it there:"; git -C "$SKILLS" status --short -- . | head -10
fi
