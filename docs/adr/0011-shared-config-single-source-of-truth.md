---
title: shared-config is the single source of truth for chain and token metadata
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: shared-config
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0011 — `shared-config` is the single source of truth for chain/token metadata

**Status:** Accepted (Mar 2026), in force.
**Scope:** shared-config

## Context

Chain slugs, explorer URLs, treb deployment namespaces, and token-symbol
derivation are needed by the dashboard, indexer, and metrics-bridge alike. When
each package carried its own copy, they drifted — a renamed token or a new chain
had to be fixed in several places, and some were missed.

## Decision

`@mento-protocol/config` (`shared-config/`) is the **single source of
truth** for chain metadata, deployment namespaces, token/pool label derivation,
the FX calendar, thresholds, and shared ABIs. In-repo consumers resolve it
through `workspace:*`; external consumers use the public npm package. Consumer
runtime network entries may carry endpoint, local-routing, and availability
overrides; namespaces, explorer metadata, and token/pool label maps come from
this package.

## Alternatives considered

- **Per-package copies** — rejected: guaranteed drift; the bug that motivated this.
- **A remote config service** — rejected: this is static build-time metadata; a
  versioned package is simpler and works both inside and outside this repo.

## Consequences

- Exported shapes are a change surface: dashboard, indexer, and bridge typechecks
  are part of any `shared-config` change, and config edits need a cross-reference test.
- `shared-config` stays low-dependency because it is imported into client bundles.
- The indexer is the **one** sanctioned exception: it vendors a mirror because Envio
  builds it outside the pnpm workspace and has not yet moved to the public package
  as an explicit registry dependency (ADR 0013).

## Evidence

- Namespace extraction `204dd1ab` and contracts-package adoption `a77979d0`
  (2026-03); current consumer routing in
  [`ui-dashboard/src/lib/networks.ts`](../../ui-dashboard/src/lib/networks.ts).
- [`shared-config/AGENTS.md`](../../shared-config/AGENTS.md).
