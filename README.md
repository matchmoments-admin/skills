# skills

A collection of [Claude Code](https://docs.claude.com/en/docs/claude-code) skills: illustrated diagrams, slide decks, repo memory and drift checks, Salesforce delivery, and the vendored engineering flow.

Project-agnostic. Install once on any machine, use across every project.

## What's in here

| Skill                          | Purpose                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gemini-diagram-illustration`  | Generate illustrated diagrams: parses content into 3–7 visual beats, fans out parallel Gemini image-gen calls, bakes images as base64 into one self-contained `.excalidraw`. |
| `slide-deck`                   | Zero-dependency, animation-rich HTML presentations on a fixed 1920×1080 stage. "Show, don't tell" style discovery (3 visual previews → pick), 12 curated presets + an Ask Arthur brand preset, PPT→web conversion, Vercel deploy + PDF export. |
| `dream`                        | Offline memory consolidation for a repo: reads recent Claude Code transcripts, extracts durable learnings via sub-agents, merges them into the repo's `memory/` directory, and opens a PR for human review. Never merges its own output. |
| `drift-check`                  | Audits a repo's CLAUDE.md (and directory-scoped variants) against reality — commands, paths, links, conventions. ≥3 drifted claims → PR fixing only the drifted lines; fewer → report. Never touches code. |
| `salesforce-report-create`     | Create Salesforce reports by API (Analytics REST or Metadata). Covers the `__c` suffix on custom report type names, the auto-generated types that expose `CUST_OWNER_NAME`, and why running a report is a cheap assertion over production data. |
| `salesforce-dashboard-create`  | Create Salesforce dashboards as deployable metadata. The four attributes that each fail a deploy on their own, and why `LoggedInUser` is how a dashboard ships broken. |

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


### `/gemini-diagram-illustration <topic-or-source>`

Reads a blog draft (or treats your topic as a free-form prompt), segments it into 3–7 visual beats, fans out parallel Gemini image-gen calls, and bakes the resulting hero illustrations as base64 into a single `.excalidraw` file. Five style templates ship: `sketch` (default), `flat-illustration`, `watercolor`, `blueprint`, `isometric`.

Costs Gemini API credits. Two modes: `collab` (default — pause at each pipeline stage for approval) and `auto` (run end-to-end).

```bash
/gemini-diagram-illustration ~/Desktop/blog/my-post.md --style sketch
/gemini-diagram-illustration "how a phishing site lures victims" --layout circular --mode auto
```

## Adding your own skill

Create a `skills/<skill-name>/` directory containing a `SKILL.md` orchestrator (YAML frontmatter with `name` matching the directory and a trigger-optimized `description`, then the Markdown body). Re-run `./scripts/install.sh`. The new skill is symlinked into `~/.claude/skills/` and immediately available in Claude Code.

Claude Code only discovers skills as `<dir>/SKILL.md` — a loose `skills/<name>.md` file is inert.

Good skills generally have:

- A short, clear `SKILL.md` that describes when to use the skill, the inputs it takes, and how it dispatches.
- Supporting files in the same directory (workflows, references, templates, data) that the orchestrator instructs the agent to read on demand.
- A small Python or shell helper for the deterministic bits (file generation, validation, scoring) so the LLM can offload formatting work.

See `skills/grilling/`, `skills/codebase-design/`, and `skills/dream/` as worked examples of the pattern. Read `skills/writing-great-skills/SKILL.md` before writing one.

## Project-template starter skills

`project-template/` holds six book-derived agentic coding skills (`clean-code`, `refactoring`, `pragmatic-programmer`, `clean-architecture`, `software-architecture`, `data-intensive-design`) distilled from six classic software-engineering books. They are deliberately **not** under `skills/` — installing them globally would clash with the vocabulary skills already installed there (`codebase-design`, `domain-modeling`, `improve-codebase-architecture`, `tdd`). Instead, seed each **new project** with its own copy, committed to that project's repo and adapted to its conventions over time:

```bash
./scripts/new-project-skills.sh ~/path/to/new-project
```

See `project-template/README.md` for what each skill covers and how they compose.

## Acknowledgements


The `gemini-diagram-illustration` skill is inspired by Adam Goodyer's Gemini-Diagram-Illustration approach, with the renderer swapped from Playwright (browser-based) to a base64-embed pipeline that uses the existing Gemini MCP tools.


The `slide-deck` skill is vendored and adapted from [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT-licensed). This copy trims the upstream 34-template "bold pack" down to the core system (12 presets + the mandatory fixed-stage CSS, HTML template, animation reference, and PPT/deploy/export scripts) and adds an Ask Arthur brand preset. The upstream bold pack can be re-added later under `skills/slide-deck/bold-template-pack/` without changing the orchestrator's core flow.


## License

[MIT](LICENSE).

