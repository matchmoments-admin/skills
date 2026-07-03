---
name: slide-deck
description: Create stunning, animation-rich, zero-dependency HTML presentations from scratch or by converting PowerPoint files. Use when the user wants to build a presentation, slide deck, pitch deck, talk, or convert a PPT/PPTX to web. Helps non-designers discover their aesthetic through visual exploration ("show, don't tell") rather than abstract choices. Ships 12 curated style presets plus an Ask Arthur brand preset.
---

# Slide Deck

Create zero-dependency, animation-rich HTML presentations that run entirely in the browser.

Vendored and adapted from [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT). This local copy is trimmed to the core system (no 34-template "bold pack") and adds an **Ask Arthur** brand preset. Supporting files live under `slide-deck/`.

## Core Principles

1. **Zero Dependencies** — Single HTML files with inline CSS/JS. No npm, no build tools.
2. **Show, Don't Tell** — Generate visual previews, not abstract choices. People discover what they want by seeing it.
3. **Distinctive Design** — No generic "AI slop." Every presentation must feel custom-crafted.
4. **Progressive Disclosure** — Read the lightweight style index first. Load a preset's full details only when it's a live candidate.
5. **Fixed 16:9 Stage (NON-NEGOTIABLE)** — Every deck uses a 1920×1080 slide canvas scaled as a whole to the viewport. Slides must stay 16:9 on every screen, including phones. Do not reflow slide content to fit the device.

## Design Aesthetics

You tend to converge toward generic, "on distribution" outputs. In frontend design, this creates what users call the "AI slop" aesthetic. Avoid this: make creative, distinctive frontends that surprise and delight.

Focus on:

- Typography: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the aesthetics.
- Color & Theme: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Draw from IDE themes and cultural aesthetics for inspiration.
- Motion: Use animations for effects and micro-interactions. Prioritize CSS-only solutions. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions.
- Backgrounds: Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic.

Avoid generic AI-generated aesthetics:

- Overused font families (Inter, Roboto, Arial, system fonts)
- Cliched color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character

Interpret creatively and make unexpected choices that feel genuinely designed for the context. Vary between light and dark themes, different fonts, different aesthetics. You still tend to converge on common choices (Space Grotesk, for example) across generations. Avoid this: it is critical that you think outside the box!

## Fixed Stage Rules

These invariants apply to EVERY slide in EVERY presentation:

- Every deck has a viewport wrapper that fills the browser window.
- Every slide is authored inside a fixed 1920×1080 stage.
- The stage scales uniformly to fit the viewport. It may letterbox/pillarbox; it must not re-layout content.
- Do not use responsive breakpoints to rearrange slide content for phones.
- Use fixed internal slide measurements at the 1920×1080 design size.
- Slide visibility must be controlled by `.active` / `.visible` using `visibility`, `opacity`, and `pointer-events` from `slide-deck/viewport-base.css`. Do not use `display: none` / `display: block` for slide switching; later layout classes such as `.slide-content { display: flex; }` can override them and make every slide visible at once.
- Use `clamp()` only for non-slide UI outside the stage, or for small fallback previews where a full stage is impractical.
- Include `prefers-reduced-motion` support.
- Never negate CSS functions directly (`-clamp()`, `-min()`, `-max()` are silently ignored) — use `calc(-1 * clamp(...))` instead.

**When generating, read `slide-deck/viewport-base.css` and include its full contents in every presentation.**

### Content Density Modes

Ask the user whether this is primarily a reading deck or a speaking deck, then design around that answer:

| Density mode | Best for | Design behavior |
| ------------- | -------- | --------------- |
| **Low density / speaker-led** | Public talks, keynote-style sharing, live explanation | One idea per slide, large type, strong visual hierarchy, generous negative space, 1-3 bullets max, more slides if needed |
| **High density / reading-first** | Reports, handouts, async review, detailed internal docs | More self-contained slides, structured grids/tables/annotations, 4-8 bullets or 4-6 cards when readable, tighter but still intentional spacing |

Baseline limits still apply: no scrolling, no overflow, no overlapping panels, and no text below comfortable reading size. If content exceeds the selected density mode, split it into more slides instead of shrinking until it becomes cramped.

---

## Phase 0: Detect Mode

Determine what the user wants:

- **Mode A: New Presentation** — Create from scratch. Go to Phase 1.
- **Mode B: PPT Conversion** — Convert a .pptx file. Go to Phase 4.
- **Mode C: Enhancement** — Improve an existing HTML presentation. Read it, understand it, enhance. **Follow Mode C modification rules below.**

### Mode C: Modification Rules

When enhancing existing presentations, fixed-stage fitting is the biggest risk:

1. **Before adding content:** Count existing elements, check against density limits.
2. **Adding images:** Fit them inside the 1920×1080 slide canvas. If the slide already has max content, split into two slides.
3. **Adding text:** Max 4-6 bullets per slide. Exceeds limits? Split into continuation slides.
4. **After ANY modification, verify:** the slide stage remains 16:9, no text overflows its card, no panels overlap, and screenshots look correct at 1280×720 plus one phone viewport.
5. **Proactively reorganize:** If modifications will cause overflow, automatically split content and inform the user. Don't wait to be asked.

**When adding images to existing slides:** Move the image to a new slide or reduce other content first. Never add images without checking if existing content already fills the 1920×1080 slide stage.

---

## Phase 1: Content Discovery (New Presentations)

**Ask ALL questions together** so the user fills everything out at once. If the current environment provides a native structured-question UI, use it; otherwise ask in one concise message with clearly numbered choices:

**Question 1 — Purpose:** What is this presentation for? Options: Pitch deck / Teaching-Tutorial / Conference talk / Internal presentation

**Question 2 — Length:** Approximately how many slides? Options: Short 5-10 / Medium 10-20 / Long 20+

**Question 3 — Content:** Do you have content ready? Options: All content ready / Rough notes / Topic only

**Question 4 — Density:** How dense should the deck feel? Options:

- "Low density / speaker-led" — Big ideas, fewer words, more visual breathing room
- "High density / reading-first" — More self-contained detail for async reading

**Do not ask about inline editing during Phase 1.** Inline editing is a post-draft affordance: include it by default unless the user explicitly asks for a locked/export-only file.

Remember the user's density choice. It affects slide count, typography scale, amount of text per slide, layout density, and whether to favor cinematic presenter slides or self-contained reading slides.

If the user has content, ask them to share it.

### Step 1.2: Image Evaluation (if images provided)

If the user selected "No images" → skip to Phase 2.

If the user provides an image folder:

1. **Scan** — List all image files (.png, .jpg, .svg, .webp, etc.).
2. **Inspect each image** — Use the agent's image-understanding capability. If unavailable, use filenames/metadata and ask the user to clarify only when needed.
3. **Evaluate** — For each: what it shows, USABLE or NOT USABLE (with reason), what concept it represents, dominant colors.
4. **Co-design the outline** — Curated images inform slide structure alongside text. Design around both from the start.
5. **Confirm the outline** using the structured-question mechanism: "Does this slide outline and image selection look right?" Options: Looks good / Adjust images / Adjust outline.

**Logo in previews:** If a usable logo was identified, embed it (base64) into each style preview in Phase 2 — the user sees their brand styled multiple ways.

---

## Phase 2: Style Discovery

**This is the "show, don't tell" phase.** Most people can't articulate design preferences in words.

### Step 2.0: Generate 3 Style Previews Directly

Based on purpose, audience, mood, and content density, generate 3 distinct single-slide HTML previews showing typography, colors, animation, and overall aesthetic.

Do not ask the user whether they want options or a preset picker. The default discovery experience is always visual comparison.

If the user already gave a vibe, use it. If they did not, infer the likely mood from the occasion, audience, content, and stakes. Keep the options diverse enough that the user can react visually instead of needing to articulate taste up front.

If the user explicitly names a preset (including **Ask Arthur**), honor that as one option and generate the remaining preview slots around it.

Read [slide-deck/STYLE_PRESETS.md](slide-deck/STYLE_PRESETS.md) for preset candidates.

| Mood                | Suggested Presets                                  |
| ------------------- | -------------------------------------------------- |
| Impressed/Confident | Bold Signal, Electric Studio, Dark Botanical, Ask Arthur |
| Excited/Energized   | Creative Voltage, Neon Cyber, Split Pastel         |
| Calm/Focused        | Notebook Tabs, Paper & Ink, Swiss Modern           |
| Inspired/Moved      | Dark Botanical, Vintage Editorial, Pastel Geometry |
| Trustworthy/Sovereign | Ask Arthur, Swiss Modern, Electric Studio        |

**Preview mix rules:**

- Generate 3 previews by default: 1 safe preset from `STYLE_PRESETS.md`, 1 bolder/expressive preset, and 1 wildcard (a self-generated custom design).
- The wildcard should create the strongest, most useful contrast for the user's occasion, audience, mood, and content.
- If the brief has a sharper, more specific design opportunity than any preset, use the wildcard slot to design freely.
- For conservative or high-stakes decks, make the safe preset especially restrained; make the wildcard authoritative rather than decorative.
- For expressive decks, keep the safe preset as a readable fallback and make the wildcard adventurous and context-specific.

**Custom wildcard design rules:**

- Follow the Design Aesthetics section above: no generic "AI slop", no default font/color/layout choices, no purple-gradient-on-white clichés, no cookie-cutter dashboard/card look.
- Match the user's stated occasion, audience, mood/vibe, and content density. The custom design should feel authored for this deck, not merely "stylish."
- Make a deliberate visual thesis: distinctive typography, a committed palette, a recognizable layout system, and one strong atmospheric or graphic device.
- Keep it feasible for a full deck. The preview must imply a design system that can expand into section, content, quote, comparison, and closing slides.
- Use fixed 1920×1080 stage rules and pass the same preview authenticity checks as every other option.
- Never render "custom", "wildcard", "AI-generated", or design-process labels on the slide itself.

**Preview authenticity rules (NON-NEGOTIABLE):**

- Every style preview must look like a real first slide from the user's deck, not a diagnostic card.
- Never render internal workflow text on a slide: no `preview`, `generated from`, `template`, `preset`, `style option`, `Option A/B/C`, file names, paths, or source-doc labels.
- Never render preset/slug names on the slide itself. Style names belong only in the message to the user.
- Never render user requirement notes as slide content ("safe option", "bold option", "audience: ...") unless the user explicitly wants that exact phrase in the deck.
- If the slide needs chrome, use real deck chrome only: the deck title, section title, date, author, company, page number, or a genuine content phrase from the user's material.
- Before opening previews, inspect the visible text and revise if any internal metadata appears.

Save previews to `.slide-deck/slide-previews/` (style-a.html, style-b.html, style-c.html). Each should be self-contained and compact, showing one animated title slide. Open each preview automatically for the user.

### Step 2.1: User Picks

Ask (header: "Style"): Which style preview do you prefer? Options: Style A: [Name] / Style B: [Name] / Style C: [Name] / Mix elements

If "Mix elements", ask for specifics.

---

## Phase 3: Generate Presentation

Generate the full presentation using content from Phase 1 (text, or text + curated images) and style from Phase 2.

If images were provided, the slide outline already incorporates them from Step 1.2. If not, CSS-generated visuals (gradients, shapes, patterns) provide visual interest — this is a fully supported first-class path.

Apply the user's density choice throughout the deck:

- **Low density / speaker-led:** Use more slides with fewer ideas per slide. Favor large headings, short phrases, visual metaphors, section beats, quote/statement slides, and presenter-friendly pacing.
- **High density / reading-first:** Make slides more self-contained. Use structured grids, comparison tables, annotated diagrams, captions, and concise explanatory copy. Keep hierarchy strong so it feels designed, not like a document pasted onto slides.

If the user's stated needs are mixed, choose the closer of the two modes instead of inventing a middle option: live audience persuasion defaults low-density; async circulation or detailed review defaults high-density. Never let high density become visual clutter — if a slide starts to overflow, split it.

If the user selected a **preset** (including Ask Arthur), read its full entry in `slide-deck/STYLE_PRESETS.md` and treat it as the design recipe: preserve its fonts, palette, decorative vocabulary, spacing rhythm, and component grammar across every slide.

If the user selected a **self-generated custom wildcard**, treat that preview's CSS and layout as the design recipe: preserve its fonts, palette, decorative vocabulary, spacing rhythm, grid logic, and component grammar, and expand the same visual system across the full deck. Do not switch to a preset after the user picked the custom direction. Design any missing slide layouts from that system rather than importing patterns from another style.

**Before generating, read these supporting files:**

- [slide-deck/html-template.md](slide-deck/html-template.md) — HTML architecture and JS features
- [slide-deck/viewport-base.css](slide-deck/viewport-base.css) — Mandatory CSS (include in full)
- [slide-deck/animation-patterns.md](slide-deck/animation-patterns.md) — Animation reference for the chosen feeling

**Key requirements:**

- Single self-contained HTML file, all CSS/JS inline.
- Include the FULL contents of `viewport-base.css` in the `<style>` block.
- Use fonts from Fontshare or Google Fonts — never system fonts.
- Add detailed comments explaining each section. Every section needs a clear `/* === SECTION NAME === */` comment block.
- After generating, verify both content overflow and panel overlap in rendered browser screenshots. `scrollHeight` checks alone are not enough because grid panels can visually cover each other.

---

## Phase 4: PPT Conversion

When converting PowerPoint files:

1. **Extract content** — Run `python slide-deck/scripts/extract-pptx.py <input.pptx> <output_dir>` (install python-pptx if needed: `pip install python-pptx`).
2. **Confirm with user** — Present extracted slide titles, content summaries, and image counts.
3. **Style selection** — Proceed to Phase 2 for style discovery.
4. **Generate HTML** — Convert to the chosen style, preserving all text, images (from assets/), slide order, and speaker notes (as HTML comments).

---

## Phase 5: Delivery

1. **Clean up** — Delete `.slide-deck/slide-previews/` if it exists.
2. **Open** — Use `open [filename].html` to launch in the browser.
3. **Summarize** — Tell the user:
   - File location, style name, slide count.
   - Navigation: Arrow keys, Space, swipe/tap if enabled.
   - How to customize: `:root` CSS variables for colors, the font link for typography, the `.reveal` class for animations.
   - Inline text editing is available: hover the top-left corner or press E to enter edit mode, click any text to edit, Ctrl+S to save.
   - Offer the natural post-draft actions: ask for revisions, edit text directly in the browser, or export/share.

---

## Phase 6: Share & Export (Optional)

After delivery, **ask the user:** _"Would you like to share this presentation? I can deploy it to a live URL (works on any device including phones) or export it as a PDF."_

Options: Deploy to URL / Export to PDF / Both / No thanks. If the user declines, stop here.

### 6A: Deploy to a Live URL (Vercel)

1. Check the Vercel CLI: `npx vercel --version` (install Node.js first if missing).
2. Check login: `npx vercel whoami`. If not logged in, guide the user through `vercel login` (opens a browser to authorize) and confirm with `vercel whoami`.
3. Deploy: `bash slide-deck/scripts/deploy.sh <path-to-presentation>` (accepts a folder with index.html or a single HTML file).
4. Share the URL from the script output. Redeploying the same presentation overwrites the previous deployment and keeps the same URL.

**⚠ Gotchas:** Local images/videos must travel with the HTML — prefer folder deployments when a deck has many assets. Avoid spaces in image filenames. Verify all images load on the deployed URL.

### 6B: Export to PDF

1. Run: `bash slide-deck/scripts/export-pdf.sh <path-to-html> [output.pdf]` (needs Playwright; installs automatically if missing).
2. Animations are replaced by their final visual state — the PDF is a static snapshot. Mention this to the user.
3. Slides must use `class="slide"` (the export script queries `.slide`). Local images must be relative paths, not absolute filesystem paths.
4. If the PDF exceeds 10MB, offer `--compact` (renders at 1280×720, cutting size 50-70%): `bash slide-deck/scripts/export-pdf.sh <path-to-html> [output.pdf] --compact`.

---

## Supporting Files

| File                                               | Purpose                                                              | When to Read              |
| -------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| [slide-deck/STYLE_PRESETS.md](slide-deck/STYLE_PRESETS.md)         | 12 curated presets + Ask Arthur brand preset (colors, fonts, signatures) | Phase 2 (style selection) |
| [slide-deck/viewport-base.css](slide-deck/viewport-base.css)       | Mandatory fixed-stage CSS — copy into every presentation             | Phase 3 (generation)      |
| [slide-deck/html-template.md](slide-deck/html-template.md)         | HTML structure, JS features, inline-editing, code quality standards  | Phase 3 (generation)      |
| [slide-deck/animation-patterns.md](slide-deck/animation-patterns.md) | CSS/JS animation snippets and effect-to-feeling guide             | Phase 3 (generation)      |
| [slide-deck/scripts/extract-pptx.py](slide-deck/scripts/extract-pptx.py) | Python script for PPT content extraction                     | Phase 4 (conversion)      |
| [slide-deck/scripts/deploy.sh](slide-deck/scripts/deploy.sh)       | Deploy slides to Vercel for instant sharing                          | Phase 6 (sharing)         |
| [slide-deck/scripts/export-pdf.sh](slide-deck/scripts/export-pdf.sh) | Export slides to PDF                                              | Phase 6 (sharing)         |
