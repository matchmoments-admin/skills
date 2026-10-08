# Mod ideas (ranked for this user's workflow)

1. **auto-handoff** (built: dev-mods/auto-handoff) — at 60% context, fork a handoff note, compact, continue.
2. **branch-guard** — `tool.call` on Bash `git commit/push/rebase/reset`: re-read the branch pointer first, deny if it moved since the last read (safeverify has concurrent agents).
3. **context-gauge** — AbovePrompt band: context %, session cost, 5h/7d rate-limit bars; turns amber at 50%, red at 60%.
4. **memory-tap** — `/remember <line>` appends a `[src: <session-id>]` entry to the repo's `memory/MEMORY.md`, no turn spent; secret/PII regex refuses.
5. **deploy-gate** — hold `vercel --prod`, `wrangler deploy`, Neon destructive MCP tools; show a diff/target summary pane with Proceed/Cancel.
6. **hook-smoke-test** — on `session.start`, fire each configured settings hook once with a dummy event and toast any that fail (an untested hook equals no hook).
7. **skill-lint** — on edits under `skills/`, check each skill dir has `SKILL.md` (catches the flat-layout `blog.md` bug that makes skills silently never load).
8. **subscription-spend-watch** — status entry that flags any `ANTHROPIC_API_KEY`/API-billing model call; this user runs on subscription, not API credits.
9. **session-ledger** — `/ledger` pane: files edited, commands run, tools used this session, for timesheet and PR descriptions.
10. **clip-guard** — deny `yt-dlp`/YouTube downloads from any Cloudflare Worker/remote context (clipwright rule: own content only).
