# skills

A collection of [Claude Code](https://docs.claude.com/en/docs/claude-code) skills for technical content production: clean diagrams, illustrated diagrams, and end-to-end blog workflow with persona-driven voice.

Project-agnostic. Install once on any machine, use across every project.

## What's in here

| Skill                          | Purpose                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `excalidraw-diagram`           | Generate clean shape-and-arrow diagrams as `.excalidraw` JSON. Pattern library (linear flow, multi-room, comparison, evidence, circular, 2×2). Free, fast.         |
| `gemini-diagram-illustration`  | Generate illustrated diagrams: parses content into 3–7 visual beats, fans out parallel Gemini image-gen calls, bakes images as base64 into one self-contained `.excalidraw`. |
| `blog`                         | End-to-end blog workflow with subcommands `plan / persona / outline / brief / write / audit / rewrite / repurpose`. Persona-driven voice modeled on popular bloggers. |

## Install

Requires Python 3.10+ (with Pillow for diagram rendering), Node 20+, and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code).

```bash
git clone https://github.com/<your-username>/skills.git ~/Desktop/skills
cd ~/Desktop/skills
./scripts/install.sh
```

The install script symlinks each skill into `~/.claude/skills/` so they're picked up by Claude Code. Symlinks (rather than copies) mean `git pull` instantly updates the installed skills.

For a custom install location, set `CLAUDE_SKILLS_DIR` before running:

```bash
CLAUDE_SKILLS_DIR=/some/other/path ./scripts/install.sh
```

If `~/.claude/skills/` already contains a file or directory with the same name as a skill, install backs it up to `<name>.bak` rather than overwriting. Pass `--force` to skip the backup, or `--dry-run` to preview without changing anything.

## Update

```bash
cd ~/Desktop/skills
./scripts/update.sh
```

Pulls the latest from origin and re-runs install (which is a no-op for already-correct symlinks).

## Uninstall

```bash
cd ~/Desktop/skills
./scripts/uninstall.sh             # remove the symlinks
./scripts/uninstall.sh --restore   # also restore .bak backups in place
```

Only touches symlinks pointing into this repo — leaves any other skills in `~/.claude/skills/` alone.

## Skill quick-tour

### `/excalidraw-diagram <topic>`

Pick a pattern (auto-detected or via `--pattern`), pick a palette (default `ask-arthur`, also `neutral` / `ask-arthur-dark` / `warm-editorial` shipping out of the box), generate the JSON, render to PNG with the included Pillow renderer, critique the layout, edit, repeat. Output: an `.excalidraw` file you drag into [excalidraw.com](https://excalidraw.com) or open with the Obsidian Excalidraw plugin.

```bash
/excalidraw-diagram "how our auth flow handles SSO"
/excalidraw-diagram "compare Postgres vs Mongo for X" --pattern comparison
```

### `/gemini-diagram-illustration <topic-or-source>`

Reads a blog draft (or treats your topic as a free-form prompt), segments it into 3–7 visual beats, fans out parallel Gemini image-gen calls, and bakes the resulting hero illustrations as base64 into a single `.excalidraw` file. Five style templates ship: `sketch` (default), `flat-illustration`, `watercolor`, `blueprint`, `isometric`.

Costs Gemini API credits. Two modes: `collab` (default — pause at each pipeline stage for approval) and `auto` (run end-to-end).

```bash
/gemini-diagram-illustration ~/Desktop/blog/my-post.md --style sketch
/gemini-diagram-illustration "how a phishing site lures victims" --layout circular --mode auto
```

### `/blog <subcommand>`

End-to-end blog workflow. Subcommands map to the stages of producing a post.

```bash
/blog persona list                          # show available voices
/blog persona use patio11-deep-dive         # set active persona
/blog plan "phone scam prevention"          # strategy: audience, intent, AI-citation gaps
/blog outline "phone scam prevention"       # SERP-informed structure
/blog brief "phone scam prevention"         # full content brief with sourced statistics
/blog write outline-phone-scam-prevention.md # draft using active persona + chosen template
/blog audit posts/phone-scams.md            # 5-category 0–100 quality score + punch-list
/blog rewrite posts/phone-scams.md          # apply punch-list, scrub AI phrases, retrofit E-E-A-T
/blog repurpose posts/phone-scams.md        # generate Twitter / LinkedIn / Reddit / HN / newsletter artefacts
```

Six **personas** ship out of the box, each defined as YAML frontmatter declaring [NNGroup 4-dimension tone scores](https://www.nngroup.com/articles/tone-of-voice-dimensions/), sentence-length distribution, vocabulary tier, do's and don'ts, and signature moves:

- `troy-hunt` — Australian security pragmatist
- `patio11-deep-dive` — long-form technical-financial
- `cloudflare-engineering` — "how we built X" engineering retrospective
- `dan-luu-analysis` — contrarian data-rich analysis
- `krebs-investigative` — source-backed investigative journalism
- `house-template` — fillable starter for your own brand voice

Six **content templates** ship: `deep-dive`, `post-mortem`, `how-to`, `comparison`, `incident-report`, `announcement`. Six **reference docs** carry the cross-cutting rules: AI-phrase scrubber (data file with banned phrases + replacements), AI-citation playbook (GEO/AEO), distribution playbooks per channel, E-E-A-T signals, internal-linking rules, quality-scoring framework.

## Adding your own skill

Drop a `<skill-name>.md` file (the orchestrator) and an optional `<skill-name>/` directory of supporting files into `skills/`. Re-run `./scripts/install.sh`. The new skill is symlinked into `~/.claude/skills/` and immediately available as `/<skill-name>` in Claude Code.

Good skills generally have:

- A short, clear orchestrator file that describes when to use the skill, the inputs it takes, and how it dispatches.
- A subdirectory of supporting files (workflows, references, templates, data) that the orchestrator instructs the agent to read on demand.
- A small Python or shell helper for the deterministic bits (file generation, validation, scoring) so the LLM can offload formatting work.

See `skills/blog/`, `skills/excalidraw-diagram/`, and `skills/gemini-diagram-illustration/` as worked examples of the pattern.

## Acknowledgements

The `blog` skill borrows its persona-framework idea, AI-phrase scrubbing approach, and content-template taxonomy from [AgriciDaniel/claude-blog](https://github.com/AgriciDaniel/claude-blog) (MIT-licensed). claude-blog provides a 22-sub-skill ecosystem aimed at content marketing teams; this skill consolidates the parts that matter for solo technical founders into one workflow.

The `gemini-diagram-illustration` skill is inspired by Adam Goodyer's Gemini-Diagram-Illustration approach, with the renderer swapped from Playwright (browser-based) to a base64-embed pipeline that uses the existing Gemini MCP tools.

The `excalidraw-diagram` skill's render → critique → edit loop is inspired by Cole Medin's Excalidraw Skill workflow, with the Python renderer swapped from a browser-based approach to a dependency-free Pillow port.

## License

[MIT](LICENSE).

Persona files name real bloggers (Troy Hunt, Patrick McKenzie, Dan Luu, Brian Krebs) as voice references. The personas describe stylistic patterns that are publicly observable from those bloggers' published work; they do not claim endorsement, affiliation, or any kind of ownership. If you're one of the named bloggers and would prefer not to be referenced this way, open an issue and the persona will be renamed.
