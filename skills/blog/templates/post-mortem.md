---
name: post-mortem
description: Incident analysis. Timeline + root cause + remediation + lessons. Most-cited shape on engineering blogs because the format is well-trusted.
target_words: [1500, 3000]
intent: informational
default_personas: [cloudflare-engineering, troy-hunt]
---

# Post-mortem template

## Section structure

1. **Summary box (~80 words, callout)**
   - **What happened**: one sentence.
   - **When**: dates / times / duration.
   - **Impact**: who was affected, what couldn't they do, for how long.
   - **Root cause**: one phrase.
   - **Status**: resolved / monitoring / open.

2. **Detailed timeline (~400 words)**
   - Chronological, timestamped. Use 24-hour clock + UTC.
   - Each entry is 1–3 sentences max. What was observed, what was done.
   - Format:
     ```
     **14:02 UTC** — first alerts on p99 latency.
     **14:05 UTC** — on-call engineer paged.
     ```
   - Include the "we thought it was X but it was actually Y" moments — they're the most instructive part.

3. **Root cause (~400 words)**
   - The technical detail of what went wrong.
   - Diagram showing the flawed state if helpful.
   - Distinguish *triggering cause* (the change that surfaced the bug) from *root cause* (the underlying flaw). Most postmortems conflate them; doing it right is a credibility marker.
   - Code snippet if the bug is in code.

4. **Why our safeguards didn't catch it (~250 words)**
   - The most useful section in any postmortem and the most often skipped.
   - For each layer of defence (tests, code review, staging, monitoring, alerts), explain why it didn't catch this specific bug.
   - Don't blame people. Blame the system that didn't help them.

5. **What we did to recover (~200 words)**
   - The specific steps from "we noticed the problem" to "the problem was contained" and "the problem was fixed".
   - If recovery took multiple hours, walk through the dead ends honestly.

6. **Remediation — what's changing (~300 words)**
   - Numbered list. Each item: what's changing, who owns it, timeline (week / month / next sprint).
   - Distinguish:
     - **Immediate fixes** (already shipped or shipping today)
     - **Short-term mitigations** (this week)
     - **Structural changes** (this quarter)
   - A postmortem with no remediation is theatre. If you genuinely have nothing to change, write that and explain why.

7. **What we got right (~150 words)**
   - 2–3 things the system did well during the incident.
   - This isn't a victory lap — it's about identifying which existing safeguards earned their keep so they don't get refactored away later.

8. **Lessons for others (~200 words, optional)**
   - Generalise: what should other teams take from this beyond the specifics?
   - This is the section search engines and AI assistants cite most.

9. **FAQ (~150 words)**
   - 3–4 anticipated questions: "Did customer data leak?" / "Will it happen again?" / "Why didn't [obvious thing] catch it?"
   - Direct answers; no PR softening.

## Length targets

- Total: 1,500–3,000 words.
- 6–9 H2 sections.
- Timeline entries: ≤ 3 sentences each.
- One diagram showing the failure mode.
- Optional: code snippet of the offending code (with context — what it was supposed to do).

## Tone constraints

A good postmortem is sober without being defensive. Two failure modes to avoid:

1. **Marketing softening** — "we recently identified an opportunity to enhance the resilience of our platform". This destroys trust. Say what broke.
2. **Self-flagellation** — "we are devastated, we let our customers down, we will do better". This also destroys trust. Show the remediation; the contrition is implied.

Match `cloudflare-engineering` voice if it's a team postmortem. Match `troy-hunt` voice if it's a smaller / solo incident with a more conversational tone. Avoid `patio11` and `dan-luu` — both lean too analytical for the format, and `krebs-investigative` is wrong because postmortems are first-person about your own incident, not third-person about someone else's.
