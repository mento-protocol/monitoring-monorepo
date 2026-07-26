---
title: Read model is SWR polling plus bounded snapshot composition at current scale
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
scope: ui-dashboard
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0020 — Read model: SWR polling + bounded snapshot composition at current scale

**Status:** Accepted (Mar 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard needs near-real-time data from Hasura. Two questions: how to keep it
fresh, and how to compute the 24h volume tiles/table. Live subscriptions add a
stateful transport; server-side aggregation runs into the no-`_aggregate` rule
(ADR 0014).

## Decision

Use **SWR polling** against Hasura for freshness (simple request/refetch, no
websocket transport). Compose each volume surface from bounded rollup reads:

- hero metrics combine pre-rolled per-chain window snapshots with small
  today/first-day overlap slices in the client;
- pool charts paginate `PoolDailyVolumeSnapshot` rows before reducing them;
- top trader and aggregator tables aggregate bounded daily rollup rows.

Server rendering prefetches the primary hero pair as an initial fallback; SWR
owns subsequent freshness. Pool-snapshot composition and `/volume` hero
composition have separate cardinality contracts. Neither result is blanket
evidence that every hero or table query is safe: each query must still obey
Hasura row caps and expose truncation or degraded state where applicable.

## Alternatives considered

- **GraphQL subscriptions / websockets** — rejected: adds a stateful transport and
  reconnection logic for data that polling refreshes fine.
- **Server-side `_aggregate`** — rejected by ADR 0014; unbounded query cost.

## Consequences

- The pool-snapshot path remains acceptable only while its measured bounds hold.
  Re-review it when the production pool count exceeds 40, one chain returns
  more than 3,500 daily rows or four pages, or one complete chain pagination
  reaches 1,500 ms on two consecutive measurements.
- The `/volume` hero has a separate bound. Re-review it when
  `VolumeWindowLatest` returns more than 10 rows or needs another page, when
  `VolumeTodayTraders` returns 100 or more rows, or when either primary query
  reaches 1,000 ms on two consecutive measurements. Rework the current-day
  path before it reaches its 1,000-row Hasura cap.
- Polling discipline (intervals, dedupe) is a review surface for stateful UI changes.

## Evidence

- Polling defaults in
  [`ui-dashboard/src/lib/graphql.ts`](../../ui-dashboard/src/lib/graphql.ts);
  bounded queries in
  [`ui-dashboard/src/lib/queries/volume.ts`](../../ui-dashboard/src/lib/queries/volume.ts);
  hero composition in
  [`ui-dashboard/src/app/volume/_lib/use-hero-rollup.ts`](../../ui-dashboard/src/app/volume/_lib/use-hero-rollup.ts);
  SSR fallback in
  [`ui-dashboard/src/lib/volume-ssr.ts`](../../ui-dashboard/src/lib/volume-ssr.ts).
- Polling and row-cap rules in
  [`docs/pr-checklists/swr-polling-hasura.md`](../pr-checklists/swr-polling-hasura.md);
  the pool-scale exclusion in
  [`docs/pr-checklists/review-prompt-exclusions.md`](../pr-checklists/review-prompt-exclusions.md).
- Production measurement on 2026-07-26 used public `/pools` and `/volume`,
  then read-only POSTs to `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql`.
  GitHub's successful Production deployment record targeting
  `https://monitoring-dashboard-jl1ca6upx-mentolabs.vercel.app` pins
  `63a1f7ffc4f0bcfd06d58c0c0281942f61fb7945` at 10:38:22Z; the `/volume`
  response was dated 11:53:18Z. The public response did not emit
  `X-Mento-Deployment-Sha`, so the deployment record, rather than an invented
  header value, supplies the SHA.
- `/pools` used `PoolDailySnapshotsAll` with `afterTimestamp: 0`, `limit: 1000`,
  and per-chain pool IDs: Polygon (3 pools, 1 page, 21 rows, 4,385 bytes,
  279 ms first / 217 ms immediate repeat); Monad (7, 1, 747, 168,244,
  253 / 300 ms); Celo (20, 3, 2,429, 487,620, 686 / 688 ms). The path therefore
  measured 30 pools, 5 pages, and 3,197 rows. Latencies are per-chain complete
  pagination, not one combined route timing; bytes are uncompressed GraphQL
  response bytes observed by the requester. The exact public variables were:

  ```json
  {
    "137": {
      "poolIds": [
        "137-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5",
        "137-0x93e15a22fda39fefccce82d387a09ccf030ead61",
        "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201"
      ],
      "offsets": [0]
    },
    "143": {
      "poolIds": [
        "143-0x0a59be741ad49c6c2e0a2d30a57ed8f5ffa5deb8",
        "143-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5",
        "143-0x4df3f08977743ad95ab31b8dc203eae885ae9d32",
        "143-0x93e15a22fda39fefccce82d387a09ccf030ead61",
        "143-0xb0a0264ce6847f101b76ba36a4a3083ba489f501",
        "143-0xd0e9c1a718d2a693d41eacd4b2696180403ce081",
        "143-0xdc81135fd82f02cae736e261fb676b716663e8b8"
      ],
      "offsets": [0]
    },
    "42220": {
      "poolIds": [
        "42220-0x0feba760d93423d127de1b6abecdb60e5253228d",
        "42220-0x1ad2ea06502919f935d9c09028df73a462979e29",
        "42220-0x1d013077b00b28038a3f1e7a29aba34e12e562e9",
        "42220-0x30214efe28ab44d6a5c739eba5e0729b1d4213e4",
        "42220-0x3aa7c431c06b10f7422e69d3e69b66807a6af696",
        "42220-0x3d6e023177bac13d6e316d95161d4bb9dcf0e276",
        "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
        "42220-0x62753ec2956f84af240b4666a130c88a83933848",
        "42220-0x62fa288e3ac844dcfce5469af4f8feb7d6f7ba61",
        "42220-0x6daa327e0cbe2ce84c0f312f20b9432fe744ed58",
        "42220-0x71f55035a49c972c5c3197e874f6b7fd94672b6e",
        "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
        "42220-0x9861f6d2fe392b934c86ec89d2886ceb772b2b41",
        "42220-0xa337a498e4e061f4029fcb3b9f4e3d535e885dc5",
        "42220-0xab945882018b81bdf62629e98ffdafd9495a0076",
        "42220-0xaea92e8006e6edf0f9e9368ee9af36814b738855",
        "42220-0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d",
        "42220-0xbe6d2165173a29889652c7bf2dc3a02076a22f2a",
        "42220-0xdc81135fd82f02cae736e261fb676b716663e8b8",
        "42220-0xeb433ce1f2ce4981b76fe7ca3a96070705d8ede4"
      ],
      "offsets": [0, 1000, 2000]
    }
  }
  ```

  Every request also supplied `"afterTimestamp": 0` and `"limit": 1000`; one
  request was sent for each listed offset.

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
  evidence, separate from the pagination latencies above and the `/volume`
  requests below.
- Public `/volume` defaulted to v3, `windowKey: "7d"`,
  `chainIdIn: [42220, 143, 137]`, and all actors. `VolumeWindowLatest` returned
  3 rows in 1 page (1,067 bytes; 239 ms first / 286 ms immediate repeat).
  `VolumeTodayTraders` used `todayMidnight: 1785024000` and
  `isProtocolActorIn: [false, true]`, returning 6 rows in 1 page (917 bytes;
  249 / 118 ms). These are separate measurements, not a combined timing.
- No owned cost or quota source was available. This ADR makes no cost or quota
  claim from source inspection or these request measurements.
