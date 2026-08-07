---
name: clean-architecture
description: Applies Clean Architecture (Robert C. Martin) and SOLID principles to structure code — the Dependency Rule (source dependencies point inward toward business rules), separating entities and use cases from frameworks/DB/UI (frameworks are details), drawing boundaries with dependency inversion, and keeping business logic testable without infrastructure. Use when designing modules/services, organizing a codebase, deciding where logic belongs, introducing interfaces/ports, reviewing coupling to frameworks, or when the user mentions SOLID, layers, boundaries, dependency injection, hexagonal/onion architecture, or use cases.
---

# Clean Architecture

Keep business rules independent of frameworks, UI, and databases so the things
that change most often cannot drag down the things that matter most. Operates at
the module/component level; for system-wide trade-offs and ADRs use
`software-architecture`, and for data/distributed concerns use `data-intensive-design`.

## The Dependency Rule (the one rule to always keep)
Source-code dependencies point **inward**, toward higher-level policy. Inner
layers know nothing about outer layers.
- **Entities** (enterprise business rules) — innermost, pure, no imports of frameworks.
- **Use cases** (application-specific rules) — orchestrate entities; depend only on entities.
- **Interface adapters** — controllers, presenters, gateways/repositories; translate
  between use cases and the outside.
- **Frameworks & drivers** — DB, web framework, UI, external APIs — outermost. "The web
  is a detail. The database is a detail." Keep them where they can do little harm.

To let an inner layer invoke an outer capability without depending on it, define an
interface (a "port") in the inner layer and implement it outside (Dependency Inversion).

```typescript
// Domain (inner) defines the port — no DB import here
export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: OrderId): Promise<Order | null>;
}
// Use case depends on the abstraction only
export class PlaceOrder {
  constructor(private readonly orders: OrderRepository) {}
  async execute(cmd: PlaceOrderCommand): Promise<void> {
    const order = Order.create(cmd);      // entity business rule
    await this.orders.save(order);
  }
}
// Infrastructure (outer) implements the port — depends inward
export class PrismaOrderRepository implements OrderRepository {
  async save(order: Order): Promise<void> { /* Prisma/SQL here */ }
  async findById(id: OrderId): Promise<Order | null> { /* ... */ }
}
```
The use case can be unit-tested with an in-memory fake — no DB, HTTP, or framework.

## SOLID (the mechanism)
- **S — Single Responsibility**: a module has one reason to change (one actor). Split
  classes that mix, e.g., report generation and persistence.
- **O — Open/Closed**: add behavior by adding code (new implementation of an interface),
  not by editing existing code.
- **L — Liskov Substitution**: any implementation must be usable wherever its interface
  is expected, honoring the contract.
- **I — Interface Segregation**: many small, client-specific interfaces beat one fat one;
  don't force clients to depend on methods they don't use.
- **D — Dependency Inversion**: depend on abstractions, not concretions; high-level policy
  must not import low-level detail.
SOLID is one philosophy seen from five angles: SRP says where to draw boundaries, ISP how
small the contracts are, DIP which way dependencies point, OCP the benefit, LSP keeps
abstractions honest. Details and TS examples: [references/solid-and-boundaries.md](references/solid-and-boundaries.md).

## Screaming Architecture & structure
Top-level folders should shout the domain (`orders/`, `billing/`), not the framework
(`controllers/`, `models/`). Organize by feature/use case, then layer within.

## Pragmatic cautions (avoid dogma)
- More layers = more files and indirection. Apply boundaries where change is likely,
  not everywhere. An interface with exactly one implementation that will never change
  can be ceremony — introduce ports at volatility boundaries (DB, external APIs, UI).
- Don't map DTOs through five layers for a trivial CRUD screen.
- For agents: don't invent elaborate hexagonal scaffolding for a small feature; match the
  architecture to the actual need and the existing project conventions.

## Agent design checklist
- [ ] Business rules (entities/use cases) import no framework/DB/UI code
- [ ] Dependencies point inward; outer layers implement inner interfaces (ports)
- [ ] Each module has one reason to change (SRP); interfaces are small (ISP)
- [ ] New behavior added via new implementations, not edits to stable code (OCP)
- [ ] Use cases are unit-testable with fakes (no DB/HTTP needed)
- [ ] Folder structure reflects the domain, not the framework
- [ ] Boundaries introduced at real volatility points, not everywhere (no over-engineering)

## References
- Robert C. Martin, *Clean Architecture: A Craftsman's Guide to Software Structure and Design* (2017).
- blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html.
