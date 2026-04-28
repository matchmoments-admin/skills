# Internal linking

Internal links serve three purposes: navigational (the reader can go deeper), topical (Google understands which posts are related), and authority (link equity flows from established posts to new ones).

## Rules

### 1. Anchor text is descriptive, not decorative

Bad:
> For more on this, [click here](url).
> Read our [previous post](url) about it.
> See [this article](url).

Good:
> The full architecture is laid out in [our deep-dive on the analyze pipeline](url).
> [How we cut p99 latency by 80%](url) covers the motivation for the cache redesign.
> The [postmortem on the May incident](url) explains why this matters.

The anchor text should make sense out of context. If a reader sees just the anchor text in a search-engine snippet, they should know what the link goes to.

### 2. Link to specific sections, not just to posts

When the destination post is long, link to a specific anchor:

> Skip ahead to [the threat-feeds table in the deep-dive post](url#threat-feeds) for the full list.

This is more useful for the reader and signals to search engines that you understand the destination's structure.

### 3. Density: 3–6 links per 1500-word post

- Less than 3: not pulling enough authority signal; the post reads as orphaned.
- More than ~6 per 1500 words: links become noise; readers stop trusting them.
- For pillar pages (3000+ words): 6–10 links to spokes, plus 2–3 outbound links to authoritative external sources.

Distribute across the post; don't cluster all links in one section.

### 4. Three roles of internal links

For each post, plan links in three roles:

- **Up-link to the pillar page** (1 link, near the top, naming the broader topic)
- **Sibling links** (2–4 links, distributed through the body, connecting to related posts at the same depth)
- **Drill-down link** (1 link, near the bottom, pointing to a more-specific spoke if one exists)

This is the hub-and-spoke topology made visible. Search engines and AI assistants treat internal-linking structure as the strongest signal of how a site organises its expertise.

### 5. Don't link to weak posts

If an existing post on the topic isn't ship-quality, don't link to it. The link's job is to help the reader and signal authority; pointing them at a 60/100 post hurts both. Either upgrade the destination first (run `/blog rewrite`) or don't link.

## Linking *to* the post you're writing

The new post benefits when *existing* posts get updated to link *to* it. After publishing:

1. Search the existing blog dir for posts that mention the new post's primary keyword or related concepts.
2. For each match, decide: should this old post link to the new one?
3. If yes: rewrite the existing paragraph to include a natural mention with descriptive anchor text.

This is "back-linking" within the site. Cheap (you already have the old posts), high-leverage (lifts the new post's discoverability), and almost universally skipped because it's annoying.

`brief.md` § Internal linking plan should always include both directions: which existing posts the new post will link *out* to, AND which existing posts should be edited to link *in* to the new post.

## Anchor-text patterns by link type

| Link type | Pattern | Example |
| --- | --- | --- |
| Up-link to pillar | "<broad topic>: a survey" / "the broader question of <topic>" | "the broader question of [how we handle threat intelligence](url)" |
| Sibling | Specific claim with a noun phrase | "[how we cut p99 latency by 80%](url) covers the cache rationale" |
| Drill-down | "specifically on X" / "the [X] subsystem in detail" | "specifically on [how the cache TTL is decided](url)" |
| External (out) | Same descriptive principle | "[Postgres 16's row-level security improvements](url) make this cleaner" |

## Avoid these anti-patterns

- **Self-link spam**: linking to the same post 3+ times. Once is good; twice is acceptable for emphasis; three times is a tell.
- **Link to a homepage when you mean a post**: "more about Acme" → /acme/ vs. "Acme's [pricing breakdown](url)".
- **Link to dead / redirected pages**: run a link-check before publishing.
- **Link with affiliate / tracking parameters in internal links**: clean URLs internally; affiliate codes belong on outbound commercial links only, with disclosure.

## Tooling

A link-check script you can run pre-publish:

```bash
# Find all internal markdown links
grep -roE "\[.+?\]\(/[^)]+\)" docs/blog/

# Find broken anchors (after build)
# Use the project's link-checker — varies by static-site generator
```

For greenfield blogs (no other posts to link to), this entire reference is moot until the second post. The first post writes its links to *future* posts as natural mentions without anchors, and gets retro-linked once those posts ship.
