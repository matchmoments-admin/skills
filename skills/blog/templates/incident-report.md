---
name: incident-report
description: Investigative report on an external event — a scam ring, a breach, a vendor failure, a regulatory action. Third-person, source-led, sober.
target_words: [1500, 4000]
intent: informational
default_personas: [krebs-investigative]
---

# Incident report template

This is the template for *external* incidents — something you observed, investigated, or were affected by but didn't cause. For incidents you caused yourself, use `post-mortem.md` instead.

## Section structure

1. **Lede paragraph (~100 words)**
   - Who, what, when, where in the first 2 sentences. No setup, no scene-setting.
   - Sentence 3: why it matters / why this is being reported.
   - Sentence 4 (optional): the most striking single fact.

   Example shape:
   > A ransomware crew calling itself BlackBird has extorted at least nine U.S. hospitals over the past 18 months from a residential address in Volgograd, Russia, according to records reviewed by [author]. The group has demanded payments ranging from $200,000 to $4.7 million; two hospitals paid, seven did not.

2. **Context (~200 words)**
   - 2–3 paragraphs setting up why this incident matters in the broader landscape.
   - Reference prior similar events without rehashing them; link out.
   - Name the relevant actors, vendors, regulators if they're not already named.

3. **What happened — chronological account (~600 words)**
   - Timeline if dates are firm; narrative if they're approximate.
   - Sources for each claim. Block-quote primary documents (court filings, criminal forum posts, leaked email threads, screenshots).
   - Use cautious language for unconfirmed claims: "appears to", "according to one of two sources who described the matter".

4. **The technique / pattern (~400 words)**
   - The mechanism by which the incident worked.
   - Diagrams if the topology matters.
   - Compare to prior incidents that used similar techniques.
   - Don't pretend the technique is more sophisticated than it is — most scams and breaches use boring methods that work because of human factors.

5. **Who's affected (~250 words)**
   - Numbers where known: "approximately X people", "Y companies in Z industries".
   - Demographic / sector breakdown if available.
   - Quote affected individuals or organisations where they've gone on the record.

6. **Response — what authorities, vendors, victims have done (~300 words)**
   - Disclosure timeline.
   - Vendor / company responses (with quotes if obtained, with "did not respond" where applicable).
   - Government / regulatory action if any.
   - **Honest about gaps**: "Law enforcement has not commented on the investigation."

7. **The bigger pattern (~250 words)**
   - Zoom out. This incident as one instance of a larger trend.
   - Cite data on prevalence if available.
   - Be careful here — this section is where investigative reporting most often slips into editorialising. Stick to: what the data shows, what experts have said on the record, what prior reporting has established.

8. **Disclosure / methodology (~150 words, in a callout box)**
   - How the data was obtained (FOI, leaked dataset, criminal forum monitoring, source contacts, court records).
   - Who was contacted for comment and when.
   - What was withheld and why (active investigations, source protection, victim privacy).
   - Author's relevant expertise / disclosures.

   Format:
   > **Methodology**: This report is based on records reviewed by the author over a six-week period in [month, year], including X court filings, Y leaked email threads, and on-the-record interviews with three named sources. The affected company was contacted for comment on [dates]; their response is included above where given. Names of victims have been withheld at their request.

## Length targets

- Total: 1,500–4,000 words.
- Lede: ≤ 4 sentences.
- Methodology box: ≤ 200 words.
- Every quantitative claim: source attribution.
- Every quoted person: full name unless safety / source protection requires anonymity (in which case explain *why* they're anonymous in the methodology).

## Critical rules

1. **Attribute every non-public claim.** "According to records reviewed by KrebsOnSecurity" / "as stated in the indictment filed in the Eastern District of Virginia on [date]". Orphan claims kill the post's credibility.
2. **Don't editorialise.** No "shocking", "horrific", "deeply troubling". The facts carry the weight. If they don't, the post isn't ready.
3. **Verify before publishing.** Two-source rule for any non-public claim. If you have only one source, mark the claim as such.
4. **Take the disclosure timeline seriously.** Not naming a company because they pushed back legally is acceptable; not naming them because asking would have been awkward is not.
5. **Stay out of the story.** First-person should appear only in the methodology / disclosure section.

## Persona compatibility

`krebs-investigative` is the only good fit for this template. The other personas (`troy-hunt` first-person, `patio11` analytical, `cloudflare-engineering` retrospective, `dan-luu-analysis` data-heavy) are wrong for the format because they're all variants of "first-person tells you about something I did or analysed" — investigative reporting is third-person about something other actors did.

If you don't have the journalistic skill or the source access to write this template properly, default to one of the first-person templates instead. A weak investigative report is worse than a strong analysis piece on the same topic.
