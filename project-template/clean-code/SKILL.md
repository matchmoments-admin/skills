---
name: clean-code
description: Enforces Clean Code practices (Robert C. Martin) for readable, maintainable code — intention-revealing names, small single-purpose functions, minimal comments, deliberate error handling, and clean unit tests. Use when writing new functions/classes, reviewing code, naming things, cleaning up messy code, or when the user mentions readability, code smells, naming, or "clean code." Apply proactively when generating any non-trivial TypeScript/JavaScript.
---

# Clean Code

Write code optimized for the next human (or agent) who reads it. The goal is to
reduce the cost of understanding. Prefer clarity over cleverness.

## When to apply
Apply while writing any non-trivial function, during code review, and whenever
cleaning up existing code. For the *process* of changing code safely, use the
`refactoring` skill. For module/class boundaries and SOLID, use `clean-architecture`.

## Naming
- Use intention-revealing names that answer why it exists, what it does, how it is used.
  A name that needs a comment is the wrong name.
- Functions/methods are verbs (`calculateOrderTotal`), classes/values are nouns
  (`activeCustomers`, `shippingCost`). Booleans read as predicates (`isValid`, `hasItems`).
- No single letters (except tiny loop indices), no abbreviations, no `data`/`info`/`temp`/`manager`.
- Be consistent with the codebase's existing vocabulary and casing conventions.

```typescript
// Bad
const d = new Date();
function process(x) { /* ... */ }
// Good
const orderCreatedAt = new Date();
function validateUserCredentials(credentials: Credentials): Result { /* ... */ }
```

## Functions
- Small and do ONE thing at ONE level of abstraction. Extract the moment a function
  does two things or mixes levels.
- Prefer 0–2 parameters; avoid 3+. Group related params into an object.
- No boolean flag arguments — split into two named functions instead.
- No hidden side effects: a function named `checkPassword` must not also initialize a session.
- Command/Query Separation: a function either does something or answers something, not both.

```typescript
// Bad: flag argument + two responsibilities
function renderPage(user: User, isAdmin: boolean) { /* ... */ }
// Good
function renderUserPage(user: User) { /* ... */ }
function renderAdminPage(user: User) { /* ... */ }
```

## Comments — agent-specific discipline
Comments are a failure to express intent in code. Do NOT add comments that merely
restate what the code already says — this is a common failure mode for AI-generated
code and it inflates diffs and review cost.
- Delete redundant/obvious comments; improve the name or extract a well-named function instead.
- Keep comments only for: intent that code cannot express, warnings of consequences,
  legal headers, TODOs, and public-API doc comments (JSDoc/TSDoc).
- Never leave commented-out code — delete it; version control remembers.
- Never write a comment to apologize for or narrate a change you just made.

## Error handling
- Prefer exceptions/typed error results over returning error codes or null.
- Do not return `null`/`undefined` where callers won't expect it; do not pass `null` into functions.
  Prefer explicit optionals, default objects, or a `Result<T, E>` type.
- Provide context in errors (what operation, what inputs) so failures are diagnosable.
- Wrap async operations in try/catch with typed error handling; don't swallow errors silently.

## Unit tests (keep tests clean too)
- One logical assertion/behavior per test; descriptive test names.
- Tests are FIRST: Fast, Independent, Repeatable, Self-validating, Timely.
- Write meaningful assertions. A test that mocks everything and asserts nothing
  proves nothing. (Agents tend to over-mock — verify the assertion is real.)

## The Boy Scout Rule
Leave code cleaner than you found it: on any file you touch, make one small,
safe improvement (a name, an extracted function) — but keep it a *separate*
concern from behavior changes (see `refactoring`).

## Agent review checklist (copy into your response when reviewing)
- [ ] Names reveal intent; no `d`/`temp`/`data`/`manager`
- [ ] Each function does one thing at one abstraction level
- [ ] ≤2 params; no boolean flag args; no hidden side effects
- [ ] No redundant/obvious comments; no commented-out code
- [ ] Errors typed and contextual; no silent catches; no surprise null
- [ ] Tests are isolated, named, and assert real behavior (not over-mocked)
- [ ] No duplicated logic (see `pragmatic-programmer` DRY)

## Detailed smell reference
For the full smells-and-heuristics catalog (Chapter 17), see
[references/smells-and-heuristics.md](references/smells-and-heuristics.md).

## References
- Robert C. Martin, *Clean Code: A Handbook of Agile Software Craftsmanship* (2008) —
  Ch. 2 Meaningful Names, Ch. 3 Functions, Ch. 4 Comments, Ch. 7 Error Handling,
  Ch. 9 Unit Tests, Ch. 17 Smells and Heuristics.
- blog.cleancoder.com (Uncle Bob).
