---
name: make-mod
description: Build a Claude Code mod (a plugin of in-process function hooks that draws panes/bands, guards tool calls, adds commands). Use when the user says "make a mod", "write a hook that draws/blocks/reacts", or wants a pane, status entry, auto-action or guard inside Claude Code. Wraps the built-in plugin-authoring skill with this user's conventions.
argument-hint: "What should the mod do?"
---

Docs: https://code.claude.com/docs/en/plugins/mods/overview (create, events, api, test, troubleshoot, reference sub-pages).

## Steps

1. **Pick the mechanism first.** A mod only earns its place when it must run *inside* Claude Code (draw UI, rewrite/hold an event, react to context/turns). If a settings hook (shell script), skill (instructions) or MCP server does it, say so and use that instead.
2. **Load the built-in `plugin-authoring` skill** (Skill tool). It owns the exact file layout, the dev-mods folder for this session, and the generated type file. Do not copy its API details here; they change per build.
3. **Write three files** (plus `types/index.d.ts` only if using `$.state`): `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts`.
4. **Verify, in order:** `claude plugin validate <dir>` (read the `hooks:`/`calls:` lines: do they match intent?) → `tsc -p <dir>` once loaded → one `*.test.ts` for the asked behaviour → `claude plugin test <dir>`.
5. **Tell the user** the full path, whether hot reload is enabled, and what it can reach (mods run with their permissions, unsandboxed).

## House rules

- State a drawing reads lives in `$.state`; across sessions in `$.store`. Module variables die on hot reload.
- Work that outlives a hook runs from `$.clock.after/every` started in `session.start` or a hook, never an un-awaited promise inside the dispatch.
- `$.session.compact` rejects while a turn runs: schedule it with `$.clock.after`, retry, and guard against re-entry.
- Never log or write secrets. Anything written to disk goes outside the repo (`/tmp/...`) unless asked.
- Prefer the smallest hook set. Every extra event is a thing that can fail silently; failed hooks are skipped and noted in a dim transcript line / `claude --debug`.
- Mods that act without asking (approve tool calls, submit prompts) need an obvious off switch: a `userConfig` option or a `/command`.
- Keep finished mods under `~/Desktop/projects/mods/<name>/` in git; promote from the session's dev-mods folder once they work. Install via `--plugin-dir` or a local marketplace.

## Suggest mods from usage

When asked "what mods should I make", read `memory/MEMORY.md`, recent transcripts and repeated friction, then rank ideas by (pain removed) ÷ (hook surface). See `ideas.md`.
