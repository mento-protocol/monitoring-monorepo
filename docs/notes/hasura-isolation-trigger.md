---
title: Hasura isolation trigger
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Hasura isolation trigger

This records when public dashboard traffic and the alerting pipeline must stop
sharing one hosted Hasura backend. It does not build a cache, replica, proxy, or
new Envio endpoint now.

## Topology

The public dashboard allows browser GraphQL calls to `indexer.hyperindex.xyz`
through `ui-dashboard/src/lib/csp.ts` and polls through `useGQL` every 30s. A
single pool page fans out roughly 15-20 parallel GraphQL hooks
(`ui-dashboard/src/lib/graphql.ts`).

The primary `metrics-bridge` loop polls `HASURA_URL` every 30s by default
(`metrics-bridge/src/config.ts` and `metrics-bridge/src/env.ts`) and exports the
gauges that back Grafana alerts. The isolated peg loop also uses `HASURA_URL`:
once `PEG_POLICY_URL` activates it, every 15s cycle issues one bounded
Pool/TradingLimit/BreakerConfig/SwapEvent companion query per registry monitor,
with at most eight BreakerConfig rows and 1,000 SwapEvent rows per query
(`metrics-bridge/src/peg/runtime.ts` and
`metrics-bridge/src/peg/graphql.ts`). It remains dormant while the protected
policy artifact is absent. Both bridge paths share the same hosted endpoint as
the public dashboard, even though peg failures never gate `/health`.

Envio's small tier has returned HTTP 429 `"Tier Quota"` without `Retry-After`
when the shared monthly endpoint quota is exhausted
(`ui-dashboard/src/lib/gql-retry.ts`). The dashboard recognizes that response
body and backs off. The bridge classifies every GraphQL HTTP 429 as
`mento_pool_bridge_poll_errors_total{kind="hasura_rate_limit"}` without checking
the body, so that metric proves rate limiting, not shared-quota exhaustion.

## Trigger condition

The `Metrics Bridge Poll Errors` Grafana rule fires above `0.01/s` for 10
minutes. The two-day threshold below is a manual isolation decision after
corroboration, not the alert's query.

Act when any of these fire:

- The `Metrics Bridge Poll Errors` alert fires with
  `kind="hasura_rate_limit"`, the underlying response body or Envio usage
  corroborates shared-quota pressure, and this happens on at least two distinct
  days within a rolling 14-day window.
- Dashboard Sentry shows sustained 429 `"Tier Quota"` `ClientError` events
  outside a known quota-burn incident.
- Envio usage shows more than 80% of the monthly tier quota consumed before
  day 21 of the month.

Inspect bridge logs and Envio usage before treating any bridge 429 or non-429
Hasura failure as shared-quota pressure:

```bash
gcloud run services logs read metrics-bridge --project mento-monitoring --region europe-west1
```

## Mitigation order

1. Contact Envio support to confirm whether hosted Hasura applies
   per-consumer rate limits and to price a tier upgrade or dedicated endpoint.
2. Protect paging first: add a dedicated bridge-only Terraform input, provision
   a dedicated Envio endpoint or replica, and point `metrics-bridge` at it. The
   current shared `var.hasura_url` configures both the dashboard and bridge, so
   changing that value alone does not isolate either consumer.
3. Reduce public load: route anonymous browser polling through a Next.js route
   handler with short-TTL shared caching.

## Open question

Whether hosted Hasura applies per-consumer limits today is not verifiable from
this repository. Whoever executes the mitigation owns confirming that detail
with Envio support before choosing between a tier upgrade, dedicated bridge
endpoint, or browser-side cache.
