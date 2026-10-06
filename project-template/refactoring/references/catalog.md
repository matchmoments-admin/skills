# Refactoring — Mechanics quick reference

Each refactoring is a recipe of small steps that keep code working throughout.
Full catalog: https://refactoring.com/catalog/

## Extract Function
1. Create a new function named by *what it does*, not how.
2. Copy the extracted code in; pass needed variables as params.
3. Replace original code with a call. Compile + test.

## Inline Function / Inline Variable
Replace a call with the body (or a temp with its expression) when the indirection
adds no clarity. Compile + test after each.

## Rename (Variable/Function/Field)
Prefer the IDE "Rename Symbol" — it updates all references atomically. For dynamic
languages verify string/reflective references with tests.

## Introduce Parameter Object
Replace a recurring clump of arguments with a single object/type; update call
sites incrementally.

## Replace Conditional with Polymorphism
Move each branch of a repeated switch into a subclass/strategy implementing a
common interface; replace the switch with a dispatch.

## Replace Temp with Query
Turn a local variable computed from other data into a function so it can be reused
and the containing function shortened.

Rule: after EVERY numbered step, compile/type-check and run tests.
