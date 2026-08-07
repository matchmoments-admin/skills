---
name: refactoring
description: Guides safe, incremental, test-protected refactoring (Martin Fowler) — recognize code smells, pick the right named refactoring, and change structure in tiny steps without altering behavior. Use whenever restructuring or cleaning up existing code, extracting functions, renaming, removing duplication, taming a large class/function, or when the user says "refactor," "clean this up," "reduce technical debt," or "improve this code." Enforces running tests before and after every step and separating refactoring from feature changes.
---

# Refactoring

Refactoring is changing the internal structure of code **without changing its
observable behavior**, in small steps, to make it easier to understand and cheaper
to modify. This skill governs the *process*; use `clean-code` for what "good"
looks like and `clean-architecture` for module boundaries.

## The core discipline (non-negotiable for agents)
1. **Ensure a green test suite exists first.** If the code under change is not
   covered by tests, write characterization tests before refactoring. Tests are
   the guardrail that proves behavior didn't change. Static types and linters add
   a second net.
2. **Take tiny steps.** Each step should leave the code compiling and passing
   tests. "You go faster when you take tiny steps, the code is never broken, and
   you compose those steps into substantial changes" (Fowler).
3. **Run tests (and type-check) after every step.** If red, revert the last step —
   don't debug forward. Small steps make reverting cheap.
4. **Wear one hat at a time (the Two Hats rule).** Either you are *refactoring*
   (no behavior change) or *adding a feature* (behavior change) — never both in
   the same commit. This matters especially for agents: studies of AI agents find
   most refactorings get tangled into feature/bugfix commits, which inflates review
   burden. Keep refactoring commits separate and label them clearly.
5. **Do not "run away."** Agents tend to over-produce low-level cosmetic edits.
   Refactor only in service of a goal (understanding, or preparing to add a
   feature — "make the change easy, then make the easy change"). Don't rename or
   reshuffle code unrelated to the task.

## When to refactor
- **Preparatory**: before adding a feature, restructure so the feature is easy to add.
- **Comprehension**: rename/extract as you understand code, to record understanding.
- **Rule of Three**: duplicate once grudgingly; on the third occurrence, refactor.
- **Opportunistic** (Boy Scout Rule): small cleanups on code you touch.

## Common smells → refactorings
- **Mysterious Name** → Rename Variable/Function/Field.
- **Long Function** → Extract Function; Replace Temp with Query; Decompose Conditional.
- **Duplicated Code** → Extract Function; Pull Up Method; Slide Statements.
- **Long Parameter List** → Introduce Parameter Object; Preserve Whole Object.
- **Large Class** → Extract Class; Extract Superclass.
- **Feature Envy / Message Chains** → Move Function; Hide Delegate.
- **Primitive Obsession** → Replace Primitive with Object; Introduce Value Object.
- **Repeated Switches** → Replace Conditional with Polymorphism.
- **Divergent Change / Shotgun Surgery** → Split/Move behavior so one reason to change.
For the mechanics of each, see [references/catalog.md](references/catalog.md).

## Worked example (Extract Function, tiny steps)
```typescript
// Before: long function mixing calculation + formatting
function printOwing(invoice: Invoice): void {
  let outstanding = 0;
  console.log("***** Customer Owes *****");
  for (const o of invoice.orders) outstanding += o.amount;
  console.log(`name: ${invoice.customer}`);
  console.log(`amount: ${outstanding}`);
}
// Step 1: extract the banner (run tests)
// Step 2: extract the total calculation (run tests)
// Step 3: extract printing (run tests)
function printOwing(invoice: Invoice): void {
  printBanner();
  const outstanding = calculateOutstanding(invoice);
  printDetails(invoice, outstanding);
}
function printBanner(): void { console.log("***** Customer Owes *****"); }
function calculateOutstanding(invoice: Invoice): number {
  return invoice.orders.reduce((sum, o) => sum + o.amount, 0);
}
function printDetails(invoice: Invoice, outstanding: number): void {
  console.log(`name: ${invoice.customer}`);
  console.log(`amount: ${outstanding}`);
}
```

## Agent workflow checklist
- [ ] Behavior is covered by passing tests (or I wrote characterization tests)
- [ ] I picked a named refactoring for a recognized smell
- [ ] Each change is a tiny step; tests + type-check run and pass after each
- [ ] No behavior change mixed in (Two Hats); refactoring is its own commit
- [ ] Prefer the IDE/language tool for rename/extract where available (exact,
      updates all references); still verify with tests for dynamic code
- [ ] The refactoring serves the current goal; I didn't churn unrelated code

## References
- Martin Fowler, *Refactoring: Improving the Design of Existing Code*, 2nd ed. (2018).
- refactoring.com (online catalog); martinfowler.com/bliki/CodeSmell.html.
