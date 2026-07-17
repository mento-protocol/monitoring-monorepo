---
title: Integration probes are quote-only, evidence-gated, and TTL-degraded
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: integration-probes
date: 2026-06
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0032 — Integration probes are quote-only, evidence-gated, and TTL-degraded

**Status:** Accepted (Jun 2026), in force.
**Scope:** integration-probes

## Context

The `/integrations` page shows whether third-party aggregators and cross-chain
routers can actually route through Mento v3. Verifying this by executing swaps would
cost real money and risk funds; trusting an aggregator's self-reported source label
would produce false "supported" claims.

## Decision

Probes are **quote-only** (read-only): they request quotes and **only mark a route
`pass` on hard evidence** — a `Routerv300` or a registered v3 pool/VirtualPool
address in the response — never from a source label alone. Missing credentials return
`needs_key` (not `fail`); unsupported chains return `unsupported`. The latest snapshot
is published to Upstash (`integration-probes:latest`) and **expires after 3 days**, so
a broken scheduled run degrades the dashboard to stale/missing instead of showing
false-green health forever.

## Alternatives considered

- **Funded canary swaps** — rejected: costs money and risks funds; explicitly requires
  a new design review before adding.
- **Trust aggregator source labels** — rejected: produces false positives; evidence is
  the only thing that proves a real Mento route.

## Consequences

- Quote attempts and error retries are capped so an aggregator outage can't exhaust an
  API quota or starve the scheduled writer before it publishes degraded results.
- Adapter credentials are Terraform-managed and optional; the probe fails soft.

## Evidence

- Integration probes added PR #728 (2026-06-02); pass/degradation rules in [`integration-probes/AGENTS.md`](../../integration-probes/AGENTS.md); snapshot wiring in [`docs/deployment.md`](../deployment.md) §Aggregator Integration Probes.
