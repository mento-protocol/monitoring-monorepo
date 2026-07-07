---
title: Plotly.js basic-dist plus enforced bundle-size budgets
status: active
owner: eng
canonical: true
last_verified: 2026-07-07
scope: ui-dashboard
date: 2026-03
---

# ADR 0024 — Plotly.js `basic-dist` + enforced bundle-size budgets

**Status:** Accepted (2026), in force.
**Scope:** ui-dashboard

## Context

Plotly is a heavy charting library and the dashboard ships a lot of charts. The
full Plotly distribution is large and includes trace types (e.g. `scattergl`/WebGL)
the dashboard doesn't use. Unbudgeted, the chart layer silently bloats the bundle.

## Decision

Use Plotly's **`basic-dist`** build (no `scattergl`/WebGL traces) and enforce
**bundle-size budgets** via `pnpm dashboard:size-limit` after build. Charts render
through `react-plotly`, and observed chart lag is treated as JS/main-thread work,
not GPU paint.

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
- `size-limit` runs against the built `.next`, so per-PR worktrees must build before
  the size check can find output.

## Evidence

- Plotly present since initial setup `6e001aac`; `basic-dist` + `size-limit` budgets in [`ui-dashboard/AGENTS.md`](../../ui-dashboard/AGENTS.md) and `ui-dashboard` size-limit config.
