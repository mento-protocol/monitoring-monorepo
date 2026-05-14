# Code Health History

_Generated 2026-05-14T18:31:49.541Z from `git log --numstat`._

CodeScene-style signals derived from git history. Strictly advisory; no merge gating.

**Reading guide**: large + frequently-changed files (hotspots) are the highest-leverage refactor targets. Strongly coupled pairs hint at a missing abstraction. Single-owner files are bus-factor risk; many-author files are consensus-drift risk.

## Top 20 hotspots (90-day churn × current LOC)

|   # |  Score | Commits |  LOC | File                                                                     |
| --: | -----: | ------: | ---: | ------------------------------------------------------------------------ |
|   1 | 33,280 |      26 | 1280 | `ui-dashboard/src/app/pool/[poolId]/page.test.tsx`                       |
|   2 | 25,521 |      47 |  543 | `ui-dashboard/src/lib/types.ts`                                          |
|   3 | 23,368 |      23 | 1016 | `ui-dashboard/src/hooks/__tests__/use-all-networks-data.test.ts`         |
|   4 | 22,165 |      31 |  715 | `ui-dashboard/src/app/__tests__/page.test.tsx`                           |
|   5 | 21,768 |       8 | 2721 | `ui-dashboard/src/lib/__tests__/leaderboard.test.ts`                     |
|   6 | 21,200 |      20 | 1060 | `ui-dashboard/src/lib/__tests__/health.test.ts`                          |
|   7 | 19,040 |      35 |  544 | `indexer-envio/src/pool.ts`                                              |
|   8 | 18,036 |      12 | 1503 | `metrics-bridge/test/metrics.test.ts`                                    |
|   9 | 17,777 |      29 |  613 | `ui-dashboard/src/lib/health.ts`                                         |
|  10 | 17,625 |      25 |  705 | `indexer-envio/src/handlers/sortedOracles.ts`                            |
|  11 | 16,536 |     106 |  156 | `ui-dashboard/src/app/pool/[poolId]/page.tsx`                            |
|  12 | 16,128 |      28 |  576 | `ui-dashboard/src/app/api/address-labels/import/__tests__/route.test.ts` |
|  13 | 15,380 |      20 |  769 | `ui-dashboard/src/app/pool/[poolId]/__tests__/page.test.tsx`             |
|  14 | 13,764 |      31 |  444 | `ui-dashboard/src/app/address-book/AddressBookClient.tsx`                |
|  15 | 11,513 |      29 |  397 | `ui-dashboard/src/components/global-pools-table.tsx`                     |
|  16 | 11,232 |     108 |  104 | `indexer-envio/src/EventHandlers.ts`                                     |
|  17 | 11,220 |      17 |  660 | `ui-dashboard/src/lib/__tests__/volume.test.ts`                          |
|  18 | 10,842 |      13 |  834 | `indexer-envio/src/rpc/effects.ts`                                       |
|  19 | 10,296 |      39 |  264 | `ui-dashboard/src/lib/networks.ts`                                       |
|  20 |  8,924 |      23 |  388 | `ui-dashboard/src/lib/__tests__/networks.test.ts`                        |

## Top 10 change-coupled file pairs (180d)

Filters: co-changes ≥ 5, co-change rate ≥ 40%.

|   # | Co-changes | Rate | File A                                                                   | File B                                                           |
| --: | ---------: | ---: | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
|   1 |         41 |  55% | `ui-dashboard/src/app/pool/[poolId]/page.tsx`                            | `ui-dashboard/src/lib/queries.ts`                                |
|   2 |         35 |  74% | `ui-dashboard/src/lib/queries.ts`                                        | `ui-dashboard/src/lib/types.ts`                                  |
|   3 |         26 |  93% | `ui-dashboard/src/app/api/address-labels/import/__tests__/route.test.ts` | `ui-dashboard/src/app/api/address-labels/import/route.ts`        |
|   4 |         25 |  53% | `ui-dashboard/src/app/pool/[poolId]/page.tsx`                            | `ui-dashboard/src/lib/types.ts`                                  |
|   5 |         23 |  88% | `ui-dashboard/src/app/pool/[poolId]/page.test.tsx`                       | `ui-dashboard/src/app/pool/[poolId]/page.tsx`                    |
|   6 |         20 |  65% | `ui-dashboard/src/app/__tests__/page.test.tsx`                           | `ui-dashboard/src/app/page.tsx`                                  |
|   7 |         19 |  76% | `indexer-envio/src/handlers/sortedOracles.ts`                            | `indexer-envio/src/pool.ts`                                      |
|   8 |         18 |  78% | `ui-dashboard/src/hooks/__tests__/use-all-networks-data.test.ts`         | `ui-dashboard/src/hooks/use-all-networks-data.ts`                |
|   9 |         16 |  80% | `ui-dashboard/src/lib/__tests__/health.test.ts`                          | `ui-dashboard/src/lib/health.ts`                                 |
|  10 |         16 |  70% | `ui-dashboard/src/app/__tests__/page.test.tsx`                           | `ui-dashboard/src/hooks/__tests__/use-all-networks-data.test.ts` |

## Knowledge concentration (180d, top author has ≥80% of commits)

|   # | Share | Commits |  LOC | Top author | File                                                                     |
| --: | ----: | ------: | ---: | ---------- | ------------------------------------------------------------------------ |
|   1 |  100% |       8 | 2721 | chapati    | `ui-dashboard/src/lib/__tests__/leaderboard.test.ts`                     |
|   2 |  100% |       3 | 1769 | chapati    | `ui-dashboard/src/app/bridge-flows/__tests__/page.test.tsx`              |
|   3 |  100% |       3 | 1682 | chapati    | `ui-dashboard/src/components/__tests__/breach-history-panel.test.tsx`    |
|   4 |  100% |      12 | 1503 | chapati    | `metrics-bridge/test/metrics.test.ts`                                    |
|   5 |  100% |       6 | 1246 | chapati    | `indexer-envio/test/biPoolManager.test.ts`                               |
|   6 |  100% |       7 | 1202 | chapati    | `ui-dashboard/src/app/address-book/__tests__/AddressBookClient.test.tsx` |
|   7 |  100% |       6 | 1119 | chapati    | `indexer-envio/test/deviationBreach.test.ts`                             |
|   8 |  100% |       5 | 1092 | chapati    | `indexer-envio/test/poolDailyFeeSnapshot.test.ts`                        |
|   9 |  100% |       8 | 1030 | chapati    | `indexer-envio/test/leaderboardWindowSnapshot.test.ts`                   |
|  10 |  100% |       8 |  939 | chapati    | `metrics-bridge/test/rebalance-probe.test.ts`                            |

## Knowledge spread (180d, ≥5 distinct contributors)

_None._

## Weekly delta — top 5 hotspots this week

⭐ marks files that weren't in last week's top-5 (new emerging hotspots).

|   # | Commits | Status | File                                         |
| --: | ------: | :----: | -------------------------------------------- |
|   1 |      13 | ⭐ new | `indexer-envio/src/pool.ts`                  |
|   2 |      12 | ⭐ new | `indexer-envio/src/rpc/effects.ts`           |
|   3 |      11 | ⭐ new | `indexer-envio/src/rpc/pool-state.ts`        |
|   4 |      10 | ⭐ new | `indexer-envio/src/handlers/fpmm/factory.ts` |
|   5 |       8 | ⭐ new | `indexer-envio/src/handlers/broker.ts`       |
