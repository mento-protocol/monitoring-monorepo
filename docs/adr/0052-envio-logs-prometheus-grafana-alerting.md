---
title: Envio logs diagnose; Prometheus and Grafana alert
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
scope: indexer-envio / alerts
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
supersedes: ADR-0018
---

# ADR 0052 — Envio logs diagnose; Prometheus and Grafana alert

**Status:** Accepted (Jul 2026), in force. Supersedes
[ADR 0018](0018-indexer-observability-loki.md).
**Scope:** indexer-envio / alerts

## Context

The hosted indexer emits structured `context.log.error` events and Envio Cloud
retains commit-scoped runtime logs. ADR 0018 expected Envio logs to reach Loki
and drive Grafana alerting. Repository inspection found no Loki ingestion,
LogQL rule, indexer log dashboard, or indexer Loki rule. Read-only Grafana
inspection on 2026-07-26 found no Loki labels over the preceding 30 days and
no Envio/Indexer dashboard. The existing `Envio Effect Cache Invalidations`
rule is Prometheus-backed.

Envio Cloud logs remain useful evidence, including runtime failures and
restarts on the active deployment. They are not a repository-owned paging
transport.

## Decision

- Envio Cloud logs are a **commit-scoped diagnostic surface**. Operators pin a
  deployment commit and use
  `pnpm deploy:indexer:logs "$COMMIT" --errors-only --since 2h` for entries
  Envio explicitly marks as errors. The provider's
  `--level error` option alone can include stdout-carried records and is not an
  exact error-only view.
- Prometheus metrics and Grafana rules are the only repository-owned indexer
  alerting plane. An event that requires warning or paging must expose an
  owned metric and have a Grafana rule with severity and routing. A
  `context.log.error` event alone creates no alert.
- Handlers continue to use structured `<area>.<event>` names. Do not add Sentry
  to the hosted indexer.
- Current structured error families are diagnostic-only:

  | Family                                       | Source                             | Classification                                                                                                  |
  | -------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
  | `sortedOracles.oracleExpiryStateUnavailable` | `handlers/oracleExpiryState.ts`    | Diagnostic-only; no metric/rule tracks bootstrap failure.                                                       |
  | `sortedOracles.oracleFeedStateUnavailable`   | `handlers/oracleFeedState.ts`      | Diagnostic-only; existing oracle-freshness rules detect resulting stale pool state, not this bootstrap failure. |
  | `liquity.systemParams.deadContract`          | `handlers/liquity/systemParams.ts` | Diagnostic-only; CDP gauges are withheld until parameters load and no rule detects this configuration failure.  |
  | `liquity.systemParams.diagnosticFailed`      | `handlers/liquity/systemParams.ts` | Diagnostic-only; no metric/rule tracks diagnostic-RPC failure.                                                  |

  `envio_effect_cache_invalidations_count` is separately represented by the
  Prometheus-backed `Envio Effect Cache Invalidations` Grafana rule; it is not
  emitted by one of the structured handler error families above.

## Alternatives considered

- **Restore Loki ingestion and LogQL alerting** — rejected: no repository-owned
  ingestion or rule exists, and it would create a second alerting plane.
- **Treat Envio error logs as alerts** — rejected: queried logs have no owned
  rule, severity, routing, or delivery guarantee.
- **Add Sentry to the indexer** — rejected: the hosted runtime does not need a
  second application-error integration when Prometheus/Grafana owns alerts.

## Consequences

- The four diagnostic-only families need a separate owned-metric/rule decision
  before they can notify operators. [Issue #1624](https://github.com/mento-protocol/monitoring-monorepo/issues/1624)
  owns that work; this ADR does not claim alert coverage for them.
- Existing operators use status and metrics to assess deployment health, then
  inspect the exact deployment's bounded error logs. A deployment is not
  healthy merely because a log query returns data or no error records.
- Any future log shipper, Loki rule, dashboard, Sentry integration, or new
  indexer alert metric is a separate architecture and implementation change.

## Evidence

- Active Envio production deployment `b5d14b7` was `prod` on 2026-07-26.
  `pnpm deploy:indexer:status b5d14b7 --json` and
  `pnpm deploy:indexer:metrics b5d14b7 --json` showed each configured chain
  caught up.
- `pnpm deploy:indexer:logs b5d14b7 --level error --since 7d --limit 100 --json`
  returned stdout records as well as explicit error records.
  `--errors-only` preserves that provider-side narrowing and then locally keeps
  only `level: error` or an `error` object. The wrapper fixes this mode at
  Envio's maximum 100-record page size and fails closed when that page is full;
  narrow `--since` and retry instead of treating a capped result as clean.
- Live Grafana checks found the `grafanacloud-logs` and `grafanacloud-prom`
  datasources healthy, zero Loki labels over 2026-06-27 through 2026-07-26,
  no Envio or Indexer dashboard, and the normal `Envio Effect Cache
Invalidations` rule with `service=indexer` and `severity=warning`.
- `alerts/rules/rules-indexer.tf` defines the Prometheus-backed effect-cache
  invalidation rule. Oracle freshness rules consume `mento_pool_oracle_*`
  metrics in `alerts/rules/rules-fpmms.tf` and `rules-vp-oracles.tf`.
- [Issue #1561](https://github.com/mento-protocol/monitoring-monorepo/issues/1561)
  is the task record for this supersession.
