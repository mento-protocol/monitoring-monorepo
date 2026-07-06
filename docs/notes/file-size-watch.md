---
title: File-size and lint-hygiene watch list
status: active
owner: eng
last_verified: 2026-07-06
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

Counts refreshed 2026-07-06. Issue #1036 split the largest remaining soft-cap
dashboard components:
`ui-dashboard/src/app/cdps/[symbol]/_components/cdp-trove-table.tsx` moved trove
row rendering to `trove-cells.tsx` and row-building helpers to
`trove-row-data.ts`,
`ui-dashboard/src/app/cdps/[symbol]/_components/cdp-detail-client.tsx` moved the
Stability Pool LP snapshot table to `cdp-depositor-table.tsx`, and
`ui-dashboard/src/app/volume/_components/v3-flow-insights.tsx` moved the
presentational insight panels to `v3-flow-insight-panels.tsx`. All three source
files dropped off this list entirely.

| Rough |  Raw | Delta | Status   | File                                                                         |
| ----: | ---: | ----: | -------- | ---------------------------------------------------------------------------- |
|   726 | 1052 |     0 | soft cap | `ui-dashboard/src/components/oracle-chart.tsx`                               |
|   721 |  756 |     0 | soft cap | `indexer-envio/src/handlers/liquity/troveManager.ts`                         |
|   695 |  943 |     0 | soft cap | `indexer-envio/src/rpc/effects.ts`                                           |
|   692 | 1027 |     0 | soft cap | `indexer-envio/src/breakers.ts`                                              |
|   656 | 1006 |   +20 | soft cap | `indexer-envio/src/handlers/sortedOracles.ts`                                |
|   632 |  669 |     0 | soft cap | `ui-dashboard/src/app/pool/[poolId]/_components/pool-detail-page-client.tsx` |
|   630 |  796 |     0 | soft cap | `indexer-envio/src/rpc/breakers.ts`                                          |
|   603 |  709 |     0 | soft cap | `indexer-envio/src/volumeSnapshots.ts`                                       |
|   599 |  617 |     0 | watch    | `indexer-envio/src/handlers/liquity/stabilityPool.ts`                        |
|   598 |  718 |     0 | watch    | `metrics-bridge/src/metrics.ts`                                              |
|   587 |  657 |     0 | watch    | `aegis/src/metric.spec.ts`                                                   |
|   581 |  818 |     0 | watch    | `ui-dashboard/src/lib/volume.ts`                                             |
|   581 |  744 |    +2 | watch    | `ui-dashboard/src/lib/homepage-og.ts`                                        |
|   580 |  642 |     0 | watch    | `ui-dashboard/src/lib/cdp-borrowing-revenue.ts`                              |
|   569 |  686 |     0 | watch    | `ui-dashboard/src/app/pool/[poolId]/_tabs/oracle-tab.tsx`                    |
|   562 |  716 |     0 | watch    | `indexer-envio/src/handlers/broker.ts`                                       |
|   546 |  669 |     0 | watch    | `indexer-envio/src/pool/self-heal.ts`                                        |
|   530 |  857 |     0 | watch    | `ui-dashboard/src/lib/health.ts`                                             |
|   518 |  733 |     0 | watch    | `indexer-envio/src/handlers/fpmm/state-sync.ts`                              |
|   516 |  667 |     0 | watch    | `ui-dashboard/src/lib/queries/volume.ts`                                     |
|   500 |  654 |     0 | watch    | `indexer-envio/src/handlers/wormhole/nttManager.ts`                          |
|   494 |  620 |     0 | watch    | `aegis/src/query.service.spec.ts`                                            |
|   492 |  700 |     0 | watch    | `ui-dashboard/src/app/page-client.tsx`                                       |
|   478 |  687 |     0 | watch    | `ui-dashboard/src/components/volume-over-time-chart.tsx`                     |
|   476 |  610 |     0 | watch    | `ui-dashboard/src/lib/address-labels/snapshot.ts`                            |
|   468 |  607 |     0 | watch    | `ui-dashboard/src/app/stables/_lib/aggregate.ts`                             |
|   456 |  617 |     0 | watch    | `indexer-envio/src/handlers/biPoolManager.ts`                                |
|   333 |  632 |     0 | watch    | `ui-dashboard/src/lib/volume-hero.ts`                                        |
