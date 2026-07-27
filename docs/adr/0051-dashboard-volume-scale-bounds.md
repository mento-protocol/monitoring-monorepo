---
title: Dashboard volume composition has per-chain and total re-review bounds
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
scope: ui-dashboard
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
supersedes: ADR-0020
---

# ADR 0051 — Dashboard volume composition has per-chain and total re-review bounds

**Status:** Accepted (Jul 2026); supersedes ADR 0020. **Scope:** ui-dashboard.

## Context

ADR 0020 selected SWR polling and client composition from bounded rollups. The
production measurements below now make its former current-scale caveat a
continuing policy. A per-chain ceiling alone is insufficient: adding chains can
increase the aggregate browser reduction while every chain remains below its
own ceiling. The `/volume` hero uses a separate, small rollup shape and needs
its own limits.

## Decision

Keep the ADR 0020 read model. Re-review pool-snapshot composition before it
becomes unsafe when any of these inclusive limits is reached:

- total production pool count is more than 40;
- one chain returns 3,500 or more daily rows, or requires four or more pages;
- all chains together return 6,000 or more daily rows, or require eight or
  more pages; or
- one complete chain pagination reaches 1,500 ms on two consecutive
  measurements.

The aggregate limits are a separate client-side bound: the 2026-07-26 baseline
is 3,197 rows over five pages, so a new chain cannot evade the policy by
remaining under the per-chain limits. Re-review means measure the query shape,
browser reduction, and indexer-side rollup alternative before extending the
existing path; it does not automatically require a rewrite.

Re-review the `/volume` hero when `VolumeWindowLatest` returns more than 10
rows or needs another page, when `VolumeTodayTraders` returns 100 or more rows,
or when either primary query reaches 1,000 ms on two consecutive measurements.
Rework the current-day path before it reaches its 1,000-row Hasura cap.

## Alternatives considered

- **Amend ADR 0020 in place** — rejected: it hides the original decision and
  makes the new measured policy look historical.
- **Per-chain limits only** — rejected: aggregate client reduction rises as
  chains are added even when each chain remains below its own bound.
- **Subscriptions or server-side `_aggregate`** — rejected by ADR 0020 and
  ADR 0014: they add stateful transport or rely on an unavailable unbounded
  aggregation path.

## Consequences

- ADR 0020 is archived and remains the historical record of the original read
  model; this ADR is the canonical scale policy.
- Reviewers apply the same inclusive page and aggregate limits in
  [`docs/pr-checklists/review-prompt-exclusions.md`](../pr-checklists/review-prompt-exclusions.md).
- Neither this evidence nor the exclusion is a cost or quota claim, and neither
  waives Hasura row caps, truncation handling, or deploy-window schema safety.

## Evidence

- Polling defaults are in
  [`ui-dashboard/src/lib/graphql.ts`](../../ui-dashboard/src/lib/graphql.ts);
  bounded queries are in
  [`ui-dashboard/src/lib/queries/volume.ts`](../../ui-dashboard/src/lib/queries/volume.ts);
  hero composition is in
  [`ui-dashboard/src/app/volume/_lib/use-hero-rollup.ts`](../../ui-dashboard/src/app/volume/_lib/use-hero-rollup.ts);
  SSR fallback is in
  [`ui-dashboard/src/lib/volume-ssr.ts`](../../ui-dashboard/src/lib/volume-ssr.ts).
- Polling and row-cap rules are in
  [`docs/pr-checklists/swr-polling-hasura.md`](../pr-checklists/swr-polling-hasura.md).
- Production measurement on 2026-07-26 used public `/pools` and `/volume`,
  then read-only POSTs to `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql`.
  GitHub's successful Production deployment record targeting
  `https://monitoring-dashboard-jl1ca6upx-mentolabs.vercel.app` records
  `63a1f7ffc4f0bcfd06d58c0c0281942f61fb7945` at 10:38:22Z. The `/volume`
  response was dated 11:53:18Z and did not emit `X-Mento-Deployment-Sha`.
  These records prove that deployment's SHA and the later response timestamp;
  they do not prove that no deployment intervened or that `/volume` served that
  SHA.
- `/pools` used `PoolDailySnapshotsAll` with `afterTimestamp: 0`, `limit: 1000`,
  and per-chain pool IDs: Polygon (3 pools, 1 page, 21 rows, 4,385 bytes,
  279 ms first / 217 ms immediate repeat); Monad (7, 1, 747, 168,244,
  253 / 300 ms); Celo (20, 3, 2,429, 487,620, 686 / 688 ms). The path therefore
  measured 30 pools, 5 pages, and 3,197 rows. Latencies are per-chain complete
  pagination, not one combined route timing; bytes are uncompressed GraphQL
  response bytes observed by the requester. Every request supplied
  `afterTimestamp: 0` and `limit: 1000`; one request ran for each offset.

  | Chain         | Pool IDs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Offsets             |
  | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
  | Polygon (137) | `137-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5`, `137-0x93e15a22fda39fefccce82d387a09ccf030ead61`, `137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `0`                 |
  | Monad (143)   | `143-0x0a59be741ad49c6c2e0a2d30a57ed8f5ffa5deb8`, `143-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5`, `143-0x4df3f08977743ad95ab31b8dc203eae885ae9d32`, `143-0x93e15a22fda39fefccce82d387a09ccf030ead61`, `143-0xb0a0264ce6847f101b76ba36a4a3083ba489f501`, `143-0xd0e9c1a718d2a693d41eacd4b2696180403ce081`, `143-0xdc81135fd82f02cae736e261fb676b716663e8b8`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `0`                 |
  | Celo (42220)  | `42220-0x0feba760d93423d127de1b6abecdb60e5253228d`, `42220-0x1ad2ea06502919f935d9c09028df73a462979e29`, `42220-0x1d013077b00b28038a3f1e7a29aba34e12e562e9`, `42220-0x30214efe28ab44d6a5c739eba5e0729b1d4213e4`, `42220-0x3aa7c431c06b10f7422e69d3e69b66807a6af696`, `42220-0x3d6e023177bac13d6e316d95161d4bb9dcf0e276`, `42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e`, `42220-0x62753ec2956f84af240b4666a130c88a83933848`, `42220-0x62fa288e3ac844dcfce5469af4f8feb7d6f7ba61`, `42220-0x6daa327e0cbe2ce84c0f312f20b9432fe744ed58`, `42220-0x71f55035a49c972c5c3197e874f6b7fd94672b6e`, `42220-0x8c0014afe032e4574481d8934504100bf23fcb56`, `42220-0x9861f6d2fe392b934c86ec89d2886ceb772b2b41`, `42220-0xa337a498e4e061f4029fcb3b9f4e3d535e885dc5`, `42220-0xab945882018b81bdf62629e98ffdafd9495a0076`, `42220-0xaea92e8006e6edf0f9e9368ee9af36814b738855`, `42220-0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d`, `42220-0xbe6d2165173a29889652c7bf2dc3a02076a22f2a`, `42220-0xdc81135fd82f02cae736e261fb676b716663e8b8`, `42220-0xeb433ce1f2ce4981b76fe7ca3a96070705d8ede4` | `0`, `1000`, `2000` |

- Client reduction was measured separately with the existing
  `buildDailySnapshotSlices` and `buildPoolVolumeMap` functions. The benchmark
  [`pool-scale-aggregation.bench.ts`](../../ui-dashboard/scripts/pool-scale-aggregation.bench.ts)
  constructs the measured per-chain shape (3/7/20 pools and 21/747/2,429
  rows), verifies 3,197 input rows, then derives 30/210/831 rows and 30 pool
  outputs for the 24h/7d/30d maps. Run it with
  `pnpm -C ui-dashboard exec vitest bench scripts/pool-scale-aggregation.bench.ts --run`.
  On an Apple M2 Max arm64 host with Node 24.13.1, pnpm 11.9.0, and Vitest 4.1.7,
  100 batches of 10 measured iterations after 100 warmups had a per-iteration
  6.086 ms median and 20.775 ms p95. This is local client-reduction CPU
  evidence, separate from pagination latencies and the `/volume` requests.
- Public `/volume` defaulted to v3, `windowKey: "7d"`,
  `chainIdIn: [42220, 143, 137]`, and all actors. `VolumeWindowLatest` returned
  3 rows in 1 page (1,067 bytes; 239 ms first / 286 ms immediate repeat).
  `VolumeTodayTraders` used `todayMidnight: 1785024000` and
  `isProtocolActorIn: [false, true]`, returning 6 rows in 1 page (917 bytes;
  249 / 118 ms). These are separate measurements, not a combined timing.
- No owned cost or quota source was available. This ADR makes no cost or quota
  claim from source inspection or these request measurements.
