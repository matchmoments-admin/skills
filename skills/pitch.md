---
name: pitch
description: Generate or refresh the concise Ask Arthur platform pitch — a short (~7 slide) intelligence-briefing deck in the "Signal" editorial style (from frontend-slides). Use when the user wants "the pitch", a brief/short Ask Arthur deck, a one-sitting investor/partner brief, or a concise companion to the full overview deck. Ask-Arthur-specific: content lives in pitch/content.md, style in pitch/signal-design.md, and a built reference in pitch/example.html.
---

# /pitch — Ask Arthur concise pitch

A short, punchy Ask Arthur platform brief (~7 slides) rendered in **Signal** —
a literary intelligence-briefing style from the `frontend-slides`
bold-template-pack (MIT). Where the full overview deck
(`apps/web/public/overview.html`, built with `/slide-deck` in Swiss-Modern-navy)
exhausts the story across 14 slides, `/pitch` is the version you can walk a
regulator, investor or partner through in one sitting.

This is the deliberate contrast: the overview is *comprehensive*; the pitch is
*quotable*. Same platform, same facts, far fewer words.

## When to use

- "make/refresh the pitch", "a short Ask Arthur deck", "the brief version", a one-sitting investor/partner walk-through.
- After a material platform change (new stat, new milestone), to re-cut the brief from current facts.

For a **from-scratch deck in any style**, or a *different* company/topic, use
`/slide-deck` instead — that's the general 12-preset generator. `/pitch` is
purpose-built for the Ask Arthur brief in one fixed style.

## Inputs

- **Facts + narrative:** always read [pitch/content.md](pitch/content.md) first. It is the single source of truth for the numbers and the 7-slide outline. If the user gives updated facts, update `content.md` *and* the deck.
- **Design system:** [pitch/signal-design.md](pitch/signal-design.md) — the full Signal spec. The signature treatments below are non-negotiable.
- **Reference build:** [pitch/example.html](pitch/example.html) — the current canonical output. In refresh mode, edit from this rather than starting blank.

## Output

A single self-contained HTML file on a fixed 1920×1080 stage scaled uniformly
to the viewport (letterbox/pillarbox — never reflow). Default write target is
the Ask Arthur repo's `apps/web/public/pitch.html`; otherwise ask the user
where to write it. Keep `pitch/example.html` in this skill updated to match.

## Workflow

1. **Read** `pitch/content.md` (facts + outline) and, unless the user asked for
   a different style, `pitch/signal-design.md`. In refresh mode also open the
   current `example.html` / target file.
2. **Confirm scope** in one message: default 7 slides, Signal style, write to
   `apps/web/public/pitch.html`. Only ask if the user wants to change length,
   style, target, or specific facts. Don't run a long Q&A — this is a fast re-cut.
3. **Verify facts.** If any number in `content.md` looks stale, flag it and ask
   rather than shipping an out-of-date figure. Never invent metrics.
4. **Generate** the deck applying the Signal treatments below. Keep one idea per
   slide; if a slide crowds, cut copy — do not shrink type or add a slide beyond
   the agreed length without saying so.
5. **Verify render**: open it, check all slides hold 16:9, no overflow, no panel
   overlap, the gold-italic `<em>` appears in every headline, stats are gold
   serif. Fix and re-check.
6. **Deliver**: report file path + slide count; note navigation (←/→, click,
   swipe) and that print/PDF yields one slide per page. Offer to ship it (the
   Ask Arthur repo's standard: branch off `main` → commit → PR → Vercel green →
   squash-merge; `/pitch.html` is a static `noindex` asset, no schema).

## Signal treatments — non-negotiable

Reproduce these exactly (full detail in `pitch/signal-design.md`):

- **The Signal moment:** every serif headline mixes roman + one `<em>` phrase in
  **italic Source Serif 4, antique gold (#C8A870)**, mid-sentence. A headline
  with no gold-italic emphasis reads as a different system — give each one a
  deliberate emphasis word (…*start.* / …*born.* / …*smarter.* / …*not a prototype.*).
- **Font ladder:** Source Serif 4 = headlines/stats (voice); DM Sans = body/lead
  (substance); IBM Plex Mono = every kicker, chrome, label, counter (metadata).
  Never cross the rails (no serif body, no sans headline, no mono in body).
- **One accent only — antique gold (#C8A870)** — on rules, italic headline
  emphasis, and numerals. Never a background fill, never on body text. No second accent.
- **Dual surface:** deep editorial **navy #1C2644** and warm **cream #F0ECE3**,
  alternating; primary text is warm off-white `#E2DCD0` on navy (never pure white),
  near-black `#1A2030` on cream.
- **Kicker = mono uppercase gold, ≥0.14em tracking, with a 36px gold rule** above the headline.
- **Stats = Source Serif 4 600 in gold, -0.02em** tracking. Always gold serif.
- **Flat + hairline:** 1px borders (`#2E3D5C` navy / `#CAC4B4` cream) separate
  regions. No shadows, no rounded corners (radius 0), no card chrome.
- **80px grid texture** at 3% white on every dark slide (`::before`); cream slides omit it.
- **Em-dash bullets** in mono gold — no dot bullets.
- **Chrome:** standard slides carry a top chrome bar (mono label left, counter
  right, hairline beneath) and a mirrored foot bar. Cover, the "moat" statement,
  and the closing CTA are **chromeless** — let the type breathe.
- **Restraint:** never fill more than ~half a slide; Signal reads as broken when crowded.

## Notes

- Vendored from the MIT-licensed [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides) "Signal" template; `signal-design.md` is that template's design doc verbatim.
- Complements `/slide-deck` (general generator) and the Ask Arthur brand preset it ships.
