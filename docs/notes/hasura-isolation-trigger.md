---
title: Hasura isolation trigger
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
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

`metrics-bridge` polls `HASURA_URL` every 30s (`metrics-bridge/src/config.ts`
and `metrics-bridge/src/env.ts`) and exports the gauges that back Grafana
alerts. Today this is the same hosted endpoint the public dashboard reads.

Envio's small tier has returned HTTP 429 `"Tier Quota"` without `Retry-After`
when the shared monthly endpoint quota is exhausted
(`ui-dashboard/src/lib/gql-retry.ts`). The dashboard backs off on those 429s;
the bridge records them as
`mento_pool_bridge_poll_errors_total{kind="hasura_rate_limit"}`.

## Trigger condition

Act when any of these fire:

- The `Metrics Bridge Poll Errors` alert fires with
  `kind="hasura_rate_limit"` on at least two distinct days within a rolling
  14-day window.
- Dashboard Sentry shows sustained 429 `"Tier Quota"` `ClientError` events
  outside a known quota-burn incident.
- Envio usage shows more than 80% of the monthly tier quota consumed before
  day 21 of the month.

For non-429 Hasura failures, inspect bridge logs before treating the event as
quota pressure:

```bash
gcloud run services logs read metrics-bridge --project mento-monitoring --region europe-west1
```

## Mitigation order

1. Contact Envio support to confirm whether hosted Hasura applies
   per-consumer rate limits and to price a tier upgrade or dedicated endpoint.
2. Protect paging first: provision a dedicated Envio endpoint or replica for
   `metrics-bridge` and point its `HASURA_URL` there.
3. Reduce public load: route anonymous browser polling through a Next.js route
   handler with short-TTL shared caching.

## Open question

Whether hosted Hasura applies per-consumer limits today is not verifiable from
this repository. Whoever executes the mitigation owns confirming that detail
with Envio support before choosing between a tier upgrade, dedicated bridge
endpoint, or browser-side cache.
