"use client";

import { AddressLink } from "@/components/address-link";
import { BreachHistoryPanel } from "@/components/breach-history-panel";
import { ErrorBox, Skeleton } from "@/components/feedback";
import { HealthPanel } from "@/components/health-panel";
import { LimitPanel } from "@/components/limit-panel";
import { useNetwork } from "@/components/network-provider";
import { PoolTvlOverTimeChart } from "@/components/pool-tvl-over-time-chart";
import { PoolVolumeOverTimeChart } from "@/components/pool-volume-over-time-chart";
import { ReservesPanel } from "@/components/reserves-panel";
import { normalizePoolIdForChain } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import {
  OLS_POOL,
  ORACLE_RATES,
  POOL_DAILY_SNAPSHOTS_CHART,
  POOL_DEPLOYMENT,
  POOL_DETAIL_WITH_HEALTH,
  TRADING_LIMITS,
} from "@/lib/queries";
import { buildPoolDetailUrl, POOL_NOT_FOUND_DEST } from "@/lib/routing";
import {
  buildOracleRateMap,
  canPricePool,
  isFpmm,
  poolName,
} from "@/lib/tokens";
import type { OlsPool, Pool, PoolSnapshot, TradingLimit } from "@/lib/types";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo } from "react";
import { OlsLiquidityTable } from "./_components/ols-liquidity-table";
import { OlsStatusPanel } from "./_components/ols-status-panel";
import { PoolHeader } from "./_components/pool-header";
import { PoolTablist } from "./_components/pool-tablist";
import { SEARCH_PARAM_BY_TAB, TABS, type Tab } from "./_lib/constants";
import {
  decodePoolId,
  getDebtTokenSideLabel,
  parseTabLimit,
  selectActiveOlsPool,
} from "./_lib/helpers";
import { LiquidityTab } from "./_tabs/liquidity-tab";
import { LpsTab } from "./_tabs/lps-tab";
import { OlsTab } from "./_tabs/ols-tab";
import { OracleTab } from "./_tabs/oracle-tab";
import {
  computeRewardThresholds,
  RebalancesTab,
  renderRewardCell,
  toDisplayPrecision,
} from "./_tabs/rebalances-tab";
import { ReservesTab } from "./_tabs/reserves-tab";
import { SwapsTab } from "./_tabs/swaps-tab";

// Re-export public symbols — `__tests__/ols.test.ts`, `page.test.tsx`,
// and `__tests__/reward-outliers.test.tsx` import these directly from
// "../page". Keep the import paths stable.
export {
  computeRewardThresholds,
  decodePoolId,
  getDebtTokenSideLabel,
  OlsLiquidityTable,
  OlsStatusPanel,
  parseTabLimit,
  renderRewardCell,
  selectActiveOlsPool,
  toDisplayPrecision,
};

export default function PoolDetailPage() {
  return (
    <Suspense>
      <PoolDetail />
    </Suspense>
  );
}

function PoolDetail() {
  const { network } = useNetwork();
  const { poolId } = useParams<{ poolId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const decodedId = decodePoolId(poolId);
  const normalizedPoolId = normalizePoolIdForChain(decodedId, network.chainId);
  const poolAddress = stripChainIdFromPoolId(normalizedPoolId);
  const rawTab = searchParams.get("tab");
  const requestedTab: Tab = TABS.includes(rawTab as Tab)
    ? (rawTab as Tab)
    : "providers";
  const limit = parseTabLimit(searchParams.get("limit"));

  const getCurrentParams = useCallback(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search);
    }
    return new URLSearchParams(searchParams.toString());
  }, [searchParams]);

  const replaceURL = useCallback(
    (params: URLSearchParams) => {
      router.replace(buildPoolDetailUrl(normalizedPoolId, params), {
        scroll: false,
      });
    },
    [router, normalizedPoolId],
  );

  const setURL = useCallback(
    (t: Tab, lim: number) => {
      const p = getCurrentParams();
      if (t !== "providers") p.set("tab", t);
      else p.delete("tab");
      if (lim !== 25) p.set("limit", String(lim));
      else p.delete("limit");
      replaceURL(p);
    },
    [getCurrentParams, replaceURL],
  );

  const setTabSearch = useCallback(
    (t: Tab, value: string) => {
      const p = getCurrentParams();
      const key = SEARCH_PARAM_BY_TAB[t];
      const trimmedValue = value.trim();
      if (trimmedValue) p.set(key, trimmedValue);
      else p.delete(key);
      replaceURL(p);
    },
    [getCurrentParams, replaceURL],
  );

  const {
    data: poolData,
    error: poolErr,
    isLoading: poolLoading,
  } = useGQL<{ Pool: Pool[] }>(POOL_DETAIL_WITH_HEALTH, {
    id: normalizedPoolId,
    chainId: network.chainId,
  });

  const pool = poolData?.Pool?.[0] ?? null;

  // Canonicalize legacy raw-address pool URLs onto namespaced multichain IDs,
  // but only after the pool resolves on the active network. That avoids
  // rewriting ambiguous raw links into a wrong namespaced id before we know the
  // current network actually serves that pool.
  useEffect(() => {
    if (!poolLoading && !poolErr && pool && decodedId !== normalizedPoolId) {
      router.replace(buildPoolDetailUrl(normalizedPoolId, searchParams), {
        scroll: false,
      });
    }
  }, [
    decodedId,
    normalizedPoolId,
    pool,
    poolErr,
    poolLoading,
    router,
    searchParams,
  ]);

  useEffect(() => {
    if (!poolLoading && !poolErr && !pool) {
      router.replace(POOL_NOT_FOUND_DEST);
    }
  }, [pool, poolLoading, poolErr, router]);

  const { data: limitsData, error: limitsError } = useGQL<{
    TradingLimit: TradingLimit[];
  }>(TRADING_LIMITS, { poolId: normalizedPoolId });
  const tradingLimits = limitsData?.TradingLimit ?? [];
  const tradingLimitsError = limitsError !== undefined;

  const { data: deployData } = useGQL<{
    FactoryDeployment: { txHash: string }[];
  }>(POOL_DEPLOYMENT, { poolId: normalizedPoolId });
  const deployTxHash = deployData?.FactoryDeployment?.[0]?.txHash;

  const { data: olsData, isLoading: olsLoading } = useGQL<{
    OlsPool: OlsPool[];
  }>(OLS_POOL, { poolId: normalizedPoolId });

  // Non-FPMM pools have no snapshot history — skip the fetch to avoid a
  // useless network round trip.
  const fpmmPool = pool ? isFpmm(pool) : false;

  // Hoisted out of `_tabs/swaps-tab.tsx` so the sub-hero TVL/volume charts
  // can render independently of which tab is active. useGQL is SWR-based and
  // dedupes by key + vars, so SwapsTab/LiquidityTab's identical
  // POOL_DAILY_SNAPSHOTS_CHART queries share this response — DO NOT remove
  // as "redundant" without also removing the tab-local copies.
  const {
    data: dailySnapshotData,
    error: dailySnapshotError,
    isLoading: dailySnapshotLoading,
  } = useGQL<{ PoolDailySnapshot: PoolSnapshot[] }>(
    fpmmPool ? POOL_DAILY_SNAPSHOTS_CHART : null,
    { poolId: normalizedPoolId },
    SNAPSHOT_REFRESH_MS,
  );
  const dailySnapshots = dailySnapshotData?.PoolDailySnapshot ?? [];

  // Non-USDm pairs (axlEUROC/EURm, etc.) need a rate map derived from all
  // pools that have a USDm leg to convert their reserves/volume to USD.
  // Without this the TVL and Volume charts render $0 for such pools.
  // Skip the fetch entirely once we can prove the current pool is already
  // USD-priceable with an empty rate map (USDm/USDC/USDT/AUSD legs) —
  // avoids a permanent 5-min-refresh background query on the common case.
  // Default to `false` while pool is still loading so USD-priceable pairs
  // never kick off the request on first render. FX pairs serialize
  // briefly behind the pool query, which is fine because charts are
  // already gated behind `!pool` below.
  //
  // Uses ORACLE_RATES (slim ~5-field query) rather than ALL_POOLS_WITH_HEALTH
  // (44 fields + non-oracleOk pools). `buildOracleRateMap`'s Pick<> matches
  // what we request, and the map output is identical.
  const poolNeedsRates = pool ? !canPricePool(pool, network, new Map()) : false;
  const { data: ratePoolsData, error: allPoolsError } = useGQL<{
    Pool: Array<Pick<Pool, "token0" | "token1" | "oraclePrice" | "oracleOk">>;
  }>(
    poolNeedsRates ? ORACLE_RATES : null,
    { chainId: network.chainId },
    SNAPSHOT_REFRESH_MS,
  );
  const ratePools = useMemo(() => ratePoolsData?.Pool ?? [], [ratePoolsData]);
  const rates = useMemo(
    () => buildOracleRateMap(ratePools, network),
    [ratePools, network],
  );
  // ratesLoading only fires for pools that actually need the fetch — a
  // USD-pegged pair with its query disabled shouldn't block chart render.
  const ratesLoading =
    poolNeedsRates && ratePoolsData === undefined && !allPoolsError;
  const ratesError = allPoolsError !== undefined;

  // Return null while redirect is pending to avoid a transient error flash
  // and unnecessary error announcement for assistive tech. MUST sit below
  // all hook declarations so React sees the same hook order every render —
  // an early return above a hook violates the Rules of Hooks and throws
  // "Rendered fewer hooks than expected" when the query resolves mid-page.
  if (!poolLoading && !poolErr && !pool) return null;
  const hasOlsPool = selectActiveOlsPool(olsData?.OlsPool) !== null;
  // Keep OLS tab visible while loading so ?tab=ols deep links don't flicker
  const olsTabVisible = hasOlsPool || olsLoading;
  // Non-FPMM pools (virtual pools) have no deviation breach model — hide
  // the tab rather than render an empty panel, same pattern as OLS.
  const visibleTabs = TABS.filter(
    (t) => (t !== "ols" || olsTabVisible) && (t !== "breaches" || fpmmPool),
  );
  const tab = visibleTabs.includes(requestedTab)
    ? requestedTab
    : (visibleTabs[0] ?? "providers");
  const activeSearch = searchParams.get(SEARCH_PARAM_BY_TAB[tab]) ?? "";

  // Canonicalize the URL when the requested tab was filtered out (e.g.
  // ?tab=breaches on a virtual pool, where the breaches tab is hidden).
  // Without this, refresh / share / back-forward render `tab` while the
  // address bar still says `requestedTab`, so users can't reproduce the
  // visible state. Same pattern as the legacy-poolId redirect above.
  useEffect(() => {
    if (
      pool &&
      tab !== requestedTab &&
      // Only rewrite when the requestedTab IS a valid Tab string but isn't
      // currently visible; bare missing/unknown tab params can stay as-is
      // because they always fall through to the default already.
      TABS.includes(rawTab as Tab) &&
      !visibleTabs.includes(rawTab as Tab)
    ) {
      setURL(tab, limit);
    }
  }, [pool, tab, requestedTab, rawTab, visibleTabs, limit, setURL]);

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-400">
        <Link href="/pools" className="hover:text-indigo-400">
          Pools
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-200">
          {pool ? (
            poolName(network, pool.token0, pool.token1)
          ) : (
            <AddressLink address={poolAddress} />
          )}
        </span>
      </nav>

      {poolErr ? (
        <ErrorBox message={`Failed to load pool: ${poolErr.message}`} />
      ) : poolLoading ? (
        <Skeleton rows={2} />
      ) : !pool ? (
        <ErrorBox message={`Pool ${normalizedPoolId} not found.`} />
      ) : (
        <>
          <PoolHeader
            pool={pool}
            deployTxHash={deployTxHash}
            tradingLimits={tradingLimits}
            tradingLimitsError={tradingLimitsError}
          />
          <HealthPanel pool={pool} />
          {/*
            TVL / Volume / Reserves panels render FPMM-only data — virtual
            pools wrap a v2 BiPoolManager exchange where reserves live in
            buckets surfaced in the V2ExchangePanel above. Hiding these
            panels avoids three "History unavailable" / "Pool has no
            reserves yet" empty states that the user can do nothing with.
            Phase 2 of the plan adds a per-exchangeId activity chart here
            for virtual pools.
          */}
          {fpmmPool && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <PoolTvlOverTimeChart
                pool={pool}
                network={network}
                snapshots={dailySnapshots}
                // Gate every "waiting on data" state on `fpmmPool`. Non-FPMM
                // pools skip both the snapshot and rate-map queries at the
                // render layer — they go straight to the
                // `historySupported={false}` branch, which shouldn't be
                // masked by a loading skeleton or error copy driven by
                // side queries that don't affect its output.
                isLoading={
                  fpmmPool &&
                  (dailySnapshotLoading || (poolNeedsRates && ratesLoading))
                }
                // Rates-query failure only surfaces as chart error for pools
                // that actually need the rate map (non-USD-pegged pairs) and
                // that would render history if they could. USDm-leg pools
                // keep rendering from the pool's own row without regard to
                // the ORACLE_RATES cross-pool fetch.
                hasError={
                  fpmmPool &&
                  (dailySnapshotError !== undefined ||
                    (poolNeedsRates && ratesError))
                }
                rates={rates}
                historySupported={fpmmPool}
              />
              <PoolVolumeOverTimeChart
                pool={pool}
                network={network}
                snapshots={dailySnapshots}
                // Gate every "waiting on data" state on `fpmmPool`. Non-FPMM
                // pools skip both the snapshot and rate-map queries at the
                // render layer — they go straight to the
                // `historySupported={false}` branch, which shouldn't be
                // masked by a loading skeleton or error copy driven by
                // side queries that don't affect its output.
                isLoading={
                  fpmmPool &&
                  (dailySnapshotLoading || (poolNeedsRates && ratesLoading))
                }
                // Rates-query failure only surfaces as chart error for pools
                // that actually need the rate map (non-USD-pegged pairs) and
                // that would render history if they could. USDm-leg pools
                // keep rendering from the pool's own row without regard to
                // the ORACLE_RATES cross-pool fetch.
                hasError={
                  fpmmPool &&
                  (dailySnapshotError !== undefined ||
                    (poolNeedsRates && ratesError))
                }
                rates={rates}
                historySupported={fpmmPool}
              />
              <ReservesPanel
                pool={pool}
                rates={rates}
                ratesLoading={poolNeedsRates && ratesLoading}
                ratesError={poolNeedsRates && ratesError}
              />
            </div>
          )}
        </>
      )}

      <PoolTablist
        visibleTabs={visibleTabs}
        active={tab}
        onSelect={(t) => setURL(t, limit)}
        limit={limit}
        onLimitChange={(l) => setURL(tab, l)}
      />

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "swaps" && (
          <SwapsTab
            poolId={normalizedPoolId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("swaps", value)}
          />
        )}
        {tab === "reserves" && (
          <ReservesTab
            poolId={normalizedPoolId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("reserves", value)}
          />
        )}
        {tab === "rebalances" && (
          <RebalancesTab
            poolId={normalizedPoolId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("rebalances", value)}
          />
        )}
        {tab === "liquidity" && (
          <LiquidityTab
            poolId={normalizedPoolId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("liquidity", value)}
          />
        )}
        {tab === "oracle" && (
          <OracleTab
            poolId={normalizedPoolId}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("oracle", value)}
          />
        )}
        {tab === "providers" && (
          <LpsTab
            poolId={normalizedPoolId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("providers", value)}
          />
        )}
        {tab === "limits" && pool && (
          <LimitPanel
            pool={pool}
            tradingLimits={tradingLimits}
            hasError={tradingLimitsError}
          />
        )}
        {tab === "breaches" && fpmmPool && pool && (
          <BreachHistoryPanel
            pool={pool}
            network={network}
            limit={limit}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("breaches", value)}
          />
        )}
        {tab === "ols" && (
          <OlsTab
            poolId={normalizedPoolId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("ols", value)}
          />
        )}
      </div>
    </div>
  );
}
