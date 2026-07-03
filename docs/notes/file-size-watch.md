---
title: File-size and lint-hygiene watch list
status: active
owner: eng
last_verified: 2026-07-03
---

# File-size and lint-hygiene watch list

Migrated off `BACKLOG.md` 2026-05-29 — this is passive guidance, not a task.
These files are near or above the repo's advisory source-size budget. No
action until one grows or a focused split is ready; hard-cap and near-hard-cap
findings should become GitHub Issues rather than `BACKLOG.md` entries.

Refresh with:

```bash
node scripts/file-size-watchlist.mjs
```

Use `node scripts/file-size-watchlist.mjs --format issue` when a cron or agent
needs an issue-ready report body. `raw` is physical lines; `rough` approximates
the ESLint count after skipping blanks and comments. Generated files, non-Aegis
tests, and `ui-dashboard/src/lib/types.ts` are excluded. `Delta` compares raw
lines against the previous watchlist baseline when one exists; otherwise the row
is marked `(new)`.

Counts refreshed 2026-07-03. PR #1030 split the near-hard files first:
`ui-dashboard/src/lib/network-fetcher/fetch.ts` moved pagination/cache helpers to
`network-fetcher/pagination.ts`,
`indexer-envio/src/handlers/liquity/troveManager.ts` moved preload and transition
helpers to dedicated Liquity modules, and
`integration-probes/src/adapters.ts` moved generic probe execution to
`adapterRunner.ts`.

| Rough |  Raw | Delta | Status   | File                                                                         |
| ----: | ---: | ----: | -------- | ---------------------------------------------------------------------------- |
|   829 |  887 |    -1 | soft cap | `ui-dashboard/src/app/cdps/[symbol]/_components/cdp-trove-table.tsx`         |
|   726 | 1052 |    -1 | soft cap | `ui-dashboard/src/components/oracle-chart.tsx`                               |
|   721 |  756 |    -1 | soft cap | `indexer-envio/src/handlers/liquity/troveManager.ts`                         |
|   695 |  943 |    -1 | soft cap | `indexer-envio/src/rpc/effects.ts`                                           |
|   692 | 1027 |    -1 | soft cap | `indexer-envio/src/breakers.ts`                                              |
|   646 |  986 |    -1 | soft cap | `indexer-envio/src/handlers/sortedOracles.ts`                                |
|   637 |  660 |    -1 | soft cap | `ui-dashboard/src/app/volume/_components/v3-flow-insights.tsx`               |
|   632 |  669 |    -1 | soft cap | `ui-dashboard/src/app/pool/[poolId]/_components/pool-detail-page-client.tsx` |
|   630 |  796 |    -1 | soft cap | `indexer-envio/src/rpc/breakers.ts`                                          |
|   604 |  775 |    -1 | soft cap | `ui-dashboard/src/lib/network-fetcher/fetch.ts`                              |
|   603 |  709 |    -1 | soft cap | `indexer-envio/src/volumeSnapshots.ts`                                       |
|   603 |  640 |    -1 | soft cap | `ui-dashboard/src/app/cdps/[symbol]/_components/cdp-detail-client.tsx`       |
|   599 |  617 |    -1 | watch    | `indexer-envio/src/handlers/liquity/stabilityPool.ts`                        |
|   598 |  718 |    -1 | watch    | `metrics-bridge/src/metrics.ts`                                              |
|   587 |  657 | (new) | watch    | `aegis/src/metric.spec.ts`                                                   |
|   581 |  818 |    -1 | watch    | `ui-dashboard/src/lib/volume.ts`                                             |
|   580 |  642 |    -1 | watch    | `ui-dashboard/src/lib/cdp-borrowing-revenue.ts`                              |
|   579 |  742 |    -1 | watch    | `ui-dashboard/src/lib/homepage-og.ts`                                        |
|   569 |  686 |    -1 | watch    | `ui-dashboard/src/app/pool/[poolId]/_tabs/oracle-tab.tsx`                    |
|   562 |  716 |    -1 | watch    | `indexer-envio/src/handlers/broker.ts`                                       |
|   546 |  669 |    -1 | watch    | `indexer-envio/src/pool/self-heal.ts`                                        |
|   530 |  857 |    -1 | watch    | `ui-dashboard/src/lib/health.ts`                                             |
|   518 |  733 |    -1 | watch    | `indexer-envio/src/handlers/fpmm/state-sync.ts`                              |
|   516 |  667 |    -1 | watch    | `ui-dashboard/src/lib/queries/volume.ts`                                     |
|   500 |  654 |    -1 | watch    | `indexer-envio/src/handlers/wormhole/nttManager.ts`                          |
|   494 |  620 | (new) | watch    | `aegis/src/query.service.spec.ts`                                            |
|   492 |  700 |    -1 | watch    | `ui-dashboard/src/app/page-client.tsx`                                       |
|   478 |  687 |    -1 | watch    | `ui-dashboard/src/components/volume-over-time-chart.tsx`                     |
|   476 |  610 |    -1 | watch    | `ui-dashboard/src/lib/address-labels/snapshot.ts`                            |
|   468 |  607 |    -1 | watch    | `ui-dashboard/src/app/stables/_lib/aggregate.ts`                             |
|   456 |  617 |    -1 | watch    | `indexer-envio/src/handlers/biPoolManager.ts`                                |
|   430 |  626 |    -1 | watch    | `indexer-envio/src/pool.ts`                                                  |
|   333 |  632 |    -1 | watch    | `ui-dashboard/src/lib/volume-hero.ts`                                        |
