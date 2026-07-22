---
title: "Oracle health-state decision retrospective"
status: archived
owner: eng
canonical: false
archived: 2026-07-05
archived_reason: "Oracle health state shipped; only the durable event-versus-RPC decision rationale is retained here."
doc_type: plan
scope: repo-wide
review_interval_days: 365
garden_lane: notes-plans-archive
---

# Oracle health-state decision retrospective

> **Historical rationale, not current operating truth.** Follow the current
> indexer schema, handlers, package instructions, and dashboard source for exact
> behavior.

## Problem and decision

Oracle monitoring needed both a price history and a useful view of pool health.
Neither an event-only nor an RPC-only design was sufficient:

- `SortedOracles` events provide deterministic report lineage, but the passage
  of time can make a rate stale without emitting another event.
- Pool-activity reads can capture the contract's view of rebalancing state, but
  a quiet pool cannot provide a complete oracle timeline or independent
  liveness signal.

The implementation therefore started from a hybrid boundary: index oracle
events for history and combine them with guarded, block-aware pool-state reads
or derivation where event data alone is insufficient. The important retained
lesson is the boundary, not the original field list or handler recipe: oracle
history, current pool state, and time-based liveness answer different questions
and must not be collapsed into one stale cached value.

## Outcome and current owners

The original schema checklist, threshold examples, network assumptions, and UI
file plan were removed because they diverged from the shipped system. Current
behavior is owned by:

- [`indexer-envio/schema.graphql`](../indexer-envio/schema.graphql) for the data
  contract;
- [`indexer-envio/src/handlers/sortedOracles.ts`](../indexer-envio/src/handlers/sortedOracles.ts),
  [`indexer-envio/src/handlers/fpmm/`](../indexer-envio/src/handlers/fpmm/), and
  [`indexer-envio/src/rpc/effects.ts`](../indexer-envio/src/rpc/effects.ts) for
  event lineage, pool-state updates, and block-aware effects; and
- [`ui-dashboard/src/components/health-panel.tsx`](../ui-dashboard/src/components/health-panel.tsx)
  plus the pool oracle tab for presentation and degraded-state behavior.

Any future change to this boundary should be recorded as an ADR if it constrains
the architecture; this retrospective should not be expanded back into a live
implementation plan.
