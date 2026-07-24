---
title: Plotly.js basic-dist-min plus enforced bundle-size budgets
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: ui-dashboard
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0024 — Plotly.js `basic-dist-min` + enforced bundle-size budgets

**Status:** Accepted (2026), in force.
**Scope:** ui-dashboard

## Context

Plotly is a heavy charting library and the dashboard ships a lot of charts. The
full Plotly distribution is large and includes trace types (e.g. `scattergl`/WebGL)
the dashboard doesn't use. Unbudgeted, the chart layer silently bloats the bundle.

## Decision

Use Plotly's minified **`basic-dist-min`** build (no `scattergl`/WebGL traces)
and enforce **bundle-size budgets** with `pnpm dashboard:size-limit`. The
quality gate runs the size task through Turbo, where it depends on the
dashboard build. Charts render through the shared
`@/lib/react-plotly-basic` factory.

The dashboard intentionally satisfies `react-plotly.js`'s `plotly.js` peer with
the package alias `plotly.js@npm:plotly.js-basic-dist-min`. Do not replace that
alias with the full `plotly.js` package unless this ADR is revisited: pnpm would
otherwise install the unused full Plotly dependency tree even though chart code
imports the lean bundle through `react-plotly.js/factory`.

## Alternatives considered

- **Full `plotly.js` dist** — rejected: ships trace types we don't use and blows the
  size budget.
- **A lighter charting library** — rejected: Plotly's feature set fits the analytics
  needs; the fix is trimming the dist and budgeting size, not switching libraries.

## Consequences

- Anything needing a WebGL trace type would require reconsidering the dist and its
  size impact — not a silent import.
- `size-limit` reads the built `.next`; direct invocations need a fresh
  `pnpm dashboard:build`, while the quality-gate Turbo task builds first.

## Evidence

- Plotly present since initial setup `6e001aac`; current package alias in
  [`ui-dashboard/package.json`](../../ui-dashboard/package.json), factory in
  [`ui-dashboard/src/lib/react-plotly-basic.tsx`](../../ui-dashboard/src/lib/react-plotly-basic.tsx),
  and manifest-backed budgets in
  [`ui-dashboard/.size-limit.cjs`](../../ui-dashboard/.size-limit.cjs).
