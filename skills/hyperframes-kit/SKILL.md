---
name: hyperframes-kit
description: Create or edit videos with HyperFrames + GSAP using Nate Herk's student kit — motion-graphics videos from a brief, reels/Shorts from a recording, silence and mistake cutting, storytelling beats, style cards, and verified MP4 rendering. Use when the user wants to make a video, edit footage, build a reel, animate a scene, or mentions HyperFrames. Routes to the kit's 14 project skills.
---

# HyperFrames kit (router)

The kit lives at `~/Desktop/projects/hyperframes-student-kit` (clone of
`nateherkai/hyperframes-student-kit`). Its 14 skills are **workspace-bound**: every
script path, style card, and `node_modules/hyperframes` is relative to that root.
This skill exists so those skills are reachable from any directory.

## Two ways in

1. **Best:** start Claude Code inside the kit. The project skills auto-load and
   `/edit-video`, `/make-a-video`, `/short-form-edit` etc. work as slash commands.
   Tell the user this if they are in another directory and about to do a long edit.
2. **From anywhere:** run every command with the kit as cwd and load the kit's skill
   file by absolute path before acting:

   ```bash
   KIT=~/Desktop/projects/hyperframes-student-kit
   cat "$KIT/CLAUDE.md"                              # standing workspace guide — read first
   cat "$KIT/.claude/skills/<skill>/SKILL.md"        # the specialist you are routing to
   cd "$KIT" && node scripts/preflight.mjs video-projects/<slug>
   ```

   `.claude/skills/` is canonical; `.agents/skills/` is a Codex mirror — never edit it.

## Route

| User wants | Kit skill |
| --- | --- |
| A new motion-graphics video from a concept/script | `make-a-video` |
| A full edit of a raw talking-head recording | `edit-video` (orchestrates the rest) |
| A 9:16 reel / YouTube Short from footage | `short-form-edit` |
| A video from a website URL | `website-to-hyperframes` |
| Cut dead air only | `cut-silences` |
| Cut retakes / false starts / stutters | `cut-mistakes` |
| Narrative arc, callbacks, visual world | `video-storytelling` |
| Overlay beats, paper takeovers, glass cards | `hyperframes-video-beats` |
| Pick or extend a style / scene template | `style-library` |
| HTML composition rules, media timing, captions | `hyperframes` |
| Preview, lint, render, doctor | `hyperframes-cli` |
| GSAP timeline animation | `gsap` |
| Install catalog blocks/components | `hyperframes-registry` |
| Maintain the older May Shorts examples | `short-form-video` |

If the user just wants a transcript, summary, or highlight list from an existing
video, that is `video-digest` / `video-moments` / `video-toolkit`, not this kit.

## Workspace rules that matter

- New project: `cd $KIT && npm run new-video -- <slug>` → `video-projects/<slug>/`.
  Run `npx hyperframes lint|preview|render` **from inside that project folder**.
- `video-projects/*` (except the shipped examples) and `raw-media/` are gitignored.
  Never copy the user's footage into the shipped examples or the style library.
- Pipeline order for recordings: transcribe → `cut-silences` → `cut-mistakes`
  (using the silence pass's video **and** retimed transcript) → beats → compose →
  preflight + lint → Studio review → draft render → frame/audio inspection → final.
  Never mix original timestamps with edited footage.
- Draft render: `npx hyperframes render --quality draft --output renders/<name>.mp4`.
  A clean lint is not proof of visual quality — inspect frames and transition
  boundaries, and record what was checked in the project's `VERIFY.md`.
- Only publish/upload when the user authorizes it. Honor approvals already given;
  don't re-ask for the same authorized action.

## Services and keys

`$KIT/.env` exists (gitignored) and is empty of keys. Before any paid call, read
`$KIT/docs/TOOLS-AND-API-KEYS.md` and say what will be uploaded and what it costs.

- Transcription: the bundled script is ElevenLabs-only (`ELEVENLABS_API_KEY`).
  Whisper is the free alternative — `video-toolkit` already documents the local
  whisper setup; its word-level JSON needs normalising to `{ words: [{text,start,end}] }`.
- Asset generation: Kie.ai (optional, needs key + credits). Prefer the user's own
  footage first; propose generated assets only when nothing local fits.
- Optional local fallbacks flagged by `npx hyperframes doctor` and not installed:
  whisper-cpp (`brew install whisper-cpp`), Kokoro TTS, MusicGen, Docker.

## Verified state (2026-09-11)

`npm ci`, `npm run setup`, `npm test` (11/11) and a draft render of
`video-projects/demo` (8s 1080p, 7.9s render) all pass on this machine with
Node 22.23.1, ffmpeg 4.3.2, and the puppeteer-cached Chrome headless shell.
Update the kit with `cd $KIT && git pull && npm ci`.
