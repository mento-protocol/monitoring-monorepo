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
import { PoolDetailWithHealthSchema } from "@/lib/queries/pool-detail-schemas";
import { buildPoolDetailUrl } from "@/lib/routing";
import {
  buildOracleRateMap,
  canPricePool,
  isFpmm,
  poolName,
  type OracleRateMap,
} from "@/lib/tokens";
import type { OlsPool, Pool, PoolSnapshot, TradingLimit } from "@/lib/types";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo } from "react";
import { PoolHeader } from "./pool-header";
import { PoolTablist } from "./pool-tablist";
import {
  isTokenAmountTab,
  TokenAmountTrustGate,
  TokenDecimalsTrustNotice,
} from "./token-decimals-trust-notice";
import { SEARCH_PARAM_BY_TAB, TABS, type Tab } from "../_lib/constants";
import {
  decodePoolId,
  parseTabLimit,
  selectActiveOlsPool,
} from "../_lib/helpers";
import { usePoolWithThresholds } from "../_lib/use-pool-with-thresholds";
import { LiquidityTab } from "../_tabs/liquidity-tab";
import { LpsTab } from "../_tabs/lps-tab";
import { OlsTab } from "../_tabs/ols-tab";
import { OracleTab } from "../_tabs/oracle-tab";
import { RebalancesTab } from "../_tabs/rebalances-tab";
import { ReservesTab } from "../_tabs/reserves-tab";
import { SwapsTab } from "../_tabs/swaps-tab";

export function PoolDetailPageClient() {
  return (
    <Suspense>
      <PoolDetail />
    </Suspense>
  );
}

type SearchParamsReader = Pick<URLSearchParams, "get" | "toString">;

function readSearchParam(params: SearchParamsReader, key: string) {
  return params.get(key);
}

function PoolDetail() {
  const { network } = useNetwork();
  const { poolId } = useParams<{ poolId: string }>();
  const searchParams = useSearchParams();
  const { replace } = useRouter();

  const decodedId = decodePoolId(poolId);
  const normalizedPoolId = normalizePoolIdForChain(decodedId, network.chainId);
  const poolAddress = stripChainIdFromPoolId(normalizedPoolId);
  const rawTab = readSearchParam(searchParams, "tab");
  const requestedTab: Tab = TABS.includes(rawTab as Tab)
    ? (rawTab as Tab)
    : "providers";
  const limit = parseTabLimit(readSearchParam(searchParams, "limit"));

  const getCurrentParams = useCallback(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search);
    }
    return new URLSearchParams(searchParams.toString());
  }, [searchParams]);

  const replaceURL = useCallback(
    (params: URLSearchParams) => {
      replace(buildPoolDetailUrl(normalizedPoolId, params), {
        scroll: false,
      });
    },
    [replace, normalizedPoolId],
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
  } = useGQL<{ Pool: Pool[] }>(
    POOL_DETAIL_WITH_HEALTH,
    { id: normalizedPoolId, chainId: network.chainId },
    undefined,
    { schema: PoolDetailWithHealthSchema },
  );

  const { pool, thresholdsLoading, thresholdsError } = usePoolWithThresholds(
    poolData?.Pool?.[0] ?? null,
    normalizedPoolId,
    network.chainId,
  );

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

  const hasOlsPool = selectActiveOlsPool(olsData?.OlsPool) !== null;
  // Keep OLS tab visible while loading so ?tab=ols deep links don't flicker
  const olsTabVisible = hasOlsPool || olsLoading;
  // Non-FPMM pools (virtual pools) have no deviation breach model — hide
  // the tab rather than render an empty panel, same pattern as OLS.
  const visibleTabs = useMemo(
    () =>
      TABS.filter(
        (t) => (t !== "ols" || olsTabVisible) && (t !== "breaches" || fpmmPool),
      ),
    [olsTabVisible, fpmmPool],
  );
  const tab = visibleTabs.includes(requestedTab)
    ? requestedTab
    : (visibleTabs[0] ?? "providers");
  const activeSearch =
    readSearchParam(searchParams, SEARCH_PARAM_BY_TAB[tab]) ?? "";
  const poolMissing = !poolLoading && !poolErr && !pool;

  // Canonicalize the URL when the requested tab was filtered out (e.g.
  // ?tab=breaches on a virtual pool, where the breaches tab is hidden).
  // Without this, refresh / share / back-forward render `tab` while the
  // address bar still says `requestedTab`, so users can't reproduce the
  // visible state. Same pattern as the legacy-poolId redirect above.
  //
  // MUST sit ABOVE the `!pool` early-return below — putting it after the
  // return changes the hook count between the loading-render (effect
  // fires) and the not-found-render (effect doesn't fire), which trips
  // React's "rendered fewer hooks" guard.
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
      <PoolBreadcrumb pool={pool} poolAddress={poolAddress} network={network} />

      <PoolOverview
        poolErr={poolErr}
        poolLoading={poolLoading}
        pool={pool}
        normalizedPoolId={normalizedPoolId}
        deployTxHash={deployTxHash}
        tradingLimits={tradingLimits}
        tradingLimitsError={tradingLimitsError}
        fpmmPool={fpmmPool}
        network={network}
        dailySnapshots={dailySnapshots}
        dailySnapshotLoading={dailySnapshotLoading}
        dailySnapshotError={dailySnapshotError}
        poolNeedsRates={poolNeedsRates}
        ratesLoading={ratesLoading}
        ratesError={ratesError}
        thresholdsLoading={thresholdsLoading}
        thresholdsError={thresholdsError}
        rates={rates}
      />

      {!poolMissing && (
        <>
          <PoolTablist
            visibleTabs={visibleTabs}
            active={tab}
            onSelect={(t) => setURL(t, limit)}
            limit={limit}
            onLimitChange={(l) => setURL(tab, l)}
          />

          <PoolTabPanel
            tab={tab}
            normalizedPoolId={normalizedPoolId}
            limit={limit}
            pool={pool}
            activeSearch={activeSearch}
            setTabSearch={setTabSearch}
            tradingLimits={tradingLimits}
            tradingLimitsError={tradingLimitsError}
            fpmmPool={fpmmPool}
            network={network}
            thresholdsLoading={thresholdsLoading}
            thresholdsError={thresholdsError}
          />
        </>
      )}
    </div>
  );
}

function PoolBreadcrumb({
  pool,
  poolAddress,
  network,
}: {
  pool: Pool | null;
  poolAddress: string;
  network: ReturnType<typeof useNetwork>["network"];
}) {
  return (
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
  );
}

function PoolOverview({
  poolErr,
  poolLoading,
  pool,
  normalizedPoolId,
  deployTxHash,
  tradingLimits,
  tradingLimitsError,
  fpmmPool,
  network,
  dailySnapshots,
  dailySnapshotLoading,
  dailySnapshotError,
  poolNeedsRates,
  ratesLoading,
  ratesError,
  thresholdsLoading,
  thresholdsError,
  rates,
}: {
  poolErr: Error | undefined;
  poolLoading: boolean;
  pool: Pool | null;
  normalizedPoolId: string;
  deployTxHash: string | undefined;
  tradingLimits: TradingLimit[];
  tradingLimitsError: boolean;
  fpmmPool: boolean;
  network: ReturnType<typeof useNetwork>["network"];
  dailySnapshots: PoolSnapshot[];
  dailySnapshotLoading: boolean;
  dailySnapshotError: Error | undefined;
  poolNeedsRates: boolean;
  ratesLoading: boolean;
  ratesError: boolean;
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
  rates: OracleRateMap;
}) {
  if (poolErr)
    return <ErrorBox message={`Failed to load pool: ${poolErr.message}`} />;
  if (poolLoading) return <Skeleton rows={2} />;
  if (!pool)
    return <ErrorBox message={`Pool ${normalizedPoolId} not found.`} />;

  return (
    <>
      <PoolHeader
        pool={pool}
        deployTxHash={deployTxHash}
        tradingLimits={tradingLimits}
        tradingLimitsError={tradingLimitsError}
      />
      <HealthPanel pool={pool} />
      {fpmmPool && (
        <PoolChartsRow
          pool={pool}
          network={network}
          dailySnapshots={dailySnapshots}
          dailySnapshotLoading={dailySnapshotLoading}
          dailySnapshotError={dailySnapshotError}
          poolNeedsRates={poolNeedsRates}
          ratesLoading={ratesLoading}
          ratesError={ratesError}
          thresholdsLoading={thresholdsLoading}
          thresholdsError={thresholdsError}
          rates={rates}
        />
      )}
    </>
  );
}

function PoolChartsRow({
  pool,
  network,
  dailySnapshots,
  dailySnapshotLoading,
  dailySnapshotError,
  poolNeedsRates,
  ratesLoading,
  ratesError,
  thresholdsLoading,
  thresholdsError,
  rates,
}: {
  pool: Pool;
  network: ReturnType<typeof useNetwork>["network"];
  dailySnapshots: PoolSnapshot[];
  dailySnapshotLoading: boolean;
  dailySnapshotError: Error | undefined;
  poolNeedsRates: boolean;
  ratesLoading: boolean;
  ratesError: boolean;
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
  rates: OracleRateMap;
}) {
  const isLoading =
    dailySnapshotLoading ||
    (poolNeedsRates && ratesLoading) ||
    thresholdsLoading;
  const hasError =
    dailySnapshotError !== undefined ||
    (poolNeedsRates && ratesError) ||
    thresholdsError !== undefined;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <PoolTvlOverTimeChart
        pool={pool}
        network={network}
        snapshots={dailySnapshots}
        isLoading={isLoading}
        hasError={hasError}
        rates={rates}
        historySupported
      />
      <PoolVolumeOverTimeChart
        pool={pool}
        network={network}
        snapshots={dailySnapshots}
        isLoading={isLoading}
        hasError={hasError}
        rates={rates}
        historySupported
      />
      <ReservesPanel
        pool={pool}
        rates={rates}
        ratesLoading={poolNeedsRates && ratesLoading}
        ratesError={poolNeedsRates && ratesError}
        decimalsLoading={thresholdsLoading}
        decimalsError={thresholdsError !== undefined}
      />
    </div>
  );
}

function PoolTabPanel({
  tab,
  normalizedPoolId,
  limit,
  pool,
  activeSearch,
  setTabSearch,
  tradingLimits,
  tradingLimitsError,
  fpmmPool,
  network,
  thresholdsLoading,
  thresholdsError,
}: {
  tab: Tab;
  normalizedPoolId: string;
  limit: number;
  pool: Pool | null;
  activeSearch: string;
  setTabSearch: (tab: Tab, value: string) => void;
  tradingLimits: TradingLimit[];
  tradingLimitsError: boolean;
  fpmmPool: boolean;
  network: ReturnType<typeof useNetwork>["network"];
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
}) {
  return (
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      <TokenDecimalsTrustNotice
        pool={pool}
        thresholdsLoading={thresholdsLoading}
        thresholdsError={thresholdsError}
      />
      <TokenAmountTrustGate
        active={isTokenAmountTab(tab)}
        pool={pool}
        thresholdsLoading={thresholdsLoading}
        thresholdsError={thresholdsError}
      >
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
      </TokenAmountTrustGate>
    </div>
  );
}
