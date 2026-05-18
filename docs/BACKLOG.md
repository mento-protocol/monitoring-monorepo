# Monitoring Monorepo — Task Backlog

Last updated: 2026-05-18

## Next — CDP Monitoring Follow-Ups

The first CDP implementation adds Liquity v2 Celo entities, handlers, `CdpPool`
rows, and `/cdps` dashboard routes. Keep the remaining rollout work explicit so
the deploy sequence does not silently mix alerting, backfills, and UI cutovers.

- [ ] **Deploy and backfill CDP indexer** — deploy the branch indexer, wait for the Celo Liquity contract range to sync, promote it, then verify hosted Hasura exposes the new CDP entities before deploying the dashboard routes.
- [ ] **Global pools table cutover** — replace the current runtime RPC probe (`ui-dashboard/src/lib/strategy-detection.ts`) with `ALL_CDP_POOLS`/`ALL_RESERVE_POOLS` once CdpPool rows are backfilled on every network that can expose CDP-backed FPMMs. Keep the Monad fallback until Monad `CDPLiquidityStrategy` events are indexed.
- [ ] **`service=cdps` alerts** — add stability-pool headroom, shutdown, redemption, liquidation, and shortfall-subsidy rules after the CDP indexer has production history.

---

## Backlog — Indexer Enhancements

- [ ] **CDP live risk refinements** — compute live TCR/ICR percentiles from accrued interest and add a governance-owned stability-pool buffer source if the protocol wants headroom measured against more than zero deposits.
- [ ] **`turnoverCum` per pool** — cumulative `notionalCum / time-weighted-avg(tvlUsdM)` since T0 (spec §2). We track `notionalVolume0/1` but never compute time-weighted TVL; needs a TWAP-style accumulator on `Pool` updated on every reserves change (∑ tvl·dt, ∑ dt)
- [ ] **`timeInWarnCum` per pool** — cumulative seconds spent in warn (deviation breach inside grace window, pre-critical) since T0. Mirror the existing critical rollup (`Pool.cumulativeCriticalSeconds`, which already covers `timeInCriticalCum`); requires tracking warn-state transitions the same way `DeviationBreach` tracks critical
- [ ] **ChainStat / GlobalStat** — protocol-level aggregate entity (total pools, total swaps, global TVL, `chainProtocolFeesCum` / `globalProtocolFeesCum` from spec §2)
- [ ] **Oracle report history** — surface historical oracle prices on the indexer so `service=oracles` outlier alerts become expressible (consecutive-report deltas)
- [ ] **`lastOracleUpdateTxHash` on `Pool`** — unblocks the oracle tx-link tech-debt item (see below)
- [ ] **Indexer-backed oracle reporter detection (replace `USDM_SYMBOLS` heuristic)** — Pool detail's Oracle Source tile (PR #232) labels the upstream oracle by guessing from token symbols, which mislabels FX pools where neither leg is USDm (e.g. `USDC/GBPm` reads as `Chainlink USDC/USD`). Cursor flagged on #232; declined to widen scope. Fix: (1) new `RateFeed` entity (`feedAddress`, `reporters[]`, `reporterTypes[]: [CHAINLINK|REDSTONE|BRIDGED|MANUAL]`, `pair`); (2) handle `SortedOracles.OracleAdded`/`OracleRemoved` in `handlers/sortedOracles.ts` to maintain the reporter list; (3) static reporter→adapter map in `shared-config` consumed by both indexer and dashboard; (4) UI reads denormalized label from `Pool.referenceRateFeedID → RateFeed`. Stepping-stone (UI-only): call `SortedOracles.getOracles(feedId)` via RPC at render and look up the same static map — same map reusable for the indexer-backed approach.
- [ ] **Breaker state on `Pool` + `BreakerConfig` / `BreakerTripEvent` entities** — replace the static "Rebalance Threshold" tile with a live "Breaker" tile showing config (volatility tolerance + cooldown), live trip state (per BreakerBox `tradingMode` bitmask: 0 enabled / 1 inflow-only / 2 outflow-only / 3 halted), and cooldown countdown. Reset is **not** auto-on-time alone — `BreakerBox.tryResetBreaker` requires both cooldown elapsed AND `breaker.shouldReset()`, and only fires on the next SortedOracles report; UI must reflect the "awaiting calm" state. Vendor `BreakerBox.json` ABI; index `BreakerTripped` / `ResetSuccessful` / `TradingModeUpdated` / `ResetAttempt*Fail` plus per-breaker config-update events; extend `Pool` with `tradingMode: Int!` + `lastBreakerTripAt`. UI cooldown timer reuses the OLS pattern at `app/pool/[poolId]/page.tsx:2309-2425`. Refs: [`BreakerBox.sol`](https://github.com/mento-protocol/mento-core/blob/develop/contracts/oracles/BreakerBox.sol), [`MedianDeltaBreaker.sol`](https://github.com/mento-protocol/mento-core/blob/develop/contracts/oracles/breakers/MedianDeltaBreaker.sol), [`ValueDeltaBreaker.sol`](https://github.com/mento-protocol/mento-core/blob/develop/contracts/oracles/breakers/ValueDeltaBreaker.sol).
- [ ] **Derive `Pool.oracleOk` from expiry + cross-source FX validation** — today `oracleOk` is only set to `true` on `SortedOracles` handler events and never transitions back to `false` (see `indexer-envio/src/handlers/sortedOracles.ts` + `pool.ts:214`), so `mento_pool_oracle_ok` is effectively a "has-ever-reported" flag and the `Oracle Down` rule only fires for never-reported pools. PR #221 (FX weekend gate on `Oracle Liveness Critical`) exposed this gap — surfaced by Codex P1 review. Proper fix needs: (a) derive `oracleOk = indexer_oracle_ok AND (now - oracleTimestamp) < oracleExpiry` in the bridge or indexer, AND (b) a signal that distinguishes "paused because markets closed" from "paused because feed is broken" so we can un-gate critical on FX weekends without paging every weekend — options are cross-source validation (compare to a secondary FX oracle) or a post-reopen grace period (flag as broken if not resumed within 1h of Monday reopen). Until then the Fri 21:00 → Sun 23:00 UTC window is a conscious dead zone for genuinely-broken FX feeds; truly broken feeds get caught Monday morning when the gate lifts and ratio stays elevated past reopen.

## Backlog — Dashboard

- [ ] **Gap-fill for snapshot charts** — unify per-chart fill logic behind a shared helper so missing buckets render correctly (forward-fill for stocks, zero-fill for flows). Detailed plan below.
- [ ] **Pool detail config snapshot panel** (spec §4 "Pool") — consolidated view of configured thresholds: `rebalanceThreshold`, oracle expiry / `oracleNumReporters`, trading-limit windows (`limit0/1`, L0/L1/LG timers), rebalancer address. Today these are scattered across status panels or only visible via Etherscan. A single "Config" panel on pool detail makes a pool's configured shape auditable at a glance.

### Plan — Snapshot chart gap-fill

**Goal.** Every snapshot-driven chart in the dashboard renders missing buckets correctly (forward-fill for stocks, zero-fill for flows) via a single shared helper, so sparse-activity pools — especially FX pools that close on weekends — stop showing misleading visuals.

**Why now.** Today four of six snapshot-driven charts have _no_ gap-fill at all and the two that do each rolled their own implementation:

- `ui-dashboard/src/components/snapshot-chart.tsx:24-131` (Daily Swap Volume bars + Cumulative Swaps line) — sorts and maps raw rows; missing days simply disappear, so a Mon-Wed-Fri pool reads as three back-to-back days with the cumulative line auto-bridging (Plotly's default `connectgaps=true` behavior on `lines+markers`).
- `ui-dashboard/src/components/pool-tvl-over-time-chart.tsx:59-131` — sparse points only; the line auto-bridges across multi-day reserve gaps, masking that the indexer never observed an update.
- `ui-dashboard/src/components/liquidity-chart.tsx:24-155` — stacked reserve composition; same auto-bridge issue as Pool TVL.
- `ui-dashboard/src/components/snapshot-chart.tsx` cumulative line — same as above, line bridges gaps.
- `ui-dashboard/src/components/pool-volume-over-time-chart.tsx:72-95` — _has_ day-bucketed zero-fill, but reimplemented inline.
- `ui-dashboard/src/components/tvl-over-time-chart.tsx:55-184` — _has_ cursor-based forward-fill inside `buildDailySeries` (cursor walk at 142-148), but reimplemented inline. **Note:** an earlier explore pass tagged the homepage volume chart as having no gap-fill — that's wrong. `ui-dashboard/src/components/volume-over-time-chart.tsx:49-137` already zero-fills via `totalBuckets.get(timestamp) ?? 0` at line 126. The pattern is just inlined and has no shared abstraction.

Two stale knock-on effects: (a) the four non-filled charts publish line series with `connectgaps` defaulting to `true` in Plotly, so visual gaps are _invisible_ to the viewer; (b) the two inlined fillers can't be unit-tested in isolation, so we have zero direct test coverage of the bucket-alignment / cursor-walk logic that the dashboard's headline numbers depend on.

**FX weekend semantics — DECIDED 2026-04-29: option (b) + faint gray weekend band on FX pool charts.**

Filled charts render honest zeros (flow) / forward-fills (stock) regardless of weekend. The Fri 21:00 → Sun 23:00 UTC FX closure shows up as zero-bars (flow) or a flat segment (stock). On FX pool charts only, overlay a faint gray vertical band across each weekend window so viewers see at a glance "this gap is expected, markets are closed" rather than mistaking it for broken data.

- Helper stays dumb — no weekend awareness in `chart-gap-fill.ts`. Just buckets + range.
- Weekend band is a separate concern: a thin chart wrapper (or shared Plotly `shapes` config) consumed only by FX pool charts. Detect FX via `isFpmm()` / pool pair in `tokens.ts`; compute weekend windows for the visible range via `weekend.ts:tradingSecondsInRange` / `weekendOverlapSeconds`.
- Non-FX pool charts are unaffected — no detection, no band, no extra props.
- Stock-field charts (TVL, liquidity composition) get the band too, even though the line forward-fills smoothly across the weekend — the band still communicates "this segment is closed-market state, not active trading."
- Considered and rejected: option (a) (suppress weekend buckets entirely). Aligns better with the `project_fx_pool_weekends` preference to acknowledge rather than hide weekends, and avoids pushing FX awareness into the gap-fill helper API.

**Shared utility shape — `ui-dashboard/src/lib/chart-gap-fill.ts`.** Two functions, deliberately small surface:

```ts
type Point = { timestamp: number; value: number };
type Range = { from: number; to: number; bucketSeconds: number };

// Stock: every emitted bucket carries the most-recent observed value, or
// `undefined` for buckets before the first observation.
forwardFillSeries(points: readonly Point[], range: Range): Point[];

// Flow: every emitted bucket carries the observed value, or 0 for missing
// buckets in `[range.from, range.to)`.
zeroFillSeries(points: readonly Point[], range: Range): Point[];
```

Both functions emit one bucket per `bucketSeconds` step, aligned to bucket boundaries (`floor(ts / bucketSeconds) * bucketSeconds`). Both treat `range` as the half-open interval `[from, to)` matching the existing convention in `volume-over-time-chart.tsx`. Pre-bucket-aggregation (multiple input points landing in the same bucket) is the caller's responsibility for flows (sum) and stocks (last-write-wins by timestamp) — keeping that out of the helper avoids baking in a flow/stock-specific reduction.

**Per-chart migration plan.**

| Chart file                               | Current behavior                                        | Target behavior                                                                                                                                      | Fields involved                                                          | Stock or Flow                                                   |
| ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `snapshot-chart.tsx:24-131`              | None                                                    | `zeroFillSeries` for volume bars, `forwardFillSeries` for cumulative-swaps line                                                                      | `swapVolume0`, `swapVolume1` (flow); `cumulativeSwapCount` (stock)       | mixed — two helpers                                             |
| `pool-tvl-over-time-chart.tsx:59-131`    | None (sparse points + appended `now`)                   | `forwardFillSeries`; keep the appended `now` synthetic point                                                                                         | `reserves0`, `reserves1` (stock, via `poolTvlUSD`)                       | stock                                                           |
| `liquidity-chart.tsx:24-155`             | None                                                    | `forwardFillSeries` per token reserve                                                                                                                | `reserves0`, `reserves1` (stock)                                         | stock                                                           |
| `pool-volume-over-time-chart.tsx:31-131` | Inlined day-bucketed zero-fill (lines 72-95)            | Replace inline `byBucket`/loop with `zeroFillSeries` call                                                                                            | `swapVolume0`, `swapVolume1` (flow, summed via `getSnapshotVolumeInUsd`) | flow                                                            |
| `tvl-over-time-chart.tsx:55-281`         | Inlined cursor-based forward-fill in `buildDailySeries` | Keep `buildDailySeries` (it does multi-pool aggregation), but rewrite its inner cursor loop in terms of per-pool `forwardFillSeries` then bucket-sum | `reserves0`, `reserves1` per FPMM pool → `poolTvlUSD`                    | stock — must per-pool fill BEFORE bucket-sum (see Tricky cases) |
| `volume-over-time-chart.tsx:49-273`      | Inlined zero-fill via `?? 0` (line 126)                 | Replace inline aggregation+`?? 0` with `zeroFillSeries` call after per-pool bucket-aggregate                                                         | `swapVolume0`, `swapVolume1` per pool → `getSnapshotVolumeInUsd`         | flow                                                            |

**`PoolSnapshot` / `PoolDailySnapshot` field categorization.** Verified against `indexer-envio/schema.graphql:156-208`:

- **Stock (forward-fill on gaps):** `reserves0`, `reserves1`, `cumulativeSwapCount`, `cumulativeVolume0`, `cumulativeVolume1`. Cumulative fields are stocks even though the underlying swap activity is a flow — they're monotonic and the _current_ value is meaningful at any point in time.
- **Flow (zero-fill on gaps):** `swapCount`, `swapVolume0`, `swapVolume1`, `rebalanceCount`, `mintCount`, `burnCount`. Each is scoped to its bucket period (per-hour for `PoolSnapshot`, per-day for `PoolDailySnapshot`); a missing bucket means "no activity in that window", which is a _zero_, not "we don't know".
- **Forward-looking note.** Spec §2 lists fee-derived series (`cumulativeFees`, `protocolFees`, `chainProtocolFeesCum`) that aren't yet in the schema. When they land they'll follow the same rule: cumulative variants are stocks, period-scoped variants are flows.

**Tricky cases.**

1. **Multi-pool aggregation must per-pool fill BEFORE bucket-sum.** Both the homepage TVL and homepage volume charts aggregate across all FPMM pools. If you bucket-sum first and then fill, a bucket where pool A reported but pool B didn't will (a) double-count the gap on TVL (pool B's last reserves are zeroed-out instead of forward-filled, dragging the total) or (b) miss zero-bar buckets when _no_ pool reported (because the bucket simply doesn't exist in the input). The existing `buildDailySeries` cursor walk at `tvl-over-time-chart.tsx:142-148` already does this correctly per-pool. The migration must preserve that ordering: fill each pool's series, then sum-by-bucket.
2. **Plotly `connectgaps` default.** On `scatter` traces with `mode: "lines"` Plotly defaults to `connectgaps=true`, which silently bridges `null` Y-values. This is why the four no-fill charts look "fine" today — Plotly is hiding the gaps for us. After migration, line traces with stock-fill will keep visual continuity for free; line traces with flow-fill will plant explicit `0` markers and won't bridge. The migration _should not_ set `connectgaps=false` blindly — that would expose bridging gaps that are now explicitly filled, defeating the point.
3. **Cumulative fields look like flow but are stock.** `cumulativeSwapCount` rises with `swapCount`, but a missing bucket should _not_ be zero — it should hold the last observed value. The Daily Swap Volume chart's cumulative line is the most visible example today; its current dropped-points behavior makes the line jump backward across a sparse week.
4. **Pool TVL chart appends a synthetic `now` point.** `pool-tvl-over-time-chart.tsx:83-85` appends a `{ timestamp: nowSec, value: currentTvl }` point after the snapshot history. Forward-fill must respect this — the current behavior already implies "the line should reach now", so the migrated path has to either include `now` as the right-hand bucket or append the same synthetic point post-fill. Recommend the latter; the helper should not know about the live-state injection.
5. **Hourly vs daily bucket choice.** `tvl-over-time-chart.tsx:213` deliberately uses UTC-day buckets even when its `RANGE_DAYS["7d"]` window could fit hourly granularity, because `PoolDailySnapshot` is a _running_ aggregate updated mid-day; forward-filling a midnight-stamped row into hourly sub-buckets falsely shows today's current reserves for all past hours of the same day. The shared helper's `bucketSeconds` parameter has to be set by the caller; don't try to auto-detect.
6. **Existing comment in `pool-volume-over-time-chart.tsx:67-71` is the load-bearing rationale.** The "explicit $0 bars rather than dropped points, so Plotly doesn't bridge a line across inactive days and the headline total is the honest sum over the window" sentence is the design intent for the whole effort — preserve a near-verbatim version of it as the JSDoc on `zeroFillSeries`.
7. **FX weekend band overlay (separable scope).** On FX pool charts, every Fri 21:00 → Sun 23:00 UTC window in the visible range gets a faint gray vertical band so viewers read "expected closure" instead of "broken data". Implementation: a small helper `fxWeekendBands(range): PlotlyShape[]` in `ui-dashboard/src/lib/weekend.ts` (or a sibling `weekend-bands.ts`) that emits Plotly `shapes` entries with `type: "rect"`, `xref: "x"`, `yref: "paper"`, `y0: 0`, `y1: 1`, `fillcolor` at low opacity, `line.width: 0`. Charts on FX pools detect via `isFpmm()` + pool pair lookup in `tokens.ts` and spread the bands into their layout `shapes` array. Non-FX pool charts pass `[]`. Homepage aggregate charts (`tvl-over-time-chart.tsx`, `volume-over-time-chart.tsx`) sum across both FX and non-FX pools, so the band would be misleading there — _do not_ apply on aggregates. The band can ship as a follow-up PR after the gap-fill helper lands; the helper has no dependency on it.

**Test plan.**

- **Unit tests on `chart-gap-fill.ts`** (the hard part): gap at start of range, gap at end of range, gap in middle, single-point series, empty series, bucket-boundary alignment (input `ts` exactly at boundary vs mid-bucket), input out of order, input duplicate timestamps, range `from === to`, range with no input observations at all. Plus stock-specific: forward-fill before first observation returns `undefined` (not `0`); flow-specific: zero-fill returns `0` for buckets after the last observation.
- **Smoke tests on migrated components**: render with empty snapshot list (no crash), render with single snapshot (no crash, sensible display), render with sparse snapshots (correct number of buckets emitted). _Not_ a full migration regression suite — see BACKLOG tech-debt note about sparse component test coverage; chasing parity tests for these specific charts isn't worth the effort vs. unit-testing the helper hard.
- **Visual spot-check** in browser (chrome-devtools MCP): for each migrated chart, navigate to a pool with known sparse history (FX weekends, low-activity pool), confirm the chart no longer auto-bridges across known gaps.

**Estimated effort: M.** The helper itself is ~50 lines + a thorough unit suite. Six chart components touch — but four are mechanical (delete `null` filtering, wrap in helper call) and two need the careful-but-bounded multi-pool-per-bucket rework. The FX weekend band overlay is an optional follow-up (~30 lines + a small test). Risk is bounded to dashboard rendering; no indexer changes, no schema changes, no alert math. Plan ~2 days of focused work for gap-fill, half-day for the band overlay.

**Touchpoints.**

- New: `ui-dashboard/src/lib/chart-gap-fill.ts` + `ui-dashboard/src/lib/chart-gap-fill.test.ts`
- New (band overlay, follow-up PR): `fxWeekendBands()` helper in `ui-dashboard/src/lib/weekend.ts` (or sibling file) + unit test
- Edited: `ui-dashboard/src/components/snapshot-chart.tsx`, `ui-dashboard/src/components/pool-tvl-over-time-chart.tsx`, `ui-dashboard/src/components/liquidity-chart.tsx`, `ui-dashboard/src/components/pool-volume-over-time-chart.tsx`, `ui-dashboard/src/components/tvl-over-time-chart.tsx`, `ui-dashboard/src/components/volume-over-time-chart.tsx`
- Edited (band overlay only, FX pool charts): `pool-tvl-over-time-chart.tsx`, `liquidity-chart.tsx`, `pool-volume-over-time-chart.tsx`, `snapshot-chart.tsx` — homepage aggregate charts excluded (mixed FX/non-FX pools)

## Backlog — Infrastructure

- [ ] **Grafana Agent → Grafana Alloy migration** — Grafana Agent reached EOL on 2025-11-01 and is already deprecated; Grafana Alloy is the OTel-collector-based successor. Today the Agent runs on App Engine in `mento-prod` (config at `aegis/grafana-agent/agent.yaml.tmpl`) scraping both Aegis `/metrics` and metrics-bridge `/metrics`. Path: run `alloy convert` against `agent.yaml.tmpl`, swap the App Engine service image, render remote-write credentials at runtime instead of baking the materialized `agent.yaml` into the image layer, verify both scrape jobs still remote-write to Grafana Cloud, then delete the agent config. Refs: <https://grafana.com/blog/2024/04/09/grafana-agent-to-grafana-alloy-opentelemetry-collector-faq/>, <https://grafana.com/docs/alloy/latest/set-up/migrate/>

## Backlog — Future

- [ ] **Streamlit sandbox** — Python/Streamlit reads same Hasura backend
- [ ] **ClickHouse sink** — heavy analytics beyond Postgres

## Tech Debt

- [ ] **Aegis Monad reserve coverage** — the v3 critical deviation breach annotation reads `USDC_balanceOf` / `USDT_balanceOf` / `axlUSDC_balanceOf` from Aegis (see `terraform/alerts/main.tf` `local.deviation_critical_annotation_queries`), which only tracks the Celo reserve. Future Monad-reserve rebalance failures will fire the alert correctly (the underlying breach gauges are chain-agnostic) but won't get the live "Reserve Balance: X \<token\>" suffix on the _Rebalance Blocked_ line. When Mento ships a Monad reserve, add the same Treb sources to Aegis's config and add three more annotation queries (`MonadResUSDC` etc.) plus matching dispatch branches in `local.deviation_critical_rebalance_reason_annotation`, OR generalise the dispatch (e.g. label the Aegis series with `chain` and pick by `$labels.chain_name`). Prefer the latter once a second reserve exists.
- [ ] **Aegis stable-token totalSupply parser** — `aegis/src/metric.ts` still carries one switch case per 18-decimal stable token to preserve migrated behavior. Move token decimal metadata into `aegis/config.yaml` or shared config before adding more supply metrics, then collapse the duplicated parser cases.
- [ ] Dashboard component test coverage (71 test files total, but many are lib/util — component tests sparse)
- [ ] Revenue page placeholders ("CDP Borrowing Fees" and "Reserve Yield" marked "Soon")
- [ ] **Oracle update tx-hash label** — oracle alerts currently say `Last update: X ago` as plain text. Strictly better as a hyperlink to the exact on-chain `OracleReport` tx on the block explorer. Blocked on the indexer surfacing `lastOracleUpdateTxHash` (or equivalent) on the `Pool` entity — not currently tracked. Once added, the bridge exports it as a `last_oracle_update_url` label and the Slack template wraps "X ago" in `<url|text>`.
- [ ] **Migrate Aegis v2 alerts to Slack** — Aegis still posts to Discord; v3 went Slack-native (`#alerts-critical` / `#alerts-warnings`). Unify once the v3 channel pair has a week+ of soak.

---

## Done

### Indexer

- [x] Envio indexer for Celo Sepolia (VirtualPools + FPMMs)
- [x] Envio indexer for Celo Mainnet (4 FPMMs: USDm/GBPm, USDm/axlUSDC, USDm/USDC, USDT/USDm)
- [x] Envio hosted deployment: `mento-v3-celo-mainnet` live, 100% synced
- [x] Envio hosted deployment: `mento-v3-celo-sepolia` live
- [x] Oracle health state (`healthStatus`, `oracleOk`, `oraclePrice`, `priceDifference`, `rebalanceThreshold`)
- [x] OracleSnapshot entity — per-event oracle price + health timeline
- [x] SortedOracles event indexing (mainnet only)
- [x] TradingLimit entity (`limitStatus`, `limitPressure0/1`, `netflow0/1`, `limit0/1`)
- [x] Rebalancer liveness (`rebalancerAddress`, `rebalanceLivenessStatus`, `effectivenessRatio` per RebalanceEvent)
- [x] **Rebalance effectiveness rollup** — `lastEffectivenessRatio` on `Pool` (KPI 4 effectiveness half, PR #212)
- [x] PoolSnapshot pre-aggregation (volume, TVL, fees per pool per hour)
- [x] PoolDailySnapshot rollup (daily aggregation)
- [x] Pool cumulative fields (`swapCount`, `notionalVolume0/1`, `rebalanceCount`)
- [x] Deviation breach tracking (`deviationBreachStartedAt` on Pool)
- [x] **Deviation breach as first-class history entity** — per-breach entries with start/end for charting (PR #194)
- [x] **Anchor-based breach deferral for multi-`ReservesUpdated` txs** — avoids double-counting (PR #205)
- [x] **Indexer perf** — parallel oracle loops, concurrent RPC+`Pool.get`, memoised rebalancing state (PR #208)
- [x] **Bounded oracle caches** — block-keyed caches capped to prevent OOM (PR #184)
- [x] **Monad mainnet indexing live** — start block backfilled (PR #175), contracts fully indexed
- [x] **ERC20 registration gated by Mento registry** — prevents malicious fee-token registration (PR #174)
- [x] FX weekend exclusion from healthscore math
- [x] FX calendar extracted to `shared-config` package
- [x] Multichain config (`config.multichain.mainnet.yaml` — Celo + Monad)
- [x] `txHash` on all events, `@index` directives for query performance
- [x] Deploy branch strategy (`deploy/celo-mainnet`, `deploy/celo-sepolia`)
- [x] Token addresses sourced from `@mento-protocol/contracts`
- [x] Retry + fallback RPC on rate limit and block-out-of-range errors
- [x] **`pnpm generate:abis`** — refresh vendored Mento ABIs from `@mento-protocol/contracts/abis/`. Scoped to upstream-shipped ABIs (8 files); minimal hand-curated `ERC20.json` + `wormhole/*.json` stay vendored. Output committed (mirrors `nttAddresses.json`) so Envio Cloud builds don't depend on `node_modules`

### Dashboard

- [x] Live at monitoring.mento.org
- [x] Global overview page (`/`) — metrics tiles, all pools table, activity ranking
- [x] **SSR homepage + slim per-page GraphQL fetches** (PR #207)
- [x] Pool detail page (`/pools/[poolId]`) — trades, reserve chart, analytics tab
- [x] **Pool header v2** — Health Score retired; deviation breaches live in a dedicated tab with chart (PR #196)
- [x] Oracle health: HealthBadge, HealthPanel, OracleChart (dual y-axis)
- [x] Analytics tab with PoolSnapshot charts
- [x] Fully multichain — network switcher dropped, chain icon prefix on pool IDs
- [x] Token symbol mapping, `isFpmm()` in `tokens.ts`
- [x] Shared `PoolsTable` component
- [x] **CDP strategy badge** on global pools table (PR #214; stopgap RPC probe, see `Next` for indexer replacement)
- [x] LimitBadge + LimitPanel (trading limit pressure per token)
- [x] RebalancerBadge + RebalancerPanel (liveness status + diagnostics)
- [x] TVL on global page — TVL-over-time chart + tiles with 24h/7d/30d change %
- [x] TVL Δ WoW column on all pools table
- [x] Protocol Revenue page (`/revenue`) — swap fee time-series
- [x] Daily volume chart on pool detail
- [x] **Bridge-flows page v2** — pagination, status filter, duration column, range tabs (PR #173), stuck-transfer redeem CTA (PR #185), tighter table + route delivery tile + time links (PR #186), array-syntax `order_by` + chain icons on sender/receiver (PR #187)
- [x] Error boundaries + loading skeletons (route-level)
- [x] **SWR backoff + 429 retry gating** — visibility/online-aware polling (PR #202)
- [x] Google Auth (NextAuth.js — `@mentolabs.xyz` only)
- [x] **Auth hardening** — `hd` + `email_verified` check, middleware-enforced allowlist, 1h JWT (PR #190)
- [x] **Security headers** — full CSP + HSTS; removed unauthenticated GET on address labels (PR #189)
- [x] **XSS hardening** — escape user-controlled labels before Plotly renders (PR #171)
- [x] **Shared prod/preview auth posture** — documented + RSC label-leak regression guard + callback-URL sanitizer tests (PRs #172, #192)

### Shared packages

- [x] **`shared-config` chain + token metadata** — `POOL_PAIR_LABELS`, `CHAIN_NAMES`, `BLOCK_EXPLORER_BASE_URLS` extracted from `metrics-bridge/src/config.ts` and dashboard duplicates; single source of truth (PR #213)
- [x] FX calendar in `shared-config/fx-calendar.json`

### Infrastructure (Done)

- [x] Monorepo extraction from devnet repo
- [x] CI: ESLint 10 + Vitest (71 test files) + typecheck + Codecov
- [x] **Single aggregate CI workflow** — `ci.yml` fans out to `ui` / `indexer` / `bridge` via path filter; lint via Trunk is the only other required check (PR #188)
- [x] **Path filters unified + skip-holes closed** across all workflows (PRs #176, #217)
- [x] **CI pinned to commit SHAs** — `claude-code-action` + `checkout` (PR #177)
- [x] **High/critical npm advisory block** on merge (PR #191)
- [x] `pnpm deploy:indexer [network]` (prompts if no network passed)
- [x] `pnpm update-endpoint:mainnet` — Vercel env var update after indexer redeploy
- [x] Discord notification on deploy branch push (`notify-envio-deploy.yml`)
- [x] Deployment docs (`docs/deployment.md`)
- [x] Non-interactive deploy scripts (status, promote, logs)

### v3 Alerting (shipped this week)

- [x] **GCP project `mento-monitoring`** — bootstrapped via Terraform; org-level SA owner (PR #197)
- [x] **Cloud Run `metrics-bridge`** — 512Mi mem (PR #198), `cpu_idle=false`, `/health` probe path (PR #199; Cloud Run v2 reserves `/healthz` at the frontend)
- [x] **Cloud Run deploy IAM** — `serviceusage.serviceUsageConsumer` + logging writer on bridge deploy SA (PRs #216, #218)
- [x] **Workload Identity Federation** for CI deploys — no long-lived keys (PR #200)
- [x] **Image rollouts out of Terraform** — `lifecycle.ignore_changes` on image, `gcloud run services update` drives rollouts, `--revision-suffix=<sha>-<run-id>` for self-describing rollbacks (PR #201)
- [x] **Per-chain Hasura URL consolidation** — single `NEXT_PUBLIC_HASURA_URL`; dropped hosted testnet entries (PR #195)
- [x] **Bridge label alignment** — pool health rule simplified + labels match Wormholescan (PR #193)
- [x] **Schema-lag fallback removed** — post-#212 deploy-order race mooted once Envio redeploy promoted (PR #219)
- [x] **Grafana Agent scrape target** — polls `metrics-bridge` `/metrics` every 30s (aegis PR #48)
- [x] **Grafana Agent container hardening chain** — Alpine→Debian (#51), UID/GID 1000 (#52), deprecated `server:` block (#53), WAL-dir perms under non-root (#54)
- [x] **First v3 Slack alert rules** in `terraform/alerts/` — 5 groups / 9 rules across `service=fpmms` + `service=metrics-bridge` (PR #206)
- [x] **Rebalance effectiveness alert** — `mento_pool_rebalance_effectiveness` gauge + Approach B (`avg_over_time < 0.2 AND deviation_ratio >= 1 AND increase(rebalance_count_total) > 0`, `for=15m`) (PR #212)
- [x] **Slack UX** — pool pair labels populated (PR #209), tightened copy w/ oracle age (PR #211), channel name corrected to `#alerts-warnings` (PR #210)
- [x] **Channel structure decision** — severity-split (`#alerts-critical` + `#alerts-warnings`) rather than domain-split (`#alerts-v3`); routing via rule-level `notification_settings` to bypass the Aegis-owned singleton notification policy
- [x] **Rebalance probe: handle `REBALANCE_PROBE_EVERY_N_POLLS=1`** — flipped to 0-indexed cycle counter (increment AFTER probe check) + `(cycle % N) === 0` predicate. With the previous `=== 1` predicate, `cycle % 1` was always 0 so EVERY_N=1 silently disabled the probe. Cold-start invariant preserved (cycle 0 always fires). Cursor + Codex on PR #235

### Alerting (Aegis v2 — live)

- [x] Aegis NestJS service on GCP App Engine — polls v2 contract state via RPC
- [x] Grafana Agent on GCP → pushes Prometheus metrics to Grafana Cloud
- [x] **Migrate Aegis into the monorepo** — top-level `aegis/` workspace package, App Engine deploy workflow, existing Grafana Agent and `aegis` Terraform backend preserved
- [x] Grafana dashboard: "Aegis — On-chain Metrics"
- [x] Alert rules: oracle relayers (stale feeds, low CELO balance)
- [x] Alert rules: reserve balances (low USDC/USDT/axlUSDC)
- [x] Alert rules: trading modes (circuit breakers tripped)
- [x] Alert rules: trading limits (L0/L1/LG utilization >90%)
- [x] Alert rules: Aegis service health (RPC failures, data staleness)
- [x] Contact points: 8 Discord webhooks + Splunk On-Call
- [x] Notification policies with severity-based routing
- [x] Weekend mute timings for FX rate feeds
- [x] All Grafana config Terraform-managed
