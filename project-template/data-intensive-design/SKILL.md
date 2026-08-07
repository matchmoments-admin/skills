---
name: data-intensive-design
description: Applies Designing Data-Intensive Applications (Martin Kleppmann) to data and distributed-systems decisions — designing for reliability, scalability, and maintainability; choosing data models (relational/document/graph); reasoning about replication, partitioning, transactions, and consistency (strong vs eventual, CAP); schema evolution with backward/forward compatibility; idempotency; and batch vs stream processing. Use when designing databases/schemas, APIs and message formats, caching or replication, background jobs/queues, or when the user mentions consistency, scalability, data modeling, migrations, event streaming, or distributed data.
---

# Designing Data-Intensive Applications

Reasoning for the data and distributed layer. Software changes but the fundamental
principles don't: navigate the trade-offs rather than chasing tools. Pairs with
`software-architecture` (system trade-offs) and `clean-architecture` (keep the DB a detail).

## Three pillars (evaluate every data decision against these)
- **Reliability**: works correctly even under faults (hardware, software, and human
  error — the biggest cause of outages). Build tolerance: validate inputs, design for
  failure, make recovery easy, test failure paths, keep good observability.
- **Scalability**: describe load with concrete parameters (req/s, read/write ratio,
  data volume, fan-out) and performance with **percentiles (p95/p99), not averages**.
  Plan how the system copes as a load parameter grows.
- **Maintainability**: operability, simplicity (manage complexity), and evolvability
  (easy to change). This is where the other five skills reinforce this one.

## Data models
- Relational (SQL): great for many-to-many relations, joins, and strong constraints.
- Document (JSON): good for one-to-many tree data / locality / schema flexibility;
  weaker at many-to-many and joins.
- Graph: good when many-to-many relationships dominate (social, recommendations).
Choose by the shape of the data and access patterns, not by fashion. Avoid forcing a
document store where relationships are inherently relational.

## Schema evolution & encoding (critical for rolling deploys — and for agents)
Data outlives code. During a rolling deploy, old and new code run simultaneously, so
formats must be:
- **Backward compatible**: new code can read old data.
- **Forward compatible**: old code can read data written by new code.
Rules an agent must follow when changing schemas, DTOs, API payloads, or event formats:
- Add only optional/defaulted fields; don't remove or repurpose existing fields in place.
- Never change the meaning/type of an existing field or (for Protobuf/Avro) reuse a tag number.
- Do destructive changes as multi-step migrations (expand → migrate → contract), not one edit.
- Version event/message schemas; keep consumers tolerant of unknown fields.

```typescript
// Backward+forward-compatible change: add an OPTIONAL field with a default reader
type OrderV1 = { id: string; total: number };
type Order   = { id: string; total: number; currency?: string };  // new optional field
const currencyOf = (o: Order): string => o.currency ?? "USD";      // old data still readable
```

## Replication, partitioning, transactions, consistency
- **Replication**: single-leader (simple, read-scaling via async replicas, risk of stale
  reads/replication lag), multi-leader (multi-region/offline, needs conflict resolution),
  leaderless/quorum (high availability, tunable staleness). Async replication trades
  durability/consistency for latency.
- **Partitioning (sharding)**: spread data by key range or hash; beware hot spots and
  cross-partition transactions.
- **Consistency is a spectrum**: don't assume "the database handles it." Know when you
  need strong consistency / linearizability vs when eventual consistency is acceptable;
  CAP forces a choice between consistency and availability under partition. Use
  transactions/ACID where invariants must hold; design for read-your-writes where users
  expect to see their own updates.
- **Idempotency**: network calls can be retried and you can't tell if the first attempt
  landed — make writes idempotent (idempotency keys, upserts, dedup) so retries are safe.

## Batch vs stream processing
- **Batch**: bounded input, high throughput, periodic (reports, ETL, reindexing).
- **Stream**: unbounded events, low latency (notifications, real-time aggregates).
- Prefer **at-least-once + idempotent consumers**; exactly-once is expensive and often
  approximated. Treat an event log as a source of truth you can reprocess.

## Agent checklist
- [ ] Stated reliability/scalability/maintainability implications of the data choice
- [ ] Load described with parameters; latency measured by percentiles, not averages
- [ ] Data model matches the access patterns (relations vs tree vs graph)
- [ ] Schema/API/event change is backward- AND forward-compatible; migrations are multi-step
- [ ] Chosen the right consistency level; didn't assume the DB "just handles it"
- [ ] Writes and message consumers are idempotent (retries are safe)
- [ ] Correct batch vs stream choice; consumers tolerate at-least-once delivery

## References
- Martin Kleppmann, *Designing Data-Intensive Applications* (2017); 2nd ed. with
  Chris Riccomini (2025) — Ch. 1 Reliability/Scalability/Maintainability, Ch. 2 Data
  Models, Ch. 4/5 Encoding & Evolution, Ch. 5 Replication, Ch. 7 Transactions,
  Ch. 9 Consistency & Consensus, Ch. 10–11 Batch/Stream.
