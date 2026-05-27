"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { PROTOCOL_FEE_RECIPIENT_ADDRESS } from "@mento-protocol/monitoring-config/protocol-fee";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import type { Network } from "@/lib/networks";
import {
  useAllNetworksData,
  type NetworkData,
} from "@/hooks/use-all-networks-data";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { GlobalPoolsTable } from "@/components/global-pools-table";
import { buildGlobalPoolEntries } from "@/lib/global-pool-entries";
import { TvlOverTimeChart } from "@/components/tvl-over-time-chart";
import {
  VolumeOverTimeChart,
  buildDailyVolumeSeries,
} from "@/components/volume-over-time-chart";
import { BreakdownTile } from "@/components/breakdown-tile";
import { useGQL } from "@/lib/graphql";
import {
  LEADERBOARD_TODAY_TRADERS,
  LEADERBOARD_WINDOW_TRADERS_LATEST,
} from "@/lib/queries/leaderboard";
import {
  LeaderboardTodayTradersSchema,
  LeaderboardWindowTradersLatestSchema,
} from "@/lib/queries/leaderboard-schemas";
import type { z } from "zod";

type LeaderboardWindowTradersLatest = z.infer<
  typeof LeaderboardWindowTradersLatestSchema
>;
type LeaderboardTodayTraders = z.infer<typeof LeaderboardTodayTradersSchema>;

const SECONDS_PER_DAY = 86_400;

export default function GlobalPage({
  initialNetworkData,
}: {
  initialNetworkData?: NetworkData[] | undefined;
}) {
  // First paint uses `initialNetworkData` via SWR's `fallbackData`; on
  // back-navigation the populated SWR cache wins, which is the right call —
  // cache may hold fresher data from another page's polling cycle (e.g.
  // /pools also calls useAllNetworksData under the same key). If no other
  // page has polled, the worst case is the cache matches the SSR payload
  // anyway, and the next `refreshInterval` tick will refresh either way.
  return (
    <Suspense>
      <GlobalContent initialNetworkData={initialNetworkData} />
    </Suspense>
  );
}

/**
 * For each FPMM pool with a snapshot in the window, returns current TVL (`now`)
 * and historical TVL (`ago`, using today's rates on the earliest in-window
 * reserves). Used for both the aggregate KPI delta and the per-pool WoW column,
 * ensuring both derive from a single scan.
 *
 * Uses today's oracle rate (not the historical rate) so the percentage change
 * isolates reserve-quantity movements from price movements.
 */
function perPoolTvlWindow(
  snapshots: PoolSnapshotWindow[],
  pools: Pool[],
  network: Network,
  rates: OracleRateMap,
): Map<string, { now: number | null; ago: number | null }> {
  const fpmmMap = new Map(
    pools.flatMap((p) => (isFpmm(p) ? [[p.id, p] as const] : [])),
  );
  const earliest = new Map<string, PoolSnapshotWindow>();
  for (const s of snapshots) {
    if (!fpmmMap.has(s.poolId)) continue;
    const existing = earliest.get(s.poolId);
    if (!existing || Number(s.timestamp) < Number(existing.timestamp)) {
      earliest.set(s.poolId, s);
    }
  }
  // `null` propagates "TVL unknowable for this pool" (untrusted decimals)
  // up to consumers — see `poolTvlUSD` in `lib/tokens.ts` for the rationale.
  const result = new Map<string, { now: number | null; ago: number | null }>();
  for (const [poolId, snap] of earliest) {
    const pool = fpmmMap.get(poolId)!;
    result.set(poolId, {
      now: poolTvlUSD(pool, network, rates),
      ago: poolTvlUSD(
        { ...pool, reserves0: snap.reserves0, reserves1: snap.reserves1 },
        network,
        rates,
      ),
    });
  }
  return result;
}

// Intentional react-doctor suppression: global hero + multi-section trend
// layout share the same cross-network aggregation state. Revisit only with a
// focused split that keeps those derived values centralized.
// react-doctor-disable-next-line react-doctor/no-giant-component
function GlobalContent({
  initialNetworkData,
}: {
  initialNetworkData?: NetworkData[] | undefined;
}) {
  const { networkData, isLoading } = useAllNetworksData(initialNetworkData);

  // Whether any network has a top-level, rates, snapshot, or pagination
  // failure. Used to show N/A / "partial data" in KPI tiles rather than
  // silently under-reporting. Fee data flows from `PoolDailyFeeSnapshot`
  // since PR-snapshot-3, so any failure that affects the snapshot path
  // (rates rejection ⇒ FX mis-pricing; snapshot pagination rejection ⇒
  // no data) blanks the chain-level Swap Fees tile.
  const anyNetworkError = networkData.some((netData) => netData.error !== null);
  const anyFeesError = networkData.some(
    (netData) =>
      (netData.ratesError !== null || netData.feeSnapshotsError !== null) &&
      netData.error === null,
  );
  const anyFeesTruncated = networkData.some(
    (netData) => netData.feeSnapshotsTruncated && netData.error === null,
  );
  const anySnapshots7dError = networkData.some(
    (netData) => netData.snapshots7dError !== null && netData.error === null,
  );
  const anySnapshotsAllDailyError = networkData.some(
    (netData) =>
      netData.snapshotsAllDailyError !== null && netData.error === null,
  );
  const anySnapshotsAllDailyTruncated = networkData.some(
    (netData) => netData.snapshotsAllDailyTruncated && netData.error === null,
  );
  const anyBrokerSnapshotsAllDailyError = networkData.some(
    (netData) =>
      netData.brokerSnapshotsAllDailyError !== null && netData.error === null,
  );
  const anyBrokerSnapshotsAllDailyTruncated = networkData.some(
    (netData) =>
      netData.brokerSnapshotsAllDailyTruncated && netData.error === null,
  );
  const anyLpError = networkData.some(
    (netData) => netData.lpError !== null && netData.error === null,
  );

  // Per-pool entries, volume, WoW, trading limits, OLS — shared with pools page
  const {
    entries: globalEntries,
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
    tradingLimitsByKey,
    olsPoolKeys,
    cdpPoolKeys,
    reservePoolKeys,
  } = useMemo(() => buildGlobalPoolEntries(networkData), [networkData]);

  // Aggregate KPIs across all chains for the summary tiles.
  const aggregated = useMemo(() => {
    let totalPools = 0;
    let totalFpmmPools = 0;
    let totalTvl = 0;
    // Count of pools whose TVL was unknowable (untrusted decimals → null).
    // Drives the headline's `(partial)` qualifier so the user can see when
    // the sum is provisional. Mirrors the OG path's null aggregate behavior.
    let unknownTvlPools = 0;
    let priceableTvlPools = 0;
    // Track current + historical TVL only for chains that contributed
    // snapshot data, so numerator and denominator always match. Uses the 7d
    // window so weekend oracle stalls in FX pools don't distort the delta.
    let tvlNow7d = 0;
    let tvlAgo7d = 0;
    let hasTvlSnapshots7d = false;
    let totalSwapsAllTime: number | null = anyNetworkError ? null : 0;
    let totalFeesAllTime: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees24h: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees7d: number | null = anyFeesError || anyNetworkError ? null : 0;
    let totalFees30d: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    const uniqueLpSet = new Set<string>();
    let hasSuccessfulLpResult = false;
    const unpricedSymbolSet = new Set<string>();
    let totalUnresolvedCount = 0;
    const volumeSeries = buildDailyVolumeSeries(networkData);

    for (const netData of networkData) {
      if (netData.error !== null) continue;

      const { network, pools, snapshots7d, fees, rates } = netData;
      const fpmmPools = pools.filter(isFpmm);
      totalPools += pools.length;
      totalFpmmPools += fpmmPools.length;
      // Skip pools whose TVL is unknowable (untrusted decimals → null) AND
      // count them — the summed total is `formatUSD(totalTvl)` in the
      // headline, which would otherwise misrepresent partial-trust state
      // as complete. See `poolTvlUSD` in `lib/tokens.ts` and the
      // `tvlPartial` flag plumbed into `TvlOverTimeChart` below.
      let chainTvlNow = 0;
      for (const p of fpmmPools) {
        const v = poolTvlUSD(p, network, rates);
        if (v === null) {
          unknownTvlPools += 1;
        } else {
          chainTvlNow += v;
          priceableTvlPools += 1;
        }
      }
      totalTvl += chainTvlNow;

      // 7d-window per-pool TVL — computed once, reused for the aggregate
      // KPI delta and the per-pool WoW column below. Uses the 7d window so
      // weekend FX oracle stalls don't produce Monday spikes.
      const perPool7dTvl =
        netData.snapshots7dError === null && snapshots7d.length > 0
          ? perPoolTvlWindow(snapshots7d, pools, network, rates)
          : null;
      if (perPool7dTvl && perPool7dTvl.size > 0) {
        for (const v of perPool7dTvl.values()) {
          // Skip pools whose TVL is unknowable (untrusted decimals → null).
          // Including null on either side would either NaN-poison the sum or
          // misrepresent a missing-data pool as $0 — both wrong for the WoW
          // KPI. See `poolTvlUSD` in `lib/tokens.ts`.
          if (v.now === null || v.ago === null) continue;
          tvlNow7d += v.now;
          tvlAgo7d += v.ago;
        }
        hasTvlSnapshots7d = true;
      }

      if (totalSwapsAllTime !== null) {
        totalSwapsAllTime += pools.reduce(
          (sum, p) => sum + (p.swapCount ?? 0),
          0,
        );
      }

      // Fees — `fees` is null when ratesError or feeSnapshotsError fired
      // for this network, so the null check is sufficient to gate the add.
      if (fees !== null) {
        if (totalFeesAllTime !== null) totalFeesAllTime += fees.totalFeesUSD;
        if (totalFees24h !== null) totalFees24h += fees.fees24hUSD;
        if (totalFees7d !== null) totalFees7d += fees.fees7dUSD;
        if (totalFees30d !== null) totalFees30d += fees.fees30dUSD;
        fees.unpricedSymbols.forEach((s) => unpricedSymbolSet.add(s));
        totalUnresolvedCount += fees.unresolvedCount;
      }

      // LP addresses — union across successful chains so an address that
      // provides liquidity on multiple chains counts once globally.
      // `.toLowerCase()` defends against any per-chain source returning the
      // same wallet in checksum vs. lowercase; the per-chain hook already
      // lowercases before dedup, but this layer accepts any string input.
      if (netData.uniqueLpAddresses !== null) {
        for (const addr of netData.uniqueLpAddresses)
          uniqueLpSet.add(addr.toLowerCase());
        hasSuccessfulLpResult = true;
      }
    }

    // Show N/A when no chain contributed a successful LP result OR any
    // top-level chain error means we can't claim a complete global count.
    const totalUniqueLps =
      anyNetworkError || (!hasSuccessfulLpResult && anyLpError)
        ? null
        : uniqueLpSet.size;

    return {
      totalPools,
      totalFpmmPools,
      totalTvl,
      // `tvlPartial` semantics:
      //   - `null` (no priceable pools) → headline renders "—"
      //   - `false` (every priceable pool had a value) → headline = USD total
      //   - `true` (≥1 priceable pool returned null) → headline = USD total + "(partial)"
      tvlPartial: priceableTvlPools === 0 ? null : unknownTvlPools > 0,
      volumeSeries,
      unknownTvlPools,
      totalSwapsAllTime,
      totalFeesAllTime,
      totalFees24h,
      totalFees7d,
      totalFees30d,
      totalUniqueLps,
      tvlChange7d:
        hasTvlSnapshots7d && tvlAgo7d > 0
          ? ((tvlNow7d - tvlAgo7d) / tvlAgo7d) * 100
          : null,
      unpricedSymbols: Array.from(unpricedSymbolSet).sort(),
      totalUnresolvedCount,
    };
  }, [
    networkData,
    anyNetworkError,
    anySnapshots7dError,
    anyFeesError,
    anyLpError,
  ]);

  const failedNetworks = networkData.filter((net) => net.error !== null);

  const feesApprox =
    aggregated.unpricedSymbols.length > 0 ||
    aggregated.totalUnresolvedCount > 0 ||
    anyFeesTruncated;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Global Overview</h1>
        <p className="text-sm text-slate-400">
          Protocol-wide statistics across all chains
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TvlOverTimeChart
          networkData={networkData}
          totalTvl={aggregated.totalTvl}
          tvlPartial={aggregated.tvlPartial}
          change7d={aggregated.tvlChange7d}
          isLoading={isLoading}
          hasError={anyNetworkError}
          hasSnapshotError={
            anySnapshots7dError ||
            anySnapshotsAllDailyError ||
            anySnapshotsAllDailyTruncated
          }
        />
        <VolumeOverTimeChart
          networkData={networkData}
          isLoading={isLoading}
          hasError={anyNetworkError}
          hasSnapshotError={
            anySnapshotsAllDailyError || anySnapshotsAllDailyTruncated
          }
          hasBrokerSnapshotError={
            anyBrokerSnapshotsAllDailyError ||
            anyBrokerSnapshotsAllDailyTruncated
          }
          fullVolumeSeries={aggregated.volumeSeries}
        />
      </div>

      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <BreakdownTile
            label="Swap Fees"
            total={aggregated.totalFeesAllTime}
            sub24h={aggregated.totalFees24h}
            sub7d={aggregated.totalFees7d}
            sub30d={aggregated.totalFees30d}
            isLoading={isLoading}
            hasError={anyNetworkError || anyFeesError}
            format={formatUSD}
            totalPrefix={feesApprox ? "≈ " : ""}
            href={`https://debank.com/profile/${PROTOCOL_FEE_RECIPIENT_ADDRESS}`}
            subtitle={
              anyFeesTruncated
                ? "Approximate — full history exceeds pagination cap"
                : aggregated.unpricedSymbols.length > 0
                  ? `Approximate — unpriced: ${aggregated.unpricedSymbols.join(", ")}`
                  : aggregated.totalUnresolvedCount > 0
                    ? "Approximate — some tokens unresolved"
                    : undefined
            }
          />

          <Tile
            label="LPs"
            value={
              isLoading
                ? "…"
                : aggregated.totalUniqueLps === null
                  ? "N/A"
                  : aggregated.totalUniqueLps.toLocaleString()
            }
            subtitle={
              // totalUniqueLps is forced to null whenever any chain failed at
              // the top level, so the subtitle must degrade for network errors
              // too — not just lpError — otherwise we'd claim a complete
              // global metric while actually showing N/A.
              anyNetworkError || anyLpError
                ? "Partial — some chains failed to load"
                : "Unique LP addresses across all chains"
            }
          />

          <Tile
            label="Swaps"
            value={
              isLoading
                ? "…"
                : aggregated.totalSwapsAllTime === null
                  ? "N/A"
                  : aggregated.totalSwapsAllTime.toLocaleString()
            }
            subtitle="All-time across all pools"
          />
          <TradersTile isLoading={isLoading} networkData={networkData} />
        </div>
      </section>

      {failedNetworks.map((net) => (
        <ErrorBox
          key={net.network.id}
          message={`${net.network.label}: Failed to load pools — ${net.error?.message}`}
        />
      ))}

      <section>
        <h2 className="text-lg font-semibold text-white mb-3">All Pools</h2>
        {isLoading ? (
          <Skeleton rows={5} />
        ) : failedNetworks.length === 0 && globalEntries.length === 0 ? (
          <EmptyBox message="No pools found across any chain." />
        ) : (
          <GlobalPoolsTable
            entries={globalEntries}
            volume24hByKey={volume24hByKey}
            volume7dByKey={volume7dByKey}
            tvlChangeWoWByKey={tvlChangeWoWByKey}
            tradingLimitsByKey={tradingLimitsByKey}
            olsPoolKeys={olsPoolKeys}
            cdpPoolKeys={cdpPoolKeys}
            reservePoolKeys={reservePoolKeys}
          />
        )}
      </section>
    </div>
  );
}

// Homepage Traders KPI tile. Counts unique v3 traders across all chains
// via the pre-rolled `LeaderboardWindowSnapshot(windowKey: "all")
// .windowTraders` array (system addresses — rebalancers, OLS, reserve
// strategy — excluded by default, matching the LPs tile semantics). The
// address list is unioned client-side so a wallet active on multiple
// chains counts once. Isolated from LEADERBOARD_WINDOW_LATEST so a
// Hasura "field not found" during the indexer deploy/resync window
// degrades only this tile (renders "N/A"), not the rest of the page.
//
// Placed below `GlobalContent` so its declaration doesn't drift the
// parent's starting line past the eslint baseline-diff proximity window;
// function declarations hoist, so calling it from inside `GlobalContent`
// is fine.
function TradersTile({
  isLoading,
  networkData,
}: {
  isLoading: boolean;
  networkData: NetworkData[];
}) {
  const snapshotGql = useGQL<LeaderboardWindowTradersLatest>(
    LEADERBOARD_WINDOW_TRADERS_LATEST,
    { windowKey: "all" },
    {
      schema: LeaderboardWindowTradersLatestSchema,
      // The "all" window snapshot only rolls over at the per-chain
      // UTC-midnight heartbeat (see
      // indexer-envio/src/leaderboardWindowFlush.ts), so the default
      // 30s polling cadence is wildly over-cadenced for this tile. 5min
      // keeps a fresh-after-rollover read without burning the Envio
      // "small" tier quota for a multi-KB address list on every poll.
      refreshInterval: 5 * 60_000,
      // Required by docs/pr-checklists/swr-polling-hasura.md §1 — without
      // a request-level timeout, a wedged TCP connection would hold the
      // poll open for the full 5min interval. 30s is conservative for
      // the long interval (the canonical 8s example pairs with a 10s
      // poll); the trader address list is small enough that 30s never
      // legitimately times out on healthy Hasura.
      timeoutMs: 30_000,
    },
  );
  // Today's traders aren't yet in the closed-day snapshot (the heartbeat
  // only flushes at the next UTC midnight on the first swap of the new
  // day), so without this merge a wallet whose first-ever v3 swap is
  // today would silently drop out of the all-time count for up to 24h.
  // Mirrors the leaderboard hero's today-partial union in
  // `useHeroRollup` (`mergeHeroSnapshot`). `useUtcDayKey` resets the
  // today-partial query window at each UTC rollover (see hook
  // definition below for the polling rationale).
  const utcDayKey = useUtcDayKey();
  const todayMidnight = utcDayKey * SECONDS_PER_DAY;
  const todayGql = useGQL<LeaderboardTodayTraders>(
    LEADERBOARD_TODAY_TRADERS,
    { todayMidnight, isSystemAddressIn: [false] },
    {
      schema: LeaderboardTodayTradersSchema,
      refreshInterval: 5 * 60_000,
      timeoutMs: 30_000,
    },
  );
  // Three distinct partial-data states surface as the same `≈` badge,
  // but each carries a distinct subtitle reason so the user can tell
  // them apart:
  //
  //   - `hasMissingOrStaleChain`: a configured chain either has no
  //     `LeaderboardWindowSnapshot` row at all (heartbeat hasn't fired
  //     yet) OR its row's `snapshotDay` lags behind yesterday's UTC
  //     midnight. In either case, closed days for that chain are
  //     absent from `windowTraders` (capped at snapshotDay or empty
  //     entirely) and the today-partial query (timestamp >=
  //     todayMidnight). The count understates by the missing chain or
  //     missing-day deltas.
  //   - `todayPartialMissing`: the today-partial query errored, so any
  //     wallet whose first-ever v3 swap is today is silently dropped
  //     from the union. The closed-day count is still trustworthy on
  //     its own, but the "all-time" framing isn't.
  //
  // The `count === null` branch ALSO covers snapshot returned-but-empty
  // (no chains have any data yet — e.g. fresh indexer, schema-lag
  // returning the shape with zero rows). `0` would otherwise read as a
  // real metric (LP tile uses the same null-fallback pattern).
  const yesterdayMidnight = (utcDayKey - 1) * SECONDS_PER_DAY;
  const expectedChainIds = useMemo(
    () => new Set(networkData.map((n) => n.network.chainId)),
    [networkData],
  );
  // Both queries are scoped to chains the dashboard knows about — Hasura
  // may return rows for additional chains the indexer covers (e.g. an
  // experimental chain not yet wired into `useAllNetworksData`), and
  // including those would inflate the count vs the LPs/Swaps tiles AND
  // can spuriously flip the stale-chain badge on data the dashboard
  // doesn't otherwise display. `scopedSnapshotRows` and the
  // `expectedChainIds.has(row.chainId)` filter in the today-partial
  // loop pin both halves to the configured network set.
  const scopedSnapshotRows = useMemo(
    () =>
      (snapshotGql.data?.LeaderboardWindowSnapshot ?? []).filter((r) =>
        expectedChainIds.has(r.chainId),
      ),
    [snapshotGql.data, expectedChainIds],
  );
  const hasMissingOrStaleChain = useMemo(() => {
    const returnedChainIds = new Set(scopedSnapshotRows.map((r) => r.chainId));
    for (const id of expectedChainIds) {
      if (!returnedChainIds.has(id)) return true;
    }
    return scopedSnapshotRows.some(
      (row) => Number(row.snapshotDay) < yesterdayMidnight,
    );
  }, [scopedSnapshotRows, expectedChainIds, yesterdayMidnight]);
  const todayPartialMissing = todayGql.error !== undefined;
  // `partialReason` is null when the count is complete. When set it
  // selects both the `≈` prefix and the matching subtitle copy. Chain
  // coverage wins over today-error when both fire (the chain gap is
  // strictly worse — entire closed days missing, not just today's
  // first-time traders).
  const partialReason: "chain" | "today" | null = hasMissingOrStaleChain
    ? "chain"
    : todayPartialMissing
      ? "today"
      : null;
  const count = useMemo(() => {
    if (snapshotGql.error) return null;
    if (!snapshotGql.data) return null;
    if (scopedSnapshotRows.length === 0) return null;
    const set = new Set<string>();
    for (const row of scopedSnapshotRows) {
      for (const addr of row.windowTraders) set.add(addr.toLowerCase());
    }
    // Today's partial merge — only when the query has settled with
    // data. If it's still loading we render the closed-day count alone
    // and the snapshot is the load-bearing data (no degradation
    // signal). If it errored, we still skip the merge but flag
    // `todayPartialMissing` above so the tile renders with "≈ N" +
    // "Approximate — today's partial unavailable". Network-scoped to
    // expected chain IDs for the same reason as the snapshot half.
    if (todayGql.data) {
      for (const row of todayGql.data.TraderDailySnapshot) {
        if (!expectedChainIds.has(row.chainId)) continue;
        set.add(row.trader.toLowerCase());
      }
    }
    return set.size;
  }, [
    snapshotGql.data,
    snapshotGql.error,
    scopedSnapshotRows,
    todayGql.data,
    expectedChainIds,
  ]);
  // `isLoading` (from `useAllNetworksData`) folds the page-level fetch
  // race into the tile's loading sentinel: the snapshot query is a
  // single Hasura request and routinely finishes BEFORE the per-network
  // fan-out behind `useAllNetworksData`. Without this, the tile would
  // flip to a confirmed number while the sibling KPI tiles still
  // render "…" — UX-confusing, especially on the empty-data race
  // where a transient "0" would read as a real count.
  // The today-partial is also part of the "is the count complete"
  // signal — if it's still loading (vs settled or errored), the count
  // is the snapshot-only subtotal and any wallet whose first-ever v3
  // trade is today is missing. Stay on "…" until BOTH halves have
  // settled (either with data or with an error — the error branch is
  // handled below by `partialReason`).
  let value: string;
  if (isLoading || snapshotGql.isLoading || todayGql.isLoading) value = "…";
  else if (count === null) value = "N/A";
  else
    value =
      partialReason === null
        ? count.toLocaleString()
        : `≈ ${count.toLocaleString()}`;
  // When `count === null` the value is "N/A" or "…"; the canonical
  // subtitle is correct (no partial number to qualify) regardless of
  // whether the today-partial errored.
  let subtitle: string;
  if (count === null || partialReason === null) {
    subtitle = "Unique addresses that traded on v3";
  } else if (partialReason === "chain") {
    subtitle = "Approximate — chain snapshot catching up";
  } else {
    subtitle = "Approximate — today's partial unavailable";
  }
  return <Tile label="Traders" value={value} subtitle={subtitle} />;
}

// Minute-polled UTC-day ticker. Returns an integer day-since-epoch
// that flips at UTC midnight, so any `useMemo` / `useGQL` variables
// keyed on it (`todayMidnight`, the today-partial query window)
// reset every day. Mirrors the leaderboard hero's pattern in
// `_lib/url-state.ts:useLeaderboardUrlState` — `setTimeout` to
// midnight isn't reliable because backgrounded tabs throttle timers,
// so we poll. Without this, a wallboard tab left open across
// midnight would keep querying `TraderDailySnapshot` from the
// original day forever and eventually hit the `limit: 1000`
// truncation as the slice grew multi-day.
function useUtcDayKey(): number {
  const [key, setKey] = useState<number>(() =>
    Math.floor(Date.now() / 1000 / SECONDS_PER_DAY),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.setInterval(() => {
      setKey((prev) => {
        const next = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
        return next === prev ? prev : next;
      });
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return key;
}
