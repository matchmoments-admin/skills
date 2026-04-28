# E-E-A-T signals

Google's quality framework — Experience, Expertise, Authoritativeness, Trust — and the concrete markers that signal each in technical blog content. Used by `write` (to weave them in proactively) and `audit` (to score for them).

E-E-A-T isn't an algorithm; it's a heuristic Google's quality raters apply to evaluate pages, and that the model uses as a training-time signal. AI assistants (ChatGPT, Perplexity) use similar signals when picking which sources to cite.

## Experience (1st E)

The author has *done* the thing they're writing about, not just read about it. This is the strongest of the four signals for technical content because it's the hardest to fake.

### Markers

- **First-person experience phrases**: "we ran X for 18 months", "I tested this on Y", "the first time we hit this", "after the migration".
- **Lived-detail observations**: things you can only know by having done it. The exact log line that fires when X fails. The specific moment in the on-call rotation when Y breaks. The vendor's phone-tree path to get to a real engineer.
- **Original screenshots / data / receipts**: a diagram you drew, a screenshot of your own dashboard, a CSV you exported, a code snippet from your repo.
- **Concrete amounts**: dollar figures, latencies, error rates, throughput numbers. From your system, not "industry averages".
- **Time-bound details**: "in 2024 the behavior was X; as of [recent month] it's Y." Locks the experience to a specific moment.

### Anti-patterns

- Pure tutorials with no first-person voice (use `cloudflare-engineering` or `house-template` to bring it in)
- "In my experience" without supporting detail (the phrase doesn't carry experience by itself)
- Claims without specifics ("we found X works better" — than what, by how much?)

## Expertise (2nd E)

The author understands the domain well enough to explain it correctly, including edge cases and failure modes.

### Markers

- **Author byline + credentials**: name + one-line description of why the reader should trust this author. Job title alone is weak; "ran payments at Stripe for 5 years" or "maintains [open-source project]" is strong.
- **Correct use of terms of art**: defines unfamiliar terms the first time, uses them precisely thereafter. Avoids buzzword-sprinkling.
- **Citing primary sources**: links to RFCs, papers, vendor docs, court filings — not just other blog posts.
- **Naming alternatives**: "we considered X but rejected it because Y". Shows the author knows the space.
- **Acknowledging tradeoffs**: every choice has a downside; experts name them.
- **Version / date precision**: "as of TLS 1.3", "in Postgres 16", "starting with Next.js 15.2" — the right level of specificity.

### Anti-patterns

- Vague claims ("X is generally better")
- Pop-tech overgeneralisations ("microservices solve coupling")
- Wikipedia-summary-shaped paragraphs (rewriting consensus knowledge with no added insight)

## Authoritativeness (A)

The author is a recognised voice in this domain, or this site is a recognised source.

### Markers

- **Author has a body of work** in the same domain (links to other posts on related topics)
- **Site has topical authority** (5+ posts on related topics, internal-linking structure connects them as a cluster)
- **External validation**: cited by other reputable sources, mentioned in industry reports, featured in conferences
- **Identity verification**: real name, photo, social profile, professional context. Anonymous posts can be authoritative on technical merit but lose this signal.
- **Original research / contributions**: papers, talks, open-source projects, public datasets

### Anti-patterns

- Posts that seem to come from nowhere (no related posts, no author info)
- Pseudonymous bylines on everything (acceptable for some niches but limits authority)
- Sites with one good post on a topic and nothing else (no topical authority, the lone post struggles to rank)

### Building authority

Authority compounds with publication. The first 5 posts on a topic establish the cluster; subsequent posts benefit from the cluster's collective authority. This is why content strategy (topic clusters, hub-and-spoke architecture) matters — see `workflows/plan.md`.

## Trust (T)

The site / author is *safe*: the content is accurate, the claims are sourced, the site doesn't try to manipulate the reader.

### Markers

- **Every quantitative claim has a source** within ~50 words.
- **Sources are tier 1–3**, not "a study found".
  - **Tier 1**: government, academic peer-reviewed, primary research.
  - **Tier 2**: major media (NYT, FT, BBC), established industry reports (Gartner, Forrester).
  - **Tier 3**: vendor research with disclosed methodology, well-regarded technical blogs.
- **Date markers**: publication date + lastUpdated date.
- **Disclosure**: sponsored content, affiliate links, conflicts of interest disclosed clearly.
- **Corrections noted**: when something turns out to be wrong, a correction note is added in place rather than silently editing.
- **Contact info**: way to reach the author / site (email, social).
- **HTTPS, no aggressive ads, no dark patterns**: site-level trust factors.

### Anti-patterns

- Orphan numbers (any number without a source)
- "A recent study" (which study? when? linking?)
- Stale stats ("according to a 2018 report" in a 2026 post — flag this and update)
- Affiliate links not disclosed
- Silent edits to correct factual errors

## How to weave these into a draft

The `write` workflow's polish pass should ensure at minimum:

- **Experience**: ≥ 1 first-person experience phrase per major section. ≥ 1 piece of original data / screenshot / detail.
- **Expertise**: defines every term of art. Names ≥ 1 alternative considered. Acknowledges ≥ 1 tradeoff explicitly.
- **Authoritativeness**: byline + credentials at the top. ≥ 3 internal links to related posts.
- **Trust**: every number sourced. Publication date present. Tier 1–3 sources only.

A post hitting all four signals will score 13–15 / 15 in the E-E-A-T audit category.

## Cross-reference

- Specific things the audit measures: `references/quality-scoring.md` § E-E-A-T Signals
- How to weave them in during drafting: `workflows/write.md` Pass 3
- How to retrofit them onto an existing post: `workflows/rewrite.md` phases 2–3
