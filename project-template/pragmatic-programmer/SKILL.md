---
name: pragmatic-programmer
description: Applies The Pragmatic Programmer (Hunt & Thomas) meta-principles and engineering judgment — DRY (don't repeat knowledge), orthogonality/decoupling, tracer bullets, "no broken windows," design by contract, automation, and a systematic debugging mindset. Use for design decisions, when evaluating coupling/duplication, planning an end-to-end slice, deciding what to automate, debugging tricky failures, or when the user mentions DRY, coupling, technical debt, tracer bullets, or pragmatic trade-offs. Apply proactively to keep systems decoupled and free of rot.
---

# Pragmatic Programmer

Meta-principles and mindset that sit above any single file or class. Where
`clean-code` governs lines and `clean-architecture` governs boundaries, this
skill supplies engineering judgment.

## DRY — Don't Repeat Yourself
"Every piece of **knowledge** must have a single, unambiguous, authoritative
representation within a system." DRY is about knowledge/intent, not textual
lines — two identical-looking snippets that change for *different reasons* are
not duplication; two different-looking pieces encoding the *same rule* are.
- Eliminate duplicated business rules, magic values, and parallel data shapes.
- Note: a comment that restates code is a DRY violation (two representations that
  drift). Prefer expressive code (see `clean-code`).
- Don't over-DRY: forcing unrelated code together creates false coupling. When in
  doubt, wait for the Rule of Three (see `refactoring`).

## Orthogonality (decoupling)
Two things are orthogonal if changing one doesn't affect the other. Ask: "If I
change the requirements behind this function, how many modules are affected?"
The answer should be near one.
- Write "shy" code (Law of Demeter): a module talks only to its immediate
  collaborators, not to their internals (`a.getB().getC().doThing()` is a smell).
- Avoid global mutable state — every consumer becomes coupled to it.
- Layer the system (presentation / domain / data) so a change in one layer
  (e.g., swapping the DB or a UI framework) doesn't ripple. (See `clean-architecture`.)

```typescript
// Coupled (train wreck / Demeter violation)
const zip = order.getCustomer().getAddress().getZipCode();
// Shy: ask, don't reach through
const zip = order.shippingZip();
```

## Tracer bullets vs prototypes
- **Tracer bullet**: a thin but *real*, end-to-end slice connecting all layers
  (UI → API → domain → DB) with minimal functionality. It is production code you
  keep and grow. Use it to get early feedback and an integration skeleton.
- **Prototype**: throwaway code to answer one question. Communicate clearly that
  it will be discarded; never let a prototype become production by accident.
- For agents: prefer building a working end-to-end slice first, then filling in
  breadth — this gives verifiable feedback and avoids large unverifiable diffs.

## No Broken Windows (fight software entropy)
Don't leave bad designs, wrong decisions, or poor code unrepaired — neglect
signals that no one cares and accelerates rot. Fix small problems immediately or
explicitly track them. This is doubly important with AI-generated code: per
CodeScene (Adam Tornhill), "Unhealthy Code is Burning Your Token Usage,"
"agents working on unhealthy codebases consume almost 50% more tokens to
complete the same tasks" — so keeping the codebase clean directly lowers the cost
and error rate of future agent work.

## Design by Contract & Pragmatic Paranoia
- Be strict in what you accept and promise little in return. State preconditions,
  postconditions, and invariants (validate inputs at boundaries; assert invariants).
- **Crash early / fail fast and visibly** — a program that detects an impossible
  state should stop, not limp on corrupting data. Don't write speculative
  defensive code that hides bugs.

## Automation & the debugging mindset
- Automate repetitive tasks: builds, tests, linters, formatters, migrations, CI.
  Humans (and agents) are inconsistent; scripts are repeatable.
- Debugging: don't panic; reproduce reliably; read the error message carefully;
  make one change at a time; "select isn't broken" (assume the bug is in your code,
  not the platform); binary-search the failure; fix the root cause, then add a
  test that would have caught it.

## Agent guardrails checklist
- [ ] No duplicated knowledge (rules, constants, shapes) — single source of truth
- [ ] Change ripples to ~one module (orthogonal); no Demeter train wrecks; no new globals
- [ ] Built/verified an end-to-end slice before broad expansion
- [ ] Fixed or explicitly logged any "broken window" I introduced or found
- [ ] Inputs validated at boundaries; fail fast on impossible states
- [ ] Repetitive steps automated (script/test) rather than hand-repeated

## References
- Andrew Hunt & David Thomas, *The Pragmatic Programmer*, 20th Anniversary ed. (2019).
- pragprog.com/tips; artima.com "Orthogonality and the DRY Principle."
