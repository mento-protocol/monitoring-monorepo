---
title: Indexer observability is structured logs to Loki and Grafana, not Sentry
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: indexer-envio
date: 2026-04
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0018 — Indexer observability is structured logs → Loki → Grafana, not Sentry

**Status:** Accepted (2026), in force.
**Scope:** indexer-envio

## Context

The indexer runs on Envio's hosted platform, where we don't control the process to
install a Sentry SDK the way we do for the dashboard or the alert Cloud Functions.
We still need to see handler errors and act on them.

## Decision

Indexer observability is **structured logging**: handlers emit
`context.log.error` with an `<area>.<event>` convention; Envio ships those to Loki,
and Grafana queries/deduplicates them for alerting. There is **no Sentry** in the
indexer.

## Alternatives considered

- **Sentry in the indexer** — rejected: doesn't fit the hosted Envio runtime; the
  log→Loki→Grafana path is already available and integrates with the metric plane.
- **Silent failures + downstream data checks** — rejected: too slow and indirect;
  structured error logs give a first-class signal.

## Consequences

- Error visibility depends on log discipline: use the `<area>.<event>` naming so
  Grafana dedup/queries work.
- This keeps the indexer's alerting inside the Grafana plane (ADR 0004) rather than
  introducing a second error backend.

## Evidence

- Indexer logging convention and Loki/Grafana path documented in [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md); Sentry is used only by the dashboard and `alerts/infra` (ADR 0004).
