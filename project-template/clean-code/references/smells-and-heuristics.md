# Clean Code — Smells & Heuristics (Chapter 17 quick reference)

Read this when doing a thorough review or cleanup. Grouped selection of the
heuristics most useful to an agent.

## Comments
- C1 Inappropriate information; C2 Obsolete comment; C3 Redundant comment;
  C5 Commented-out code (delete it).

## Functions
- F1 Too many arguments; F2 Output arguments (avoid); F3 Flag arguments; F4 Dead function.

## General
- G5 Duplication (the root evil — DRY); G6 Code at wrong level of abstraction;
- G23 Prefer polymorphism to if/else and switch/case;
- G28 Encapsulate conditionals; G30 Functions should do one thing;
- G20 Function names should say what they do; G25 replace magic numbers with named constants.

## Names
- N1 Choose descriptive names; N2 names at the appropriate level of abstraction;
- N4 unambiguous names; N7 names should describe side effects.

## Tests
- T1 Insufficient tests; T2 use a coverage tool; T3 don't skip trivial tests;
- T5 test boundary conditions; T9 tests should be fast.

Source: Robert C. Martin, *Clean Code*, Chapter 17.
