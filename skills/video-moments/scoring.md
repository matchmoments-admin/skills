# The moment rubric

Seven dimensions, each 1–5. Score all candidates in one pass so the numbers are
comparable; scored one at a time they drift and everything ends up a 4.

`rubric_score` is the weighted mean. `hook` and `self_contained` carry double weight
because a clip that fails either one fails completely, no matter how good the
content is.

| Dimension | Weight | 1 | 5 |
|---|---|---|---|
| **hook** | ×2 | Opens on throat-clearing, a qualifier, or the back half of a sentence | First sentence creates a question the viewer needs answered |
| **self_contained** | ×2 | Needs the previous ten minutes to parse | A stranger understands it cold |
| **payoff** | ×1 | Trails off, or restates the setup | Lands a conclusion, a number, a reversal, a punchline |
| **quotable** | ×1 | Nothing you'd screenshot | One line that works as text on its own |
| **tension** | ×1 | Agreeable, expected | Contradicts something the audience believes, or two people genuinely disagree |
| **emotion** | ×1 | Flat delivery of neutral facts | Laughter, anger, awe, discomfort — audible in the delivery |
| **actionable** | ×1 | Nothing to do with it | A viewer could apply it today |

Not every good clip scores high on all seven. An educational explainer will score 1
on tension and that's correct — don't inflate it to make the total look better. A
comedy moment will score 1 on actionable. The weights already handle this.

## Scoring notes

**hook** — judge the *first sentence only*, and judge it as text with no context.
"So the thing about that is…" is a 1 regardless of what follows. "We are rapidly
running out of reasons why this won't happen" is a 5. If you had to move the
boundary to make the hook work, score the moved version.

**self_contained** — the test is a specific one: does the clip use a pronoun,
a "that", or a proper noun whose referent only appeared earlier? If yes, it's at most
a 3, and it needs a `needs_context` flag.

**payoff** — ask where the clip *ends*. Ending on "…and that's really interesting"
is a 2. Ending on the specific claim, number or turn is a 5. A clip that stops before
its own conclusion is the second most common defect after a bad opener.

**quotable** — literally identify the line. If you can't point at one sentence that
would work as a caption or a pull-quote, it's a 2 or below.

**tension** — genuine disagreement or a counterintuitive claim, not manufactured
controversy. Do not score up something that is merely provocative out of context;
that's how a clip goes viral for the wrong reason. Flag those instead.

**emotion** — you're reading a transcript, so you can only infer this from wording
and from the `energy` signal if it's available. Laughter shows up as an energy spike;
if that series is missing, be conservative and say so.

**actionable** — a concrete method, number, or decision rule. "You should think
carefully about X" is a 1. "We cap it at 40 and here's why" is a 5.

## Flags

Independent of score. Attach any that apply:

| Flag | Meaning |
|---|---|
| `needs_context` | Works only if the viewer knows something from earlier |
| `boilerplate` | Sponsor read, intro, sign-off, chapter transition — carried through from the candidate |
| `names_a_person` | Makes a claim about a named individual. Check it reads fairly out of context before it goes anywhere. |
| `strong_claim` | A factual, medical, legal or financial assertion. Out of context these are how clips cause harm. |
| `mid_thought` | You could not find a break that fixed the opener |
| `low_signal` | Rubric is high but the fused signal is near zero — this is your prediction, not audience evidence |

`names_a_person` and `strong_claim` are not reasons to reject. They are reasons for a
human to read the clip before it's published.

## Combining with the signal score

```
final = 0.5 * normalised(signal_score) + 0.5 * (rubric_score / 5)
```

Normalise `signal_score` across the candidate set, not against an absolute scale —
fused scores aren't comparable between videos.

When the two disagree sharply, say so explicitly rather than letting the average hide
it:

- **High signal, low rubric** — usually an intro, a chapter boundary, or a moment
  whose appeal was visual. Check whether something happened on screen.
- **Low signal, high rubric** — a genuinely good passage nobody found, *or* your
  judgement is off. On a video with real view counts, trust the signal more than you
  want to. On a fresh upload there's no signal to trust, so this is expected.
