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
the ESLint count after skipping blanks and comments.

Counts refreshed 2026-07-03. PR #1030 split the near-hard files first:
`ui-dashboard/src/lib/network-fetcher/fetch.ts` moved pagination/cache helpers to
`network-fetcher/pagination.ts`,
`indexer-envio/src/handlers/liquity/troveManager.ts` moved preload and transition
helpers to dedicated Liquity modules, and
`integration-probes/src/adapters.ts` moved generic probe execution to
`adapterRunner.ts`.

| Rough |  Raw | Status   | File                                                                         |
| ----: | ---: | -------- | ---------------------------------------------------------------------------- |
|   829 |  888 | soft cap | `ui-dashboard/src/app/cdps/[symbol]/_components/cdp-trove-table.tsx`         |
|   726 | 1053 | soft cap | `ui-dashboard/src/components/oracle-chart.tsx`                               |
|   721 |  757 | soft cap | `indexer-envio/src/handlers/liquity/troveManager.ts`                         |
|   695 |  944 | soft cap | `indexer-envio/src/rpc/effects.ts`                                           |
|   692 | 1028 | soft cap | `indexer-envio/src/breakers.ts`                                              |
|   646 |  987 | soft cap | `indexer-envio/src/handlers/sortedOracles.ts`                                |
|   637 |  661 | soft cap | `ui-dashboard/src/app/volume/_components/v3-flow-insights.tsx`               |
|   632 |  670 | soft cap | `ui-dashboard/src/app/pool/[poolId]/_components/pool-detail-page-client.tsx` |
|   630 |  797 | soft cap | `indexer-envio/src/rpc/breakers.ts`                                          |
|   604 |  776 | soft cap | `ui-dashboard/src/lib/network-fetcher/fetch.ts`                              |
|   603 |  710 | soft cap | `indexer-envio/src/volumeSnapshots.ts`                                       |
|   603 |  641 | soft cap | `ui-dashboard/src/app/cdps/[symbol]/_components/cdp-detail-client.tsx`       |
|   599 |  618 | watch    | `indexer-envio/src/handlers/liquity/stabilityPool.ts`                        |
|   598 |  719 | watch    | `metrics-bridge/src/metrics.ts`                                              |
|   581 |  819 | watch    | `ui-dashboard/src/lib/volume.ts`                                             |
|   580 |  643 | watch    | `ui-dashboard/src/lib/cdp-borrowing-revenue.ts`                              |
|   579 |  743 | watch    | `ui-dashboard/src/lib/homepage-og.ts`                                        |
|   569 |  687 | watch    | `ui-dashboard/src/app/pool/[poolId]/_tabs/oracle-tab.tsx`                    |
|   562 |  717 | watch    | `indexer-envio/src/handlers/broker.ts`                                       |
|   546 |  670 | watch    | `indexer-envio/src/pool/self-heal.ts`                                        |
|   530 |  858 | watch    | `ui-dashboard/src/lib/health.ts`                                             |
|   518 |  734 | watch    | `indexer-envio/src/handlers/fpmm/state-sync.ts`                              |
|   516 |  668 | watch    | `ui-dashboard/src/lib/queries/volume.ts`                                     |
|   500 |  655 | watch    | `indexer-envio/src/handlers/wormhole/nttManager.ts`                          |
|   492 |  701 | watch    | `ui-dashboard/src/app/page-client.tsx`                                       |
|   478 |  688 | watch    | `ui-dashboard/src/components/volume-over-time-chart.tsx`                     |
|   476 |  611 | watch    | `ui-dashboard/src/lib/address-labels/snapshot.ts`                            |
|   468 |  608 | watch    | `ui-dashboard/src/app/stables/_lib/aggregate.ts`                             |
|   456 |  618 | watch    | `indexer-envio/src/handlers/biPoolManager.ts`                                |
|   430 |  627 | watch    | `indexer-envio/src/pool.ts`                                                  |
|   333 |  633 | watch    | `ui-dashboard/src/lib/volume-hero.ts`                                        |
