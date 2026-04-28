# Excalidraw image elements + files map

Schema reference focused on what this skill actually emits: image elements with embedded base64 data, plus the layout heuristics that make multi-illustration compositions read well.

For the broader Excalidraw schema (rectangles, ellipses, arrows, text), see `~/.claude/skills/excalidraw-diagram/schema.md` — most of what's there applies here too.

---

## The image element

```json
{
  "id": "img-abc12345",
  "type": "image",
  "x": 100, "y": 100,
  "width": 320, "height": 320,
  "angle": 0,
  "strokeColor": "transparent",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 1,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "groupIds": [],
  "frameId": null,
  "roundness": null,
  "seed": 12345,
  "version": 1,
  "versionNonce": 0,
  "isDeleted": false,
  "boundElements": null,
  "updated": 1700000000000,
  "link": null,
  "locked": false,

  "fileId": "abc1234567890abcdef1234567890abcdef12345",
  "scale": [1, 1],
  "status": "saved",
  "crop": null
}
```

Key image-specific fields:

- **`fileId`** — 40-char hex string. Must match a key in the top-level `files` map. Best practice: use SHA-1 of the image bytes so identical images dedupe automatically. `compose_excalidraw.py` does this.
- **`scale`** — `[1, 1]` for un-flipped images; `[-1, 1]` to flip horizontally; `[1, -1]` to flip vertically.
- **`status`** — `"saved"` for embedded images. Excalidraw also uses `"pending"` for in-flight uploads, but you'll never emit that.
- **`crop`** — `null` to show the full image; an object `{ "x": …, "y": …, "width": …, "height": …, "naturalWidth": …, "naturalHeight": … }` to show only a region.

The image element's `width` and `height` are **rendered** dimensions, not the source image's natural size. Excalidraw scales the source image to fit. For square-ish illustrations the rendered box should respect the source aspect ratio (so 1024×1024 sketches → 320×320 boxes, 1024×768 watercolors → 400×300 boxes).

## The files map

The top-level `files` field:

```json
"files": {
  "abc1234567890abcdef1234567890abcdef12345": {
    "id": "abc1234567890abcdef1234567890abcdef12345",
    "mimeType": "image/png",
    "dataURL": "data:image/png;base64,iVBORw0KGgoAAAANSUhE...",
    "created": 1700000000000,
    "lastRetrieved": 1700000000000
  }
}
```

- The map's key must equal the inner `id` field.
- `dataURL` is a full data URL, not just the base64 payload. Excalidraw checks the prefix to decide MIME handling.
- `created` and `lastRetrieved` are millisecond timestamps. They aren't strictly required for import to succeed, but Excalidraw uses them internally for caching; emit them as `Date.now()`.

When the same fileId appears multiple times in the elements array (e.g. you reuse an icon across the diagram), only one entry exists in `files`. That's the dedup win from content-addressed fileIds.

## Layout heuristics for hero-illustration diagrams

The trap with image-heavy diagrams is that illustrations feel like they should "fill the canvas" — which usually means too-large images, no breathing room, and crowded labels. These are the rules of thumb that produce diagrams that read at a glance:

### 1. Fixed image size across the whole diagram

Pick one width × height for *every* segment illustration. Variation in image size signals "different importance" — and unless one segment really is more important, that signal is misleading.

- Sketches at 1:1 → **320×320**
- Watercolor at 4:3 → **400×300**
- Isometric at 1:1 → **360×360**

### 2. Generous gaps between images

Inter-image gap should be ≈ 30–40% of the image's width. For 320px illustrations, leave **120px of horizontal whitespace** between them (so an arrow has room to breathe and connect them).

For grid layouts, vertical row gap should be ≈ 50% of image height (so labels under one row don't crowd the next row).

### 3. Labels live directly under their image

A short title (3–6 words) centered ≈ 16px below the image. Font size around 18–20pt. Same color across all labels (use the palette's `text` or `primary` value for high contrast).

If the title is longer than 6 words, split into two lines or shorten — long labels make the diagram feel cramped and reduce scan-ability.

### 4. Arrows enter and exit images at their midpoints

For a left-to-right linear flow with images centered at y = `cy`:
- Arrow source: `(image_n.x + image_n.width, cy)` — right edge midpoint
- Arrow target: `(image_n+1.x, cy)` — left edge midpoint

For circular layouts, arrows follow the tangent of the circle. Use 3-point curved arrows (`points: [[0,0], [mx, my], [tx, ty]]` where `(mx, my)` is offset toward the circle's center) so they don't cut straight across the middle.

### 5. Title at the top, optional caption at the bottom

Single title text element, centered above the leftmost image's `y`, font size 28–36pt. Use the palette `primary` color.

Optional caption / source / date below the bottommost element, smaller (14–16pt), muted color.

### 6. Avoid a "framing" rectangle around everything

Resist the urge to wrap all the illustrations in one big rectangle. The whitespace between elements is the frame; an explicit rectangle makes the diagram feel like a slide deck.

The exception: if the diagram has multiple distinct phases ("intake" vs. "scoring" vs. "verdict"), grouping each phase's illustrations in a rounded rectangle with a small label in the corner reads as deliberate sectioning rather than over-framing.

## Common gotchas

- **Forgetting the `files` map** — image elements with valid `fileId`s but no entries in `files` show as broken icons in Excalidraw.
- **Using just the base64 payload, not a data URL** — Excalidraw rejects this silently. Always include the `data:image/...;base64,` prefix.
- **Emitting absolute file paths in `image_path`** — only matters for the agent's spec.json, not for the final `.excalidraw`. The composer reads the path, embeds the bytes, and discards the path.
- **Mixing fileIds for identical content** — if you generate the same image twice and assign different fileIds, Excalidraw stores both copies. SHA-1-of-content-as-fileId fixes this; the composer does it automatically.
- **Non-PNG images** — Excalidraw also accepts `image/jpeg` and `image/gif`. The composer detects MIME via filename extension. PNG is the safe default.
