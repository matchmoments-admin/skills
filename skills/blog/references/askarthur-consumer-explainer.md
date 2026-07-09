# AskArthur consumer explainer — gold-standard structural reference

The shape that consistently lands for AskArthur consumer-facing explainers: short, scannable, three callouts, hr between sections, bold-lead bullets. Use this when writing for the donor / phone owner / SMS recipient — not for engineering deep-dives, regulatory analyses, or B2B content (those go through `askarthur-house`).

**Reference exemplar**: `/blog/2026-04-22-sim-swap-sos-only` — *"When your phone drops to SOS only"*. ~1,200 words, 7,209 chars in DB, 7-minute read.

## Length envelope

- **Total body content** (the `blog_posts.content` column, _excluding_ H1 title and hero image which live in their own columns): **6,500 – 8,500 chars / 1,000 – 1,300 words**.
- **Reading time**: 6–8 minutes. Anything over 10 needs to be split into a series, an FAQ, or a deep-dive in a different voice.
- Charity-check launch (`/blog/charity-check-australian-charity-30-seconds`) sits at the top of this range at 7,940 chars after rewriting from an over-long 18,218-char first draft.

## Section rhythm

```
[2–4 short opening paragraphs setting the scene — no H2]
---
## What's actually happening / Why it matters       (with [!DANGER] callout)
---
## Why it's getting worse / The four [things]        (with [!WARNING] callout)
---
## Bust a myth / What attackers DON'T get / etc.
---
## What to do / The first 10 minutes                 (with [!TIP] callout)
---
## A checklist / a walk-through
---
## What's coming next / What we deliberately don't
---
## The bottom line                                    (1–2 short paragraphs)
---
*italic disclaimer with helpline numbers + sign-off*
```

**Six to seven H2 sections is the sweet spot.** Each separated by `---`. Each section is short — typically two paragraphs of prose plus one bullet list, sometimes with a callout.

## Callouts

Three callouts per post — one of each colour, in this order:

1. **`> [!DANGER]`** in the early "what's happening" or "why it matters" section. Carries the headline statistic, the regulator-confirmed loss figure, the named-incident dollar amount.
2. **`> [!WARNING]`** mid-post. Carries the regulatory enforcement line, the second cluster of evidence, or the override rule ("if any of these are true, stop").
3. **`> [!TIP]`** in the action-oriented section. Carries the single most important practical step the reader should do _now_.

Never use four callouts. Never use the same colour twice. Never put a callout in the bottom-line / closing section.

## Bullet patterns

- **Bold-lead bullets**. Every list item starts with `**Bold short heading.**` followed by one or two sentences of explanation.
- **Numbered lists for instructions or red-flag tallies** (1. 2. 3. 4.) — use the bold-lead pattern inside numbered items too.
- **Phone-number bullets get formatted on their own lines** with the carrier/bank name in bold and the number after a colon.

## Voice

- First-person plural ("we built", "we mirror", "we don't store") for everything Ask Arthur does.
- Second-person ("you're walking", "your phone", "you should") for everything the reader does.
- Australian English throughout (organisation, recognise, defence, A$ for AUD).
- One specific Australian named institution per section minimum — Scamwatch, ACMA, IDCARE, ACNC, ABR, PFRA, by name and never as a generic "the regulator".
- `troy-hunt` persona for tone (accessible, conversational, no dense em-dash chains) — _not_ `askarthur-house` (which is the engineering / B2B voice).

## Closing block

Always exactly two italic paragraphs after the final `---`:

1. _A helpline / disclaimer pointing to the relevant Australian recovery service (Scamwatch report flow, IDCARE, the bank fraud line) — phrased as a public-service note, not a CTA._
2. _A short Ask Arthur sign-off naming the platform, confirming the data is Australian, and pointing back to askarthur.au._

## When NOT to use this template

- **Engineering deep-dives** ("how X works internally", architecture posts, ADR companions) — use `askarthur-house` + `deep-dive` template, target 2,000–3,500 words.
- **Regulatory analyses** (SPF readiness, ACMA enforcement actions, post-mortems on industry incidents) — use `askarthur-house` + `incident-report` or `post-mortem`, longer-form, dense em-dash sentences.
- **Investigative pieces on third-party events** — use `krebs-investigative`, third-person past-tense.
- **Pure tutorials** ("how to set up X") — use `how-to` template; consumer explainer assumes the reader is _already in the moment_, not setting something up in advance.

## Audit checklist

Before publishing a consumer explainer, confirm:

- [ ] Body (excluding H1 + hero) is between 6,500 and 8,500 chars
- [ ] 6 or 7 H2 sections, each separated by `---`
- [ ] Exactly three callouts: one DANGER, one WARNING, one TIP, in that order
- [ ] No callout in the closing section
- [ ] Every bullet uses the bold-lead pattern
- [ ] At least one named Australian institution per section
- [ ] Closing block is two italic paragraphs (helpline + Ask Arthur sign-off)
- [ ] Reading time renders as 6–8 minutes on the live blog page
