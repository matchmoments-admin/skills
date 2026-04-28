---
name: announcement
description: Launch / release / milestone post. Short, focused, actionable. Avoids the "we are excited to announce" trap.
target_words: [600, 1500]
intent: navigational
default_personas: [cloudflare-engineering, troy-hunt, house-template]
---

# Announcement template

Most announcement posts are bad because they're written for the company, not the reader. They open with how excited the company is. They list every feature in equal weight. They bury the "how do I get this" link. They use words like "thrilled" and "proud."

This template aims at the opposite: open with what the reader can now do, lead with the most useful thing, link the action.

## Section structure

1. **Lede (~80 words)**
   - One sentence: what is now available.
   - One sentence: who it's for / what they can now do that they couldn't before.
   - One sentence: how to get it (link).

   Example shape:
   > Today we're shipping X, which lets [specific persona] do [specific thing] without [specific friction]. It's available now in [region/tier]; [link to action].

2. **What you can now do (~250 words)**
   - 2–4 specific things the reader couldn't do yesterday and can do today.
   - Concrete, action-shaped. "Filter scam reports by victim demographics" beats "improved analytics".
   - One screenshot / GIF / code snippet showing each, where applicable.

3. **Why we built it (~200 words, optional but +trust)**
   - The problem this solves, in the user's words (literally — quote real customer feedback if you have it).
   - 1–2 paragraphs. Don't dwell.

4. **How it works under the hood (~250 words, optional)**
   - Skip if the audience doesn't care about implementation.
   - Include if you're announcing to engineers, or if there's a clever architectural decision worth highlighting.
   - One diagram if useful.

5. **What's not in this release (~150 words)**
   - **The honesty section.** Lists the obvious follow-up features that aren't shipped yet, and roughly when they will be.
   - This section is the difference between an announcement that builds trust and one that frustrates.
   - Format:
     ```
     **Coming next**:
     - <feature> — targeting <month / quarter>
     - <feature> — designing now, no commitment yet
     - <feature> — gathering feedback before we scope
     ```
   - If you can't be specific about timelines, say so honestly.

6. **Pricing / availability / breaking changes (~200 words, conditional)**
   - **Pricing**: explicit numbers and tiers. Don't make readers click through.
   - **Availability**: regions, plans, customer tiers, rollout timeline.
   - **Breaking changes**: if any. Format:
     ```
     ⚠️ Breaking change: <what changed>
     **Migration**: <link or instructions>
     **Deadline**: <date by which existing users must migrate>
     ```

7. **Get started (~150 words)**
   - Numbered list of next steps the reader can take *right now*.
   - First step is one click / one command. Don't open with a 12-point setup guide.

8. **FAQ (~200 words)**
   - 4–6 anticipated questions, including the awkward ones.
   - "How does this compare to <competitor>?" — answer it directly.
   - "Why is this not in the lower tier?" — answer it directly.
   - "Will the API contract change?" — answer it directly.

## Length targets

- Total: 600–1,500 words. Most announcements should be on the shorter end.
- 5–7 H2 sections.
- Lede ≤ 4 sentences.
- At least one screenshot / GIF / code snippet showing the user-facing surface.

## Critical rules

1. **Cut "thrilled", "excited", "proud", "delighted".** They signal nothing and are universally tuned out.
2. **Lead with the action.** The "Get started" link should be reachable within 2 scrolls.
3. **Don't list every feature in equal weight.** Pick the 2–4 things that are genuinely new and lead with those. Note minor things in a "smaller changes" callout.
4. **Always include "what's not in this release".** It's the single best trust-building move, and almost no one does it.
5. **Pricing and availability up-front.** Burying these is the cardinal sin of B2B announcements.
6. **Don't pretend it's bigger than it is.** A 1.2.3 patch release shouldn't read like a v2.0 launch.

## Persona compatibility

`cloudflare-engineering` for engineering-audience announcements (new APIs, infrastructure changes). `troy-hunt` if the announcement has a security / consumer-protection angle and the audience is mixed-technical. `house-template` for a brand-specific announcement voice (often warmer, more direct).

`patio11-deep-dive` is wrong here — announcements should be short and announcement-shaped, not 4,000-word essays. `dan-luu-analysis` is wrong because announcements aren't analysis pieces. `krebs-investigative` is wrong because you're announcing your own thing, not reporting on someone else's.
