---
title: Cross-layer and stateful changes must run dedicated PR checklists
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ci/process
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0008 — Cross-layer / stateful changes must run dedicated PR checklists

**Status:** Accepted (May 2026), in force.
**Scope:** ci/process

## Context

The repo repeatedly burned review cycles on the same failure class: a change to
the Envio schema, an entity writer, generated types, or paginated/sortable UI
state would ship without defining its invariants or degraded-mode behavior, and
the query→UI layer was assumed to "just catch up". Reviews were being asked to
_define_ the design instead of catch misses.

## Decision

Any change touching stateful data flow across layers (schema/entities, handlers,
generated types/queries, paginated or sortable UI state, partial-failure behavior)
**must run the dedicated PR checklist before opening or updating the PR** — chiefly
[`docs/pr-checklists/stateful-data-ui.md`](../pr-checklists/stateful-data-ui.md).
Invariants, degraded-mode behavior, and interaction tests are authored up front,
not discovered in review.

## Alternatives considered

- **Rely on reviewers to catch these** — rejected: that makes review define the
  invariants for the first time, which is exactly what kept failing.
- **One giant root rule** — rejected: hazard-specific checklists are actionable;
  a wall of prose is not.

## Consequences

- Checklists are canonical context (ADR 0005); package `AGENTS.md` files hard-link
  to the relevant one and mark it mandatory.
- Recurring automated-review hazards are canonicalized so bots don't re-litigate
  settled patterns.

## Evidence

- [`docs/pr-checklists/stateful-data-ui.md`](../pr-checklists/stateful-data-ui.md), [`docs/pr-checklists/recurring-review-patterns.md`](../pr-checklists/recurring-review-patterns.md).
- Enforced from [`AGENTS.md`](../../AGENTS.md) and each package `AGENTS.md` "Before Opening PRs" section.
