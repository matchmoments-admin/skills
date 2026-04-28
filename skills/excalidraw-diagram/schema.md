# Excalidraw JSON cheat sheet

Reference for the agent generating Excalidraw JSON. The schema is finicky; getting it slightly wrong produces files that excalidraw.com refuses to import or that look correct in the JSON but render strangely. Read this whenever you've forgotten the exact field names.

## Top-level document

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "gridSize": null
  },
  "files": {}
}
```

- `type` and `source` are constants; do not change them.
- `version` is the schema version (currently 2).
- `appState.gridSize` of `null` hides the visible grid; pass an integer (e.g. 20) to display it.

## Common element fields (every element)

```json
{
  "id": "string-unique-per-element",
  "type": "rectangle | ellipse | diamond | arrow | line | text | freedraw",
  "x": 0, "y": 0,
  "width": 0, "height": 0,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "groupIds": [],
  "frameId": null,
  "roundness": null,
  "seed": 12345,
  "version": 1,
  "versionNonce": 0,
  "isDeleted": false,
  "boundElements": [],
  "updated": 0,
  "link": null,
  "locked": false
}
```

- **`id`** — any unique string. Use kebab-case (`ingestion-card`, `arrow-1-to-2`) so debugging is easier.
- **`x`, `y`** — top-left corner, in scene coordinates. Snap to a grid (20 or 40px) for clean alignment.
- **`width`, `height`** — must be non-zero for shapes. For text, can be left to estimate from content but better to set explicitly.
- **`angle`** — rotation in radians. Almost always `0`.
- **`strokeColor`** — stroke and (for text) text color. Hex string.
- **`backgroundColor`** — fill color. Use `"transparent"` (literally that string) for no fill.
- **`fillStyle`** — `"solid"` is the only one that looks clean in both Excalidraw and our renderer; `"hachure"` and `"cross-hatch"` only look right in Excalidraw, not in our PNG preview, so prefer `"solid"`.
- **`strokeWidth`** — `1`, `2`, or `4`. Use `2` for normal strokes, `4` for emphasis.
- **`strokeStyle`** — `"solid"`, `"dashed"`, or `"dotted"`.
- **`roughness`** — `0` (clean), `1` (default), `2` (hand-drawn). Set to `1` for normal blog-post diagrams; our PNG renderer ignores this.
- **`roundness`** — for rectangles, set to `{"type": 3}` for rounded corners, or `null` for sharp.
- **`groupIds`** — array of group ids when elements should be grouped. Usually `[]`.
- **`seed`, `version`, `versionNonce`, `updated`** — Excalidraw uses these for deterministic rough rendering and history. Pick any integers; `seed` should differ between elements for variety, but Excalidraw won't reject duplicates.

## Element-specific fields

### Rectangle, ellipse, diamond

No additional fields beyond the common set. Diamond is rendered using the bounding box.

### Text

```json
{
  "type": "text",
  "text": "Hello",
  "originalText": "Hello",
  "fontSize": 20,
  "fontFamily": 2,
  "textAlign": "left",
  "verticalAlign": "top",
  "containerId": null,
  "lineHeight": 1.25,
  "baseline": 18
}
```

- **`text`** and **`originalText`** — set both to the same string. `originalText` preserves the user's input across edits; setting only one causes weird rendering.
- **`fontSize`** — `16` (small), `20` (medium, default), `28` (large), `36` (xlarge). You can use intermediate values (e.g. `24`) but stick to these for visual consistency.
- **`fontFamily`** — integer: `1` = Virgil (hand-drawn, default), `2` = Helvetica, `3` = Cascadia (mono). Use `1` for diagram labels, `3` for code/log snippets, `2` rarely.
- **`textAlign`** — `"left" | "center" | "right"`.
- **`verticalAlign`** — `"top" | "middle" | "bottom"`.
- **`containerId`** — id of a shape this text is bound to (e.g. label inside a rectangle). When set, Excalidraw centres the text inside the container automatically. Use `null` for free-floating text.
- **`width`, `height`** — set to actual rendered dimensions. Approximate: `width ≈ 0.6 × fontSize × longestLineLength`, `height ≈ fontSize × lineCount × lineHeight`.

### Arrow / line

```json
{
  "type": "arrow",
  "x": 100, "y": 200,
  "width": 200, "height": 0,
  "points": [[0, 0], [200, 0]],
  "lastCommittedPoint": null,
  "startBinding": null,
  "endBinding": null,
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "elbowed": false
}
```

- **`points`** — array of `[dx, dy]` offsets **relative to the element's `x`, `y`**. The first point is always `[0, 0]`. Two points = straight line; three points = curved.
- **`width`, `height`** — derived from points. Set to `(max(px) - min(px), max(py) - min(py))`.
- **`startArrowhead`, `endArrowhead`** — `null`, `"arrow"`, `"triangle"`, `"bar"`, `"dot"`. For arrows, set `endArrowhead` to `"arrow"` (or `"triangle"`) and leave `startArrowhead` as `null`.
- **`startBinding`, `endBinding`** — bind an arrow to a shape so it follows when the shape moves. Format: `{"elementId": "rect-1", "focus": 0, "gap": 4}`. Setting these makes diagrams much more robust to manual editing later. If unsure, set both to `null` and rely on absolute coordinates.

### Freedraw

```json
{
  "type": "freedraw",
  "points": [[0, 0], [10, 5], [...]],
  "pressures": [],
  "simulatePressure": true,
  "lastCommittedPoint": null
}
```

- Used for hand-drawn squiggles or annotations. Rare in clean diagrams; usually you want `arrow` or `line`.

## Anchoring text inside a shape

Two approaches:

1. **Free-floating text** — separate text element with manual `x`, `y` to position it inside the rectangle. Simple, but if the rectangle moves the text doesn't follow.
2. **Bound text** — set the text's `containerId` to the rectangle's id, and add the text's id to the rectangle's `boundElements` array as `{"id": "text-1", "type": "text"}`. Excalidraw will centre the text inside the rectangle and keep them locked together. This is the approach Excalidraw uses when you double-click a shape and type into it.

For diagrams generated from scratch, **bound text is preferred** — it survives manual editing in Excalidraw without breaking layout.

Example:

```json
{
  "id": "rect-1",
  "type": "rectangle",
  "x": 100, "y": 100, "width": 200, "height": 80,
  "boundElements": [{"id": "text-1", "type": "text"}]
}
```

```json
{
  "id": "text-1",
  "type": "text",
  "x": 0, "y": 0,
  "width": 200, "height": 80,
  "text": "Ingestion",
  "originalText": "Ingestion",
  "fontSize": 20,
  "fontFamily": 1,
  "textAlign": "center",
  "verticalAlign": "middle",
  "containerId": "rect-1"
}
```

When `containerId` is set, the text's `x`/`y`/`width`/`height` are recomputed by Excalidraw on import, so you can leave them as zeros and Excalidraw will fix them up. Our PNG renderer doesn't run that fix-up, though — for the validation render, set the text's coordinates to match the container so the preview is accurate.

## Common gotchas

- **Element order matters**: elements are rendered top-to-bottom, so put background fills first and labels/arrows last in the `elements` array. Otherwise text disappears under filled shapes.
- **`points` are relative**: a common bug is putting absolute coordinates into an arrow's `points`. The arrow appears at the wrong place because the element's own `x`,`y` is then added.
- **Don't omit `originalText`**: text without `originalText` sometimes renders as empty when re-opened in Excalidraw.
- **Whitespace between rooms**: when generating multi-room layouts, keep at least 80px between room rectangles. Tight spacing reads as overlap even if the boxes don't actually intersect.
- **Long text overflows containers silently**: Excalidraw doesn't wrap text in bound containers automatically (unless you set `lineHeight` and the text contains explicit `\n`). Either pre-wrap the text with newlines or size the container generously.
- **Stick to the palette**: every `strokeColor` and `backgroundColor` should come from the palette JSON. Mixing in random hex codes is the fastest way to make a diagram look amateur.
