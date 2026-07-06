---
title: Read model is SWR polling plus client-side aggregation at current pool scale
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ui-dashboard
date: 2026-03
---

# ADR 0020 — Read model: SWR polling + client-side aggregation at current pool scale

**Status:** Accepted (Mar 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard needs near-real-time data from Hasura. Two questions: how to keep it
fresh, and how to compute the 24h volume tiles/table. Live subscriptions add a
stateful transport; server-side aggregation runs into the no-`_aggregate` rule
(ADR 0014).

## Decision

Use **SWR polling** against Hasura for freshness (simple request/refetch, no
websocket transport), and **aggregate the 24h volume view client-side** from
snapshot queries. At the current scale (~30–50 pools) this is explicitly acceptable
and is a documented review exclusion — reviewers must **not** flag it as a
scalability bug unless the assumptions change materially.

## Alternatives considered

- **GraphQL subscriptions / websockets** — rejected: adds a stateful transport and
  reconnection logic for data that polling refreshes fine.
- **Server-side `_aggregate`** — rejected by ADR 0014; unbounded query cost.

## Consequences

- The scale assumption is the load-bearing caveat: if pools grow a lot, polling
  frequency rises, or latency/cost regresses, revisit and likely move aggregation to
  snapshot entities.
- Polling discipline (intervals, dedupe) is a review surface for stateful UI changes.

## Evidence

- Polling discipline in [`docs/pr-checklists/swr-polling-hasura.md`](../pr-checklists/swr-polling-hasura.md); the 30–50-pool exclusion in [`docs/pr-checklists/review-prompt-exclusions.md`](../pr-checklists/review-prompt-exclusions.md) and [`AGENTS.md`](../../AGENTS.md).
