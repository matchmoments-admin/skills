# SOLID with TypeScript + boundary patterns

## SRP — split reasons to change
```typescript
// Bad: two responsibilities
class Statistics { computeSalesStats() {} generateReport() {} }
// Good
class SalesStatistics { compute() {} }
class SalesReport { render(stats: SalesStatistics) {} }
```

## OCP — extend without modifying
```typescript
interface Shape { area(): number; }
class Circle implements Shape { constructor(private r: number){} area(){ return Math.PI*this.r**2; } }
class Square implements Shape { constructor(private s: number){} area(){ return this.s**2; } }
// Adding Triangle needs NO change to totalArea:
const totalArea = (shapes: Shape[]) => shapes.reduce((t, s) => t + s.area(), 0);
```

## LSP — honor the contract
A subtype must not strengthen preconditions or weaken postconditions. A `ReadOnlyList`
that throws on `add()` while claiming to be a `List` violates LSP.

## ISP — small interfaces
Split a fat `Machine { print; scan; fax }` into `Printer`, `Scanner`, `Fax` so a simple
printer implements only `Printer`.

## DIP — depend on abstractions
High-level `OrderService` depends on an `OrderRepository` interface; `MySQLOrderRepository`
implements it. Swapping databases doesn't touch `OrderService`.

## Boundary crossing (ports & adapters)
Define the interface (port) in the inner layer; implement (adapter) in the outer layer;
wire concrete implementations at the composition root (main/DI container). Flow of control
can point outward even while source dependencies point inward.

Source: R. C. Martin, *Clean Architecture*, Parts III–V.
