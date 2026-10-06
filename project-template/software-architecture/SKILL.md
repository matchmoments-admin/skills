---
name: software-architecture
description: Applies Fundamentals of Software Architecture (Richards & Ford) for system-level decisions — identifying and prioritizing architecture characteristics ("-ilities"), analyzing trade-offs (there are no right answers, only trade-offs), choosing an architecture style (layered, modular monolith, microservices, event-driven), writing Architecture Decision Records (ADRs), and governing with automated fitness functions. Use when designing a new service/system, choosing between architectures, documenting a significant technical decision, setting up architectural governance in CI, or when the user mentions architecture characteristics, trade-offs, ADRs, fitness functions, scalability, or coupling.
---

# Software Architecture (Fundamentals)

System-level reasoning above individual modules. Where `clean-architecture`
governs boundaries inside a codebase, this skill governs *which* structure to
choose, *why*, and how to keep it honest over time.

## First law of software architecture
"Everything in software architecture is a trade-off." There are no "best"
architectures, only ones better or worse suited to specific prioritized concerns.
Always present options with their trade-offs rather than asserting one right answer.

## Architecture characteristics (the "-ilities")
Explicitly identify and PRIORITIZE the non-functional requirements that shape the
design. Choose the driving few (a system can't be great at all of them):
- Operational: performance, scalability, elasticity, availability, reliability, recoverability.
- Structural: maintainability, testability, deployability, modularity, configurability.
- Cross-cutting: security, observability, accessibility, usability.
Rank them; make the ranking explicit; design and evaluate against the top ~3.

## Trade-off analysis (how to reason)
1. State the decision and the driving characteristics.
2. List realistic options.
3. For each, list pros/cons *in terms of the prioritized characteristics*.
4. Note coupling/connascence impact and the "architectural quantum" (independently
   deployable unit with high functional cohesion).
5. Recommend, and record it as an ADR.

Example: modular monolith vs microservices — microservices buy independent
deployability/scalability at the cost of operational complexity, network failure
modes, and data consistency challenges (see `data-intensive-design`). For a small
team/product, a modular monolith usually wins until scale forces the split.

## Architecture Decision Records (ADRs)
Record every architecturally significant decision (affects structure, non-functional
characteristics, dependencies, or interfaces) as a short immutable file in the repo
(`docs/adr/NNNN-title.md`), Michael Nygard format: **Title, Status, Context,
Decision, Consequences** (Richards & Ford add a **Compliance** section stating how a
fitness function will verify it). Once Accepted, don't edit — supersede with a new ADR.
Template: [references/adr-template.md](references/adr-template.md).

For agent-driven projects: whenever you make a non-obvious structural choice
(pick a DB, a state-management approach, a module boundary, a queue), WRITE an ADR
so the "why" survives — undocumented agent decisions create code no one dares change.

## Fitness functions (automated governance)
A fitness function is an objective test of an architecture characteristic. Encode
architectural rules as automated checks in CI so they can't silently erode:
- Dependency/layer rules (e.g., domain must not import infrastructure) via ESLint
  `no-restricted-imports`, dependency-cruiser, or ArchUnit-style tools.
- Performance budgets (p99 latency, bundle size) as CI gates.
- Coupling/cyclomatic-complexity thresholds; cyclic-dependency detection.
- Test coverage of the domain layer.

```json
// Example: dependency-cruiser fitness function (domain must not depend on infra)
{ "forbidden": [{
  "name": "no-domain-to-infra",
  "from": { "path": "^src/domain" },
  "to":   { "path": "^src/infrastructure" }
}]}
```

## Agent checklist
- [ ] Identified and ranked the top ~3 architecture characteristics
- [ ] Presented options as trade-offs against those characteristics (no "one right answer")
- [ ] Chose the simplest style that meets the drivers (didn't reach for microservices by default)
- [ ] Wrote/updated an ADR for each significant decision (Nygard format, immutable)
- [ ] Added or referenced a fitness function in CI to enforce the decision

## References
- Mark Richards & Neal Ford, *Fundamentals of Software Architecture*, 2nd ed. (2020/2024).
- Michael Nygard, "Documenting Architecture Decisions" (2011); adr.github.io.
- Ford, Parsons, Kua, *Building Evolutionary Architectures* (fitness functions).
