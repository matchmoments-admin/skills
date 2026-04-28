# Visual patterns library

A small set of layouts that beat the default LLM bias toward "boxes connected by arrows." Pick one based on the **content shape**, not the topic. The whole point is that picking a pattern up-front gives you intentional whitespace and reading order — without one, you end up with elements scattered to fill the canvas.

Each pattern lists: when to use it, an ASCII sketch, layout rules, and the elements you'll need.

---

## 1. Linear flow

**Use when:** describing a process, pipeline, or sequence of stages where order matters and there's no branching.

```
┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐
│  A   │───▶│  B   │───▶│  C   │───▶│  D   │
└──────┘    └──────┘    └──────┘    └──────┘
  intake     enrich      score      verdict
```

**Rules:**
- Boxes the same size, same y-coordinate, evenly spaced.
- One annotation under each box (1–3 words). Annotations are the *value*; box names are the *step*.
- Arrows colored with `accent`, boxes outlined with `primary`.
- For ≥6 stages, switch to **Stacked flow** (vertical) so labels don't crowd horizontally.

**Elements:** rectangle × N, arrow × (N-1), text × 2N (one inside box, one underneath).

---

## 2. Multi-room layout

**Use when:** describing a system architecture or anything with grouped subsystems.

```
┌─ ingestion ────────┐  ┌─ scoring ────────────┐
│                    │  │                       │
│  ▣ webhooks        │  │  ▣ threat feeds       │
│  ▣ extension       │──▶│  ▣ Claude classify   │
│  ▣ chat bots       │  │  ▣ rules engine       │
└────────────────────┘  └───────────────────────┘
                              │
                              ▼
                        ┌─ verdict ──────────────┐
                        │  SAFE / SUS / HIGH     │
                        └────────────────────────┘
```

**Rules:**
- Each "room" is a rounded rectangle with a label in its top-left corner (text element offset by ~16px from the room's edges).
- Rooms have generous internal padding (≥ 32px between contents and walls).
- Inter-room arrows enter rooms at edges, never crossing through other rooms.
- Use `surface` fill for rooms, `primary` outlines, `accent` arrows.

**Elements:** rectangle (rounded) × rooms, text labels for room names, child elements inside, arrows between rooms.

---

## 3. Comparison columns

**Use when:** comparing two (or three) options on the same dimensions — before/after, before/after/then-what, our-approach vs theirs.

```
┌────────────────┐  ┌────────────────┐
│   Approach A   │  │   Approach B   │
├────────────────┤  ├────────────────┤
│ ✓ fast         │  │ ✓ accurate     │
│ ✓ cheap        │  │ ✗ slow         │
│ ✗ noisy        │  │ ✓ auditable    │
└────────────────┘  └────────────────┘
```

**Rules:**
- Columns same width and height; aligned at the top.
- Header rows visually distinct (filled with `primary`, white text).
- Rows aligned across columns so the same dimension is at the same y on both sides.
- Use ✓ / ✗ glyphs in monospace text for high-contrast at-a-glance reading. Color ✓ with `safe`, ✗ with `danger`.

**Elements:** rectangle × 2 columns, rectangle × N rows (or just text rows), text labels.

---

## 4. Evidence artifacts

**Use when:** showing how multiple pieces of evidence (a quote, a log, a screenshot, a hash) feed into a single conclusion. Strong fit for scam-analysis blog posts, postmortems, security write-ups.

```
   ┌─ "Hi mum, lost ┐    ┌─ Number from   ┐    ┌─ Posted on    ┐
   │  my phone..."  │    │  Pakistan      │    │  scam-watch   │
   └────────────────┘    └────────────────┘    └───────────────┘
            │                    │                     │
            └────────────┬───────┴─────────────────────┘
                         ▼
                  ┌─ HIGH RISK ──┐
                  │  hi-mum scam │
                  └──────────────┘
```

**Rules:**
- Evidence boxes look like quote cards: `surface_alt` fill, smaller text, slightly narrower than verdict.
- Verdict box is the largest, centered below evidence, filled with the appropriate verdict color (`safe`/`warn`/`danger`).
- Arrows converge on the verdict from each evidence card. Use slight curves (3-point arrows) so converging lines don't pile up.
- Each evidence card can have a tiny label above it ("text", "metadata", "context") in `muted`.

**Elements:** rectangle × evidence + verdict, text inside each, arrows from evidence to verdict.

---

## 5. Circular flow

**Use when:** describing a feedback loop or cyclical process (build → test → ship → learn → build).

```
              ┌─ build ─┐
              └─────────┘
              ▲         │
              │         ▼
       ┌─ learn ─┐  ┌─ test ─┐
       └─────────┘  └────────┘
              ▲         │
              │         ▼
              ┌─ ship ──┐
              └─────────┘
```

**Rules:**
- Arrange 3–6 boxes around a circle; place each at angles `360°/N`.
- Arrows are curved (3-point) and follow the circle's tangent, not straight lines through the middle.
- Optional: place a label in the dead center summarising the loop's purpose.
- Distance from center to box: at least 1.5× the box's longest side, so the diagram reads as a ring rather than a clump.

**Elements:** rectangle × N, arrow × N (curved), optional text in center.

---

## 6. 2×2 quadrant

**Use when:** mapping options across two independent dimensions (cost vs. accuracy, effort vs. impact, etc.).

```
high │           │
 ↑   │   QI      │   QII
     │           │
─────┼───────────┼─────  →  axis-X
     │           │
     │  QIII     │   QIV
     │           │
low  │           │
     low ─────────────► high
```

**Rules:**
- Two perpendicular axes meeting at a clearly-marked origin.
- Axis labels at both ends (low/high) in `muted`.
- Items placed *as points*, with their label nearby (above-right offset by 8px). Don't fill quadrants with rectangles; the position itself carries meaning.
- Optional faint quadrant fills (`surface`/`surface_alt` alternating) to make membership obvious.

**Elements:** 2 lines for axes, 4 text labels for axis ends, N small ellipses (points), N text labels.

---

## 7. Stacked flow

**Use when:** Linear flow doesn't fit horizontally (≥ 6 stages, or stages with verbose annotations).

```
   ┌─────────┐
   │   A     │
   └────┬────┘
        ▼
   ┌─────────┐
   │   B     │
   └────┬────┘
        ▼
   ┌─────────┐
   │   C     │
   └─────────┘
```

**Rules:**
- Boxes same width and x-coordinate, stacked vertically with consistent y-spacing (e.g., 80px between).
- Annotations to the *right* of each box (offset 24px), giving long descriptions room without breaking the column.
- Consider a thin connector line spanning the whole column with arrowheads at each transition — saves arrow elements for long flows.

---

## How to combine patterns

Real diagrams often nest patterns inside one another. Common combos:

- **Multi-room + Linear flow inside each room** (architecture with mini-pipelines per subsystem)
- **Evidence artifacts → 2×2 quadrant** (evidence pieces, then a placement on a tradeoff space)
- **Stacked flow with Comparison columns at one stage** ("at step 3, we considered X vs Y")

When nesting, make sure each pattern still satisfies its own internal alignment rules, and use `surface` fills sparingly so nested groups read as distinct from their parent.
