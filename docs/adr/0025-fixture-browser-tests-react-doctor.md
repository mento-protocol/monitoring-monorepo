---
title: Fixture-driven browser tests, visual snapshots, and a react-doctor score gate
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ui-dashboard
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0025 — Fixture-driven browser tests + visual snapshots + a react-doctor score gate

**Status:** Accepted (May 2026), in force.
**Scope:** ui-dashboard

## Context

Dashboard regressions are usually interaction and rendering bugs — a chart that
stops wiring to table state, a control that breaks under a session, a layout that
shifts — which unit tests over pure functions never catch. We also kept re-shipping
the same React anti-patterns.

## Decision

Two gates:

- **Fixture-driven Playwright browser tests** (`test:browser`, plus a build-backed
  `test:browser:production`) exercise real interactions, with **visual snapshots**
  re-baselined only on a deliberate UI change.
- **react-doctor** runs as a **score gate** (must end at 100) plus a per-PR diff gate
  (`react-doctor:diff`) wired into the local quality gate and CI.

## Alternatives considered

- **Unit tests only** — rejected: they don't observe rendering/interaction, which is
  where dashboard bugs live.
- **Manual UI review only** — rejected: doesn't scale and misses visual regressions;
  snapshots make them mechanical.

## Consequences

- The diff gate scans whole touched files, so pre-existing warnings in a file you
  edit can block the PR — fix or scope them.
- Browser tests have a small flake rate; warm the Turbo cache so the pre-push gate
  cache-hits rather than re-running them.

## Evidence

- Browser interaction suite PR #403 (2026-05-13); react-doctor PR-diff gate PR #367 (2026-05-09).
- Commands + gates in [`ui-dashboard/AGENTS.md`](../../ui-dashboard/AGENTS.md); [`docs/pr-checklists/stateful-data-ui.md`](../pr-checklists/stateful-data-ui.md).
