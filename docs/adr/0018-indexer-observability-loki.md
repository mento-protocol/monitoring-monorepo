---
title: Indexer observability contract requires structured logs and a verified error-log path
status: archived
owner: eng
canonical: true
last_verified: 2026-07-26
superseded_by: ADR-0052
scope: indexer-envio
date: 2026-04
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0018 — Indexer observability requires structured logs and a verified error-log path

**Status:** Superseded by [ADR 0052](0052-envio-logs-prometheus-grafana-alerting.md)
(Jul 2026). Historical decision retained.
**Scope:** indexer-envio

**Historical outcome:** The structured logging convention landed, but the
selected Envio-to-Loki alert path never became repository-owned or operational.
ADR 0052 defines the replacement operator and alerting contract.

## Context

The indexer runs on Envio's hosted platform, where we don't control the process to
install a Sentry SDK the way we do for the dashboard or the alert Cloud Functions.
We still need to see handler errors and act on them.

## Decision

The accepted contract required **structured error logging** plus a verified
alert path. Handlers emit `context.log.error` with an `<area>.<event>`
convention. The original implementation choice routed Envio logs to Loki, then
used Grafana queries and deduplication for alerting; it did not add Sentry to
the indexer.

## Alternatives considered

- **Sentry in the indexer** — rejected: it did not fit the hosted Envio runtime;
  the selected log→Loki→Grafana path was expected to integrate with the metric
  plane.
- **Silent failures + downstream data checks** — rejected: too slow and indirect;
  structured error logs give a first-class signal.

## Consequences

- Error visibility depends on log discipline: use the `<area>.<event>` naming so
  commit-scoped diagnostics remain searchable.
- The original Loki delivery path is not an operational contract. Follow ADR
  0052 for alerting and operator commands.

## Evidence

- Indexer logging convention in
  [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md); Sentry is used
  only by the dashboard and `alerts/infra` (ADR 0004).
- Superseding evidence and current contract: [ADR 0052](0052-envio-logs-prometheus-grafana-alerting.md).
