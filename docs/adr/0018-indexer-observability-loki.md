---
title: Indexer observability contract requires structured logs and a verified error-log path
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: indexer-envio
date: 2026-04
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0018 — Indexer observability requires structured logs and a verified error-log path

**Status:** Accepted (2026); contract in force, delivery path unverified.
**Scope:** indexer-envio

**Verification gap (2026-07-23):** Repository and live Grafana checks did not
find evidence of the originally selected Loki ingestion, labels, dashboard, or
alert rule. This ADR records the required observability contract and its
historical implementation choice; it does not establish that an error-log alert
path is operational. Owner decision and remediation are tracked in
[#1561](https://github.com/mento-protocol/monitoring-monorepo/issues/1561).

## Context

The indexer runs on Envio's hosted platform, where we don't control the process to
install a Sentry SDK the way we do for the dashboard or the alert Cloud Functions.
We still need to see handler errors and act on them.

## Decision

The accepted contract requires **structured error logging** plus a verified
alert path. Handlers emit `context.log.error` with an `<area>.<event>`
convention. The original implementation choice routed Envio logs to Loki, then
used Grafana queries and deduplication for alerting; it did not add Sentry to
the indexer.

Current evidence proves the logging convention and absence of Sentry, but not
the Loki/Grafana delivery path. Until issue #1561 is resolved, do not describe
that path as operational.

## Alternatives considered

- **Sentry in the indexer** — rejected: it did not fit the hosted Envio runtime;
  the selected log→Loki→Grafana path was expected to integrate with the metric
  plane.
- **Silent failures + downstream data checks** — rejected: too slow and indirect;
  structured error logs give a first-class signal.

## Consequences

- Error visibility depends on log discipline: use the `<area>.<event>` naming so
  the eventual alert path can group errors consistently.
- Error-log alerting is not proven operational. Issue #1561 must either restore
  and verify the selected path or approve a superseding observability decision.

## Evidence

- Indexer logging convention and current operator commands in
  [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md); Sentry is used
  only by the dashboard and `alerts/infra` (ADR 0004).
- Re-verification gap and current live evidence:
  [issue #1561](https://github.com/mento-protocol/monitoring-monorepo/issues/1561).
