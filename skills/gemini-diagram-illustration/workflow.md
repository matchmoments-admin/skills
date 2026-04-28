# Detailed pipeline — gemini-diagram-illustration

This is the agent-facing manual. Read it once at the start of a run; refer back when transitioning between stages.

---

## Stage 1 — Initialize

**Goal:** know exactly what you're illustrating, where the output goes, and which style template to use.

1. **Resolve the source.**
   - If `--source <path>` was given, read it.
   - Else if `--source-dir <dir>` was given, list `*.md` and `*.mdx` files under that dir, sort by modification time, pick the newest. Read it.
   - Else default `--source-dir` to the current working directory and apply the same auto-discovery. If nothing matches, treat the user's free-form first arg as the topic and proceed without source content.
   - Print the chosen source path to the user (one line).

2. **Resolve the style template.**
   - Read `~/.claude/skills/gemini-diagram-illustration/image_prompt_templates.json`.
   - Pick the template named by `--style` (default `sketch`). Load its `prompt_suffix`, `aspect_ratio`, `image_size`, `negative_terms`.
   - If `--style` doesn't match any template, list available names and abort.

3. **Resolve the output path.**
   - If `--output` was given, use it (resolve to absolute).
   - Else default to `<cwd>/diagrams/<kebab-slug-of-source-or-topic>.excalidraw`.
   - Create the parent directory if needed (`mkdir -p`).
   - If a file already exists at the path: in `--mode collab`, ask before overwriting; in `--mode auto`, append a `-N` suffix until a free name is found.

4. **Pick a temp dir for PNGs.**
   - `<output-parent>/.<basename>-pngs/` works (hidden subdir next to the output). Or `mktemp -d` if `--keep-pngs` is unset.
   - Note: in collab mode, surface this path so the user knows where intermediate files live.

5. **Read `excalidraw_format.md`.** You'll need its layout heuristics in stage 4. Reading it now gives you the schema fresh in mind for stage 2's segment count decisions.

End of stage 1: print a one-line summary — "Source: X | Style: Y | Output: Z | N segments TBD".

---

## Stage 2 — Plan

**Goal:** segment the content into 3–7 visual beats, draft an illustration prompt for each.

1. **Read the source content** (already done in stage 1).

2. **Decide segment count.**
   - 3 segments → very short content (a tweet-thread, a single concept).
   - 4–5 segments → typical blog post or 3-minute explainer.
   - 6–7 segments → longer post or technical deep-dive.
   - Cap at 7. More than that and the diagram becomes scrollable, which defeats "scannable in one glance."
   - If `--segments <n>` was passed, use that.

3. **Identify the visual beats.**
   - For each beat, write down:
     - **Title** (3–6 words, will become a label under the illustration)
     - **Subject** (the *thing* being illustrated — a person doing X, an object representing Y, a moment of transformation)
     - **Composition note** (what's in frame — usually a single subject, centered, with visual language that matches the title)
   - Beats should be *narratively connected*. Beat N's output is beat N+1's input. If you can't draw an arrow from beat N to beat N+1 with a 1–3 word label, you've got two unrelated diagrams, not one.

4. **Draft the illustration prompt for each beat.**
   - Format: `<subject>. <composition note>. <style suffix from template>.`
   - Example (sketch style):
     > "A worried-looking person staring at a phone showing a suspicious SMS. Single figure, centered, clear silhouette. Hand-drawn sketch in black ink on cream paper. Loose, confident linework with cross-hatching for shadows. Naive perspective, slightly wonky lines, like a pencil-and-pen note in a notebook. White or cream background. No color other than ink and paper."
   - Each prompt should specify a **single subject** — multi-subject prompts produce muddled illustrations. If a beat is "user sends content + system receives it", split into two beats.

5. **Decide layout.**
   - Default `linear-flow`: row of illustrations left-to-right with arrows between them.
   - `circular`: 4–6 illustrations around a circle, arrows tracing the cycle.
   - `grid`: 4 or 6 illustrations in a 2×2 or 2×3 grid (use when the beats *don't* have linear sequence — e.g. four characteristics of a thing).
   - `two-column`: pairs of illustrations on left vs right (use for comparisons — before/after, our-way/their-way).

6. **In `--mode collab`, pause here.** Print a numbered list:
   ```
   Plan (linear-flow, 5 segments):
     1. "User receives suspicious SMS"        — prompt: "A worried-looking person staring..."
     2. "User submits to Ask Arthur"          — prompt: "A hand pressing a 'submit' button..."
     3. "Claude analyses the content"         — prompt: "A magnifying glass over text..."
     4. "Threat feeds confirm verdict"        — prompt: "Stack of folders feeding..."
     5. "User sees HIGH RISK badge"           — prompt: "A phone screen with a red shield..."

   Generate 5 illustrations? (y / edit / abort)
   ```
   Wait for the user. If they say "edit", capture their changes (drop a beat, swap a prompt, change layout) and re-print the plan.

   In `--mode auto`, skip the pause and proceed.

End of stage 2: you have a list of `(title, prompt)` pairs and a layout name.

---

## Stage 3 — Illustrate (the parallel call)

**Goal:** generate every illustration in roughly the time of one slow call.

1. **Issue all Gemini calls in a single message.**
   - In Claude Code, multiple `mcp__gemini__gemini-generate-image` calls in one assistant turn run in parallel.
   - For N segments, your message should contain N tool calls, one per prompt.
   - Common parameters for every call (from the style template):
     - `prompt`: the per-beat prompt (subject + composition + style suffix)
     - `aspectRatio`: from template (e.g. `"1:1"` for sketches)
     - `imageSize`: from template (e.g. `"1K"` — sketches don't need 2K)
   - Optional per-call: pass an `outputPath` if the MCP tool supports it; otherwise capture the returned image bytes/path from each tool result.

2. **Save each PNG with a stable name.**
   - `<temp-dir>/segment-1.png`, `segment-2.png`, … so the order matches the segment order.
   - If the MCP tool returns a temp path, copy/move to your stable name.

3. **In `--mode collab`, after all generations return:** offer a quick visual check.
   - Print: "5 illustrations saved to <temp-dir>. Inspect them now? (y / regenerate <indices> / proceed)"
   - "regenerate 2 4" → re-issue Gemini calls *only* for those segments, replace the PNGs, re-prompt.

4. **Failure handling.**
   - If 1+ calls fail: don't abort the whole pipeline. Note the failures and ask (collab) or auto-retry once (auto). After a single retry, if still failing, drop the affected segments and continue with what worked.
   - Common Gemini failures: content-policy refusals (rephrase the prompt — usually a single noun is the trigger), rate limits (back off and retry once).

End of stage 3: a temp dir of `segment-N.png` files, one per beat.

---

## Stage 4 — Compose

**Goal:** turn the PNGs into a single `.excalidraw` file with embedded base64 images, plus arrows and labels.

1. **Decide coordinates.**
   - Read `excalidraw_format.md` for the image-element schema and layout heuristics.
   - Pick a base size for each illustration: **320×320** for sketches/flat at 1:1; **400×300** for 4:3 watercolor heroes.
   - Lay out per the layout name:
     - `linear-flow`: y constant, x = `100 + i * (img_w + gap)`, gap = 120.
     - `two-column`: pairs of (left, right) at x_left = 100, x_right = 100 + img_w + 200. Each pair y = i * (img_h + 200).
     - `grid`: 2 columns or 3 columns; row height = img_h + 100.
     - `circular`: place on a circle of radius `R = max(img_w, img_h) * 1.3` centred at (R+100, R+100). Beat i at angle `(2π/N) * i - π/2`.

2. **Write a spec file.**
   - JSON format consumed by `compose_excalidraw.py`. Place it at `<temp-dir>/spec.json`. Schema:
     ```json
     {
       "output": "<absolute output path>",
       "background": "#ffffff",
       "title": "How Ask Arthur classifies a scam",
       "elements": [
         {
           "kind": "image",
           "id": "seg-1",
           "image_path": "<temp>/segment-1.png",
           "x": 100, "y": 100, "width": 320, "height": 320,
           "label": "User receives SMS"
         },
         {
           "kind": "arrow",
           "from": [420, 260], "to": [540, 260],
           "label": "submit"
         },
         {
           "kind": "text",
           "x": 100, "y": 60,
           "text": "Step 1: Intake",
           "fontSize": 24, "color": "#001f3f"
         }
       ]
     }
     ```
   - `kind: image` is the most common — one per segment. The composer creates the image element, hashes the PNG content into a `fileId`, base64-encodes the PNG, adds it to the `files` map. If `label` is set, it auto-creates a centered text element directly below.
   - `kind: arrow` joins two coordinates. If `label` is set, a small text element appears near the arrow's midpoint.
   - `kind: text` is free-floating text — title, sub-headers, captions.
   - All coordinates are scene-space; the composer doesn't transform them.

3. **In `--mode collab`, before running the composer:** show the user the spec summary (number of images, arrows, texts, output path) and confirm. They can request layout tweaks ("move segment 3 down", "add an arrow from 2 to 4 labelled 'fallback'"), which you apply by editing the spec.

4. **Run the composer.**
   ```bash
   python3 ~/.claude/skills/gemini-diagram-illustration/compose_excalidraw.py <temp-dir>/spec.json
   ```
   It writes the `.excalidraw` to the path in `spec.output` and prints that path on stdout.

5. **(Optional) sanity-render** with the other skill's renderer:
   ```bash
   python3 ~/.claude/skills/excalidraw-diagram/render_diagram.py <output>.excalidraw
   ```
   Image elements show as labeled placeholder rectangles in the preview (the renderer doesn't decode embedded images, by design — that's slow and not necessary for layout validation). This catches arrow misalignment, text overlap, off-canvas positioning before the user opens the real file.

End of stage 4: a `.excalidraw` file at the configured path.

---

## Stage 5 — Export & polish

1. **Clean up the temp dir** unless `--keep-pngs` was passed. If kept, print where they are.
2. **Print the final summary**:
   ```
   ✓ Wrote <output>.excalidraw
     ↳ <N> illustrations, <M> arrows, layout: <layout>
     ↳ Open at https://excalidraw.com (drag-and-drop) or in Obsidian Excalidraw plugin
   ```
3. **In `--mode collab`**, ask: "Open it now? (y / no)" — if yes, run `open <output>.excalidraw` (macOS).

End of pipeline.

---

## Common adjustments after the first run

The first pass is usually 80% there. Typical follow-ups, in priority order:

- **A specific illustration is off** — the agent should rerun *just that segment* via stage 3's regenerate path, not redo the whole pipeline.
- **Style drift across illustrations** — different beats have visibly different aesthetics. Cause: the per-beat prompts varied in *how much* style detail they included. Fix: pin the style suffix verbatim, only the subject changes per beat.
- **Layout feels cramped** — increase the gap between images (rerun stage 4 only, no new Gemini calls).
- **Arrows miss their targets** — adjust `from`/`to` coords in the spec (rerun stage 4 only).
- **Wrong story** — segments don't match the post's actual narrative. Rebuild from stage 2.

The cost asymmetry matters: stage 3 (Gemini calls) is the only stage that costs money. Re-running stages 4 and 5 is free. Optimize for "stage 3 happens once" by getting the plan right before issuing image calls.

---

## When NOT to use this skill

- You only need 1–2 illustrations (just call `/gemini-generate-illustration` directly per image).
- The diagram is purely structural (architecture, comparison) — `excalidraw-diagram` is faster and free.
- The post will be heavily edited still — premature illustration work gets thrown away. Wait until the draft is stable.
