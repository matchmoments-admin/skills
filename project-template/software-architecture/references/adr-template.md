# ADR template (Michael Nygard format)

Store as `docs/adr/NNNN-short-title.md`. Number monotonically; never reuse numbers.
Once Accepted, do not edit — create a new ADR that supersedes it.

```markdown
# ADR NNNN: <short noun phrase>

Date: YYYY-MM-DD
Status: Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context
The forces at play, in neutral language: business drivers, constraints, the
prioritized architecture characteristics, and the alternatives considered.

## Decision
The choice made, stated actively: "We will …". Emphasize the WHY.

## Consequences
What becomes easier and what becomes harder as a result — positive, negative,
and neutral outcomes; follow-up decisions this triggers.

## Compliance (Richards & Ford addition)
How this decision is verified/governed — e.g., the fitness function or CI check
that enforces it, if any.
```
