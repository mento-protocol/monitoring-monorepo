---
title: Fixture-driven browser tests, visual snapshots, and a react-doctor score gate
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
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

- **Fixture-driven Playwright browser tests** exercise real interactions and
  deliberate **visual snapshots**. `test:browser` serves a cached fixture
  production build from `.next-fixture` with `next start`;
  `test:browser:production` forces a fresh fixture build. The fixture GraphQL
  server uses fixed port 3211, while the Next port is assigned at runtime.
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
- Turbo caches the fixture build separately and keeps the fixture and normal
  `.next` build outputs isolated.

## Evidence

- Browser interaction suite PR #403 (2026-05-13); react-doctor PR-diff gate
  PR #367 (2026-05-09); cached fixture build `b3bb9e81` (2026-07-22).
- Current runner in
  [`ui-dashboard/scripts/run-browser-tests.mjs`](../../ui-dashboard/scripts/run-browser-tests.mjs),
  Turbo dependency in [`turbo.json`](../../turbo.json), and commands/gates in
  [`docs/notes/dashboard-verification.md`](../notes/dashboard-verification.md).
