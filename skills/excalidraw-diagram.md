# excalidraw-diagram

Generate hand-drawn-style diagrams as Excalidraw JSON, then validate them visually with a self-correcting loop. Output is a `.excalidraw` file (open at excalidraw.com or in the Obsidian Excalidraw plugin) plus a preview PNG.

The whole point of this skill is to push past the default LLM bias toward "boxes connected by arrows." It enforces visual hierarchy, deliberate layout patterns, and a render → critique → edit loop so jank gets caught before the file lands in front of a human.

## Usage

```
/excalidraw-diagram <topic-or-file-or-blog-draft>
  [--output <path>]         # default: ./diagrams/<slug>.excalidraw (PNG sibling)
  [--palette <name>]        # default: ask-arthur (see color_palette.json)
  [--pattern <name>]        # force a specific pattern from patterns.md
  [--max-iterations <n>]    # default: 3 — max critique → edit cycles
  [--no-validate]           # skip the render+critique loop, just emit JSON
```

## Files in this skill

```
~/.claude/skills/excalidraw-diagram.md          ← you are here
~/.claude/skills/excalidraw-diagram/
├── color_palette.json    Brand palettes (ask-arthur default + neutral fallback)
├── render_diagram.py     Excalidraw JSON → PNG via Pillow (no browser deps)
├── patterns.md           Visual patterns library (multi-room, evidence, comparison, …)
└── schema.md             Excalidraw JSON cheat sheet — coordinates, element types, gotchas
```

## Workflow

### 1. Parse the input

Pull the topic/file path/draft from the user's free-form first argument. Parse named flags. Resolve `--output` to an absolute path; default to `./diagrams/<kebab-slug-of-topic>.excalidraw` in the current working directory. Create the parent directory if needed.

If the input is a file path or blog draft, read it before designing the diagram so the visuals reflect the actual content (not a generic interpretation of the title).

### 2. Idea assessment

Decide whether the diagram is **simple** (≤ ~15 elements, single concept) or **complex** (multiple subsystems, layered concepts, evidence + flow + commentary).

- **Simple** → design and emit in one pass.
- **Complex** → break into named sections (e.g. "ingestion", "scoring", "verdict") and design each section's coordinates independently before stitching. This avoids token-budget collapse mid-diagram and keeps element counts predictable per section.

State the chosen complexity in one sentence to the user before generating.

### 3. Pick a pattern

Read `~/.claude/skills/excalidraw-diagram/patterns.md` and pick the pattern that fits the content. Default mappings:

- Process / pipeline → **Linear flow** with annotated stages
- Architecture / system map → **Multi-room layout** with labeled regions
- Before/after, option vs option → **Comparison columns**
- Cause → effect → mitigation → **Evidence artifacts** (quote/log boxes feeding into a verdict)
- Cyclical / feedback → **Circular flow**
- Tradeoff space → **2×2 quadrant**

If `--pattern <name>` was passed, use it without reassessing.

### 4. Load the palette

Read `~/.claude/skills/excalidraw-diagram/color_palette.json`. Pick the palette named by `--palette` (default `ask-arthur`). Use the palette's hex codes verbatim — do not invent colors. Reserve the `accent` slot for the most important element (~1–3 uses), `primary` for structure, `muted` for secondary, `bg` for fills.

### 5. Generate Excalidraw JSON

Read `~/.claude/skills/excalidraw-diagram/schema.md` if you don't already remember the field shapes — the schema is finicky (relative `points` arrays for arrows, `containerId` for label-bound text, integer `fontFamily`, etc.).

Write the file directly to `<output>.excalidraw`. Top-level shape:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [ /* … */ ],
  "appState": { "viewBackgroundColor": "<palette.bg>", "gridSize": null },
  "files": {}
}
```

Layout rules to enforce (these are what separate a "good" diagram from a generic boxes-and-arrows one):

- **Visual hierarchy** — the most important element should be the largest or the most saturated, not just first in reading order.
- **Whitespace is structure** — leave at least 40px between unrelated elements; use tight spacing (≤ 16px) only for elements that belong together.
- **Arrows have intent** — every arrow should answer "what flows along this edge?" If you can't label it in 1–3 words, the arrow shouldn't exist.
- **Labels live near their referent** — text labels within 8–24px of their element, never floating mid-canvas.
- **Align to a grid** — pick a base unit (20 or 40px) and snap all `x`, `y`, `width`, `height` to multiples of it. Misaligned elements look janky even when individually correct.
- **No overlapping elements** unless the overlap is meaningful (e.g. a verdict badge sitting on a card corner).

### 6. Render and critique (the validation loop)

Unless `--no-validate` is set, run:

```bash
python3 ~/.claude/skills/excalidraw-diagram/render_diagram.py <output>.excalidraw
```

This emits `<output>.png` next to the JSON. The renderer is a pragmatic Pillow port of the Excalidraw element model — it draws clean (non-rough) shapes good enough to validate **layout, sizing, alignment, arrow paths, and label placement**. It is not pixel-faithful to Excalidraw's hand-drawn style; that's fine, because layout problems show up regardless of stroke aesthetic.

Then critique the PNG. If Gemini vision is available in this environment (`mcp__gemini__gemini-analyze-image`), pass the PNG with a prompt like:

> Critique this diagram strictly on: (1) overlapping or colliding elements, (2) arrows whose endpoints miss their target, (3) text that overflows its container or lands on top of a line, (4) misaligned elements that should share an edge, (5) crowded vs. sparse regions. List concrete problems with element ids if visible. Skip stylistic praise.

If Gemini is unavailable, do the critique yourself by re-reading the JSON against the rendered PNG mentally — focus on the same five categories.

For each problem, edit the JSON directly (move coordinates, resize containers, re-route `points` for arrows, shorten text). Re-render. Stop when the critique returns no concrete problems, or after `--max-iterations` cycles (default 3).

### 7. Report

Print to the user:

- Path to the `.excalidraw` file (so they can open it at excalidraw.com or via the Obsidian plugin)
- Path to the preview PNG
- Pattern used and palette used
- Number of validation iterations and a one-line summary of what was fixed each iteration

Do not paste the JSON into the chat — it's noisy and the file is the deliverable.

## Customisation

- **Add a palette**: append a new keyed entry to `color_palette.json`. Each palette needs at least `bg`, `primary`, `accent`, `muted`, `text`, plus optional `safe` / `warn` / `danger` for verdict diagrams.
- **Add a pattern**: append a section to `patterns.md` with a short description, a use-case heuristic, and an ASCII sketch of element placement.
- **Tighter renderer**: `render_diagram.py` is intentionally simple (no rough.js port). If you need higher-fidelity previews, swap in a Playwright-based renderer that loads excalidraw.com and exports via its built-in API — but the Pillow version is faster and dependency-free, which matters for a skill that runs ad-hoc.

## Notes

- The `.excalidraw` file format is JSON; the user opens it at <https://excalidraw.com> (drag-and-drop) or via the Obsidian Excalidraw plugin if they manage blog assets in a vault.
- Cole Medin's original skill uses a Playwright-based renderer for pixel-faithful previews. We use Pillow instead because (a) no browser install, (b) layout problems are visible at lower fidelity, (c) the deliverable is the JSON not the PNG.
- The validation loop is the part that matters most. A first-pass diagram from any LLM is almost always slightly off — overlapping labels, arrow endpoints that miss by 4px, one element that broke the grid. The render → critique → edit cycle is what makes the output ship-ready.
