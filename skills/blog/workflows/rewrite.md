# /blog rewrite — optimize an existing post

Take an existing post and improve it without rewriting from scratch. Preserves the author's voice and concrete points; replaces fabricated stats with sourced ones, scrubs AI phrases, tightens to the active persona, adds missing E-E-A-T markers and schema.

## Inputs

- `<post-path>` — required.
- `--persona <name>` — pull voice toward this persona. If unset, preserve the existing voice as-is and only fix structural / sourcing / SEO issues.
- `--target-score <n>` — default 85. Iterate until the audit returns ≥ this score, max 3 passes.
- `--max-passes <n>` — default 3.
- `--mode collab|auto` — default `collab` (rewriting is high-stakes; default to confirming each pass).

## Workflow

### Phase 1 — Audit (read-only)

Run `/blog audit <post-path>` exactly as `audit.md` describes. Capture the punch list.

In `--mode collab`, surface the audit and the punch list, then ask:

> "Audit score: <N> / 100. Top 5 issues:
>   1. <issue>
>   2. ...
> Apply all? (y / pick <indices> / abort)"

If the user picks specific items, only address those. If `auto`, address all issues with priority ≤ 3.

### Phase 2 — Source missing statistics

For each unsourced quantitative claim flagged in the audit:

1. WebSearch for the claim plus a year qualifier (`2025 2026`).
2. Find a tier 1–3 source. Prefer:
   - Tier 1: government, academic, primary research.
   - Tier 2: major media, established industry reports (Gartner, Forrester, McKinsey).
   - Tier 3: vendor research with disclosed methodology.
3. If no source exists for the exact number, try a variant claim or remove the claim entirely. **Do not invent a source.**
4. Replace the orphan number in the post with `According to <source> <year>, <claim> ([link](url))` (formatting per the project's existing style — match nearby citations).

### Phase 3 — AI-phrase scrub

For every match against `~/.claude/skills/blog/references/ai-phrase-scrubber.json`:

1. Look up the suggested replacement in the JSON (each entry has a primary replacement and 2 alternatives).
2. Apply the replacement that fits the surrounding sentence. If none fit, rewrite the sentence to remove the phrase entirely.
3. After all replacements, re-scan to verify zero matches remain.

### Phase 4 — Persona pull (only if `--persona` was set)

For each persona-drift metric in the audit:

- **Sentence-length mean drift > ±3 words**: rewrite the most-uniform paragraphs with deliberate variation.
- **Std-dev < 70% of declared**: same fix — the most uniform 1–2 paragraphs get a short jab + long context sentence.
- **Contraction-frequency drift**: bulk find/replace expanded forms ↔ contractions across the post until ratio matches.
- **Reading grade out of band**: swap vocabulary up or down. For consumer tier and the post is grade 12, find the top 10 longest words and replace with simpler synonyms where lossless.
- **Forbidden-phrase hits**: rewrite each, same as AI-phrase scrub.
- **Don't-rule violations**: rewrite the offending sentence (just one rewrite per violation).
- **Do-rule misses**: insert one or two sentences that exemplify the missing "do" pattern in places that fit naturally.

### Phase 5 — Structural fixes

Per the audit punch list:

- **Missing meta description**: write one (150–160 chars, primary keyword front-loaded).
- **Missing FAQ schema**: add 3 Q&A pairs answering the top question queries from the brief (or, if no brief, infer from the post's H2 questions).
- **Missing internal links**: scan the project blog dir for related posts; insert 3–6 links with descriptive anchors.
- **Missing alt text**: write alt text for every image based on the surrounding context.
- **Heading hierarchy issues**: re-level any rogue H4 → H3 or skipped H2 → H4.
- **Answer-first H2 fixes**: for each H2 that doesn't open with the section's answer, rewrite the opening sentence.

### Phase 6 — Re-audit

Run `/blog audit <post>` again. Compare to phase-1 score.

- If new score ≥ `--target-score`: done. Output the diff and stop.
- If new score < `--target-score` AND `--max-passes` not yet exhausted: collab-mode asks "score is now <X>; run another pass on remaining issues? (y/n)". Auto-mode runs another pass automatically.
- If `--max-passes` exhausted: stop and report the final score, list remaining issues.

## Output

In `--mode collab`, surface a diff-style summary:

```
Rewrite complete: <post>
- Score: 72 → 89 (+17)
- 4 unsourced numbers → 4 sourced, all tier-1 or tier-2
- 6 AI-phrase hits → 0
- Voice fit: poor → good (sentence-length std 3.1 → 6.4; grade 12.1 → 10.4)
- Added: meta description, FAQ schema (3 pairs), 5 internal links
- 1 issue remains: alt text missing on /illustrations/diagram-2.webp (auto-skipped — needs human caption)
```

Don't print the full rewritten file to chat; the file at `<post-path>` is the deliverable.

In `--mode auto`, just print the score delta and the path.

## Safety rules

- **Never delete factual claims** the user made. If a claim can't be sourced, surface it for the user's call rather than removing.
- **Preserve code snippets verbatim**. Don't reformat or "improve" code — touch only prose.
- **Preserve the author's distinctive turns of phrase** even if the persona pull would technically smooth them. The point of `rewrite` is to lift the post toward the score target while keeping it recognisably the user's writing. If a persona constraint would erase the user's voice, log the conflict and skip that specific change.
- **Diff before write.** In collab mode, show the user a unified diff before saving over the original. In auto mode, save a `.bak` backup beside the original first.
