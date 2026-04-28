# AI-citation playbook (GEO / AEO)

How to be the source ChatGPT, Perplexity, Google AI Overviews, Claude, and Gemini cite when users ask about your topic. This is the new SEO surface — Generative Engine Optimisation (GEO) / Answer Engine Optimisation (AEO) — and the rules are different from classical SEO in important ways.

## The big picture

Each AI assistant has a different retrieval pipeline, but they share three patterns:

1. **They cite specific passages, not whole posts.** A sentence or short paragraph is the unit, not the URL. If your post has *one* perfectly-quotable sentence answering a common question, you'll be cited even if the rest of the post is mediocre.

2. **They prefer answer-first formatting.** The first 1–2 sentences of each section are the most-cited region. Bury the answer below context and you give up the citation.

3. **They cross-reference for trust.** A claim that appears in 3+ sources gets cited more than a unique claim that appears only in your post — even if your version is better. So include corroborating sources in your post.

## Per-platform notes

### ChatGPT (OpenAI)

- Uses Bing search + its own training data. Recent posts (last ~12 months) get retrieval; older posts only show up if they're authoritative enough to be in training data.
- Cites in the form "(source: example.com)" with link.
- Strongly prefers FAQPage / HowTo / Article schema.
- Format-sensitive: bullet-point answers and tabular data get extracted more often than dense prose.

### Perplexity

- Heavily retrieval-driven; almost no reliance on training data.
- Cites with numbered footnotes [1], [2], [3] linking to source URLs.
- Prefers recent content (last 6 months strongly weighted).
- Likes posts with clear authority signals (named author, established site).
- Long-tail question phrasing in H2s gets cited disproportionately.

### Google AI Overviews

- Driven by Google's existing search + the SGE retrieval layer.
- Cites with source URLs in a side panel.
- Prefers content already ranking organically — AI Overview citation correlates with top-3 ranking for the query.
- E-E-A-T signals matter most here, since Google's quality framework is the underlying filter.

### Claude (Anthropic)

- Uses web search and citations when explicitly enabled. Otherwise relies on training data.
- Cites with source links in markdown format.
- Tends to quote longer passages than other assistants — 2–3 sentences rather than 1.

### Gemini

- Google's deep retrieval + search integration.
- Similar profile to AI Overviews (Google retrieval layer).
- Cites in numbered footnote / source-link format.

### Cross-platform

A 2025 analysis of major AI assistants found only **~12% citation overlap across platforms**. A site cited heavily on ChatGPT may be invisible on Perplexity. Each platform should be analysed independently.

## What to do in the post

### 1. Answer-first formatting

Every H2 opens with the answer in 1–2 sentences before context.

Bad:
> ## Why we use Inngest
>
> Background jobs are a perennial problem in serverless architectures, going back to AWS Lambda's early limits on execution duration...

Good:
> ## Why we use Inngest
>
> We use Inngest because it gives us durable retries, idempotency at the event level, and dead-letter handling without us having to build any of it ourselves. Background jobs in serverless architectures have always been awkward...

The first version makes the assistant guess. The second hands it the citation.

### 2. Citation capsules

Inline citations in the form `(per <source> <year>)` or `according to <source>'s <year> <type>`.

> Phishing-site survival is now under 24 hours on average (per APWG's Q1 2025 report).

This format is what most AI assistants emit when *they* cite. By using the same format in your prose, you make your post look like an authoritative source.

### 3. Information-gain markers

Sentences that explicitly flag what's new in your coverage:

- "While most analysis focuses on X, this post examines Y..."
- "What isn't widely reported is Z..."
- "The detail that doesn't appear in other coverage is..."

These markers tell retrieval models "this passage is worth quoting because it's not redundant with everything else they have." Effective when used 1–2 times per post; overused when used in every section.

### 4. FAQ schema

Add 3–5 Q&A pairs at the bottom of the post and inject FAQPage schema.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [{
    "@type": "Question",
    "name": "Why does X happen?",
    "acceptedAnswer": {
      "@type": "Answer",
      "text": "X happens because Y. The mechanism is Z."
    }
  }]
}
</script>
```

FAQ schema correlates with ~20% increase in AI-citation odds across major assistants. It's the single highest-leverage technical addition, and most posts skip it.

### 5. Long-tail question H2s

Phrase H2s as questions where natural:

- "How we cut p99 latency" → "How we cut p99 latency by 80%"
- "Cache configuration" → "How we decided cache TTLs by verdict type"

Question-shaped headings match the queries users actually type into AI assistants ("how does X handle Y?"), which makes the section more retrievable.

### 6. Key Takeaways callout

A 3–5 bullet summary near the top, before the main body:

```markdown
> **Key Takeaways**
>
> - X happens because Y; the implication is Z.
> - The conventional wisdom about A is wrong; data shows B.
> - For practitioners: do C, avoid D.
```

This is the most-cited single element on a typical post. Assistants quote takeaways verbatim because they're already condensed.

### 7. Tables for structured data

Tabular data is over-represented in AI citations because it's easy to extract. Whenever you have:

- A list of options being compared
- A list of feeds / vendors / sources / partners
- A timeline
- A pricing tier
- A version history

…format it as a markdown table, not a bulleted list. The schema is more retrievable.

### 8. Be a corroborator

Include 2–3 named tier-1 sources per post. AI assistants prefer sources that align with the broader corpus; pure contrarian takes get cited less because the assistant flags them as outliers. To be the *cited* source on a contrarian take, anchor the contrarianism in established sources first ("Y argued in [paper] that X; recent data confirms this in [our context]") before making your novel claim.

## Tracking AI-citation visibility

Hard to measure; the assistants don't expose citation metrics. Approximations:

- **Manual queries**: pick 5–10 representative queries for your topic. Once a quarter, run them in ChatGPT, Perplexity, AI Overviews. Note which sources are cited; track yours over time.
- **Referrer logs**: as more assistants link out, you'll start seeing referrer URLs from chatgpt.com, perplexity.ai, etc. Filter your analytics for these.
- **Brand mentions**: tools like Mention.com and Brand24 track when your brand or domain is cited in AI-assistant outputs.

Not great — the visibility tooling is immature. Manual querying is still the most reliable signal.

## What gets de-prioritised in citation

- Walls of unbroken prose with no answer-first openings
- Posts that fail to source quantitative claims
- Posts behind paywalls or aggressive cookie walls
- Posts with no schema markup
- Heavily promotional / vendor-marketing posts (assistants are trained to avoid these)
- Posts older than ~24 months unless authoritative

If a post is missing 3+ of the patterns above and underperforming on AI-citation, the highest-leverage `rewrite` is to retrofit answer-first openings, FAQ schema, citation capsules, and a Key Takeaways callout. That alone usually moves citation odds substantially.
