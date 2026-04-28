---
name: how-to
description: Step-by-step tutorial. Practical, action-oriented, gets the reader from "I want to do X" to "I just did X" with zero friction.
target_words: [1200, 2500]
intent: informational
default_personas: [cloudflare-engineering, house-template]
---

# How-to template

## Section structure

1. **Hero / opener (~120 words)**
   - One sentence on what the reader will be able to do by the end.
   - One sentence on prerequisites (skill level, tools, accounts).
   - One sentence on time estimate ("This takes about 20 minutes if you have X already set up.").
   - Optional: a link to the finished result (live demo, GitHub repo).

2. **Prerequisites (~150 words)**
   - Bulleted list of things the reader needs before starting.
   - For each, link to setup if not assumed knowledge.
   - **Be honest** about what's actually required vs. nice-to-have. Don't say "basic familiarity with X" if the steps assume intermediate.

3. **Why this approach (~200 words, optional but +trust)**
   - 1–2 paragraphs on what alternatives exist and why this one was chosen.
   - This separates a how-to from a recipe. The reader learns *why*, not just *what*.

4. **Step-by-step (~600–1500 words)**
   - Numbered H2s (Step 1: …, Step 2: …) so the structure is visible from the table of contents.
   - **Each step has the same internal shape**:
     - One-line goal: "What you're doing in this step."
     - The action: a code block, command, or click-path.
     - **Expected output**: what success looks like. Include the exact log line / response code / screenshot region.
     - **If it didn't work**: the most likely failure mode and how to debug it.
   - 5–9 steps total. Fewer than 5 → it's a recipe, not a tutorial. More than 9 → split into two posts.

5. **Verification (~150 words)**
   - How to check the final result is correct.
   - Includes the success criterion in observable terms ("you should see X in the dashboard within 5 minutes").

6. **Common issues + troubleshooting (~250 words)**
   - 3–5 specific problems with specific solutions.
   - Format:
     ```
     **Problem**: <what the reader sees>
     **Cause**: <why it's happening>
     **Fix**: <specific action>
     ```
   - This section is what gets bookmarked and re-visited. Make it complete.

7. **Going further (~150 words, optional)**
   - 3–5 directions to extend or harden what was just built.
   - Each is one sentence + optional link.

8. **FAQ (~200 words)**
   - 3–5 anticipated questions, often "can I do this on Y instead of X?" / "how does this scale?" / "is this production-ready?"
   - Direct answers; no "it depends" without specifics.

## Length targets

- Total: 1,200–2,500 words.
- Each step ≤ 150 words of prose (excluding code blocks).
- Code blocks should be runnable, not pseudocode.
- 1–2 screenshots / diagrams; more if visual orientation matters.

## Critical rules

1. **Test the steps.** A how-to that doesn't work end-to-end is worse than no how-to. Run through the post yourself before publishing.
2. **Don't skip the obvious.** What's obvious to you isn't obvious to the reader. The "create the file with this exact name" step matters.
3. **Don't pretend it's harder than it is.** If the whole thing is `pip install foo && foo init`, write a 200-word post and don't pad. Padding kills trust.
4. **Use code blocks for everything copy-pasteable.** Including filenames, env vars, URLs.
5. **Number the steps.** Bulleted how-tos read as suggestions; numbered ones read as instructions.

## Persona compatibility

`cloudflare-engineering` is the default — its "we did X, we considered Y" structure works well even for solo how-tos.

`house-template` is the alternative — many how-tos are best in a brand voice you've defined for tutorials specifically (often warmer than the named personas).

`patio11-deep-dive` and `dan-luu-analysis` are wrong here — both voices want to argue or analyse, neither wants to instruct. `krebs-investigative` is wrong (third-person past tense doesn't fit instructions). `troy-hunt` works only for security-relevant how-tos where the conversational tone is appropriate.
