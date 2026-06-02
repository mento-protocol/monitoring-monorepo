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
  POOL_ORACLE_REPORT_EXT,
  TRADING_LIMITS,
} from "@/lib/queries";
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
import { useParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
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

export function PoolDetailPageClient({
  initialSearch = windowLocationSearch(),
}: {
  initialSearch?: string;
} = {}) {
  return (
    <Suspense>
      <PoolDetail initialSearch={initialSearch} />
    </Suspense>
  );
}

type SearchParamsReader = Pick<URLSearchParams, "get" | "toString">;
type PoolNetwork = ReturnType<typeof useNetwork>["network"];
type ReplacePoolURL = (tab: Tab, limit: number) => void;
type SetTabSearch = (tab: Tab, value: string) => void;

function readSearchParam(params: SearchParamsReader, key: string) {
  return params.get(key);
}

function usePoolUrlState(initialSearch: string, normalizedPoolId: string) {
  const urlSearch = useURLSearch(initialSearch);
  const urlParams = useMemo(() => new URLSearchParams(urlSearch), [urlSearch]);

  const getCurrentParams = useCallback(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search);
    }
    return new URLSearchParams(urlParams.toString());
  }, [urlParams]);

  const replaceURL = useCallback(
    (params: URLSearchParams) => {
      if (typeof window !== "undefined") {
        const nextUrl = buildPoolDetailUrl(normalizedPoolId, params);
        window.history.replaceState(window.history.state, "", nextUrl);
        notifyURLSearchSubscribers();
      }
    },
    [normalizedPoolId],
  );

  const replacePoolURL = useCallback<ReplacePoolURL>(
    (tab, limit) => {
      const params = getCurrentParams();
      if (tab !== "providers") params.set("tab", tab);
      else params.delete("tab");
      if (limit !== 25) params.set("limit", String(limit));
      else params.delete("limit");
      replaceURL(params);
    },
    [getCurrentParams, replaceURL],
  );

  const setTabSearch = useCallback<SetTabSearch>(
    (tab, value) => {
      const params = getCurrentParams();
      const key = SEARCH_PARAM_BY_TAB[tab];
      const trimmedValue = value.trim();
      if (trimmedValue) params.set(key, trimmedValue);
      else params.delete(key);
      replaceURL(params);
    },
    [getCurrentParams, replaceURL],
  );

  return { urlParams, replacePoolURL, setTabSearch };
}

function usePoolDetailData(normalizedPoolId: string, network: PoolNetwork) {
  const {
    data: poolData,
    error: poolErr,
    isLoading: poolLoading,
  } = useGQL<{ Pool: Pool[] }>(POOL_DETAIL_WITH_HEALTH, {
    id: normalizedPoolId,
    chainId: network.chainId,
  });
  const { data: oracleReportData } = useGQL<{
    Pool: { id: string; lastOracleReportAt?: string }[];
  }>(
    POOL_ORACLE_REPORT_EXT,
    { id: normalizedPoolId, chainId: network.chainId },
    undefined,
    { timeoutMs: 5000 },
  );
  const poolWithOracleReport = useMemo<Pool | null>(() => {
    const rawPool = poolData?.Pool?.[0] ?? null;
    const oracleReport = oracleReportData?.Pool?.[0];
    return rawPool && oracleReport
      ? { ...rawPool, lastOracleReportAt: oracleReport.lastOracleReportAt }
      : rawPool;
  }, [oracleReportData, poolData]);
  const { pool, thresholdsLoading, thresholdsError } = usePoolWithThresholds(
    poolWithOracleReport,
    normalizedPoolId,
    network.chainId,
  );
  const { data: limitsData, error: limitsError } = useGQL<{
    TradingLimit: TradingLimit[];
  }>(TRADING_LIMITS, { poolId: normalizedPoolId });
  const { data: deployData } = useGQL<{
    FactoryDeployment: { txHash: string }[];
  }>(POOL_DEPLOYMENT, { poolId: normalizedPoolId });
  const { data: olsData, isLoading: olsLoading } = useGQL<{
    OlsPool: OlsPool[];
  }>(OLS_POOL, { poolId: normalizedPoolId });
  const fpmmPool = pool ? isFpmm(pool) : false;

  return {
    pool,
    poolErr,
    poolLoading,
    thresholdsLoading,
    thresholdsError,
    tradingLimits: limitsData?.TradingLimit ?? [],
    tradingLimitsError: limitsError !== undefined,
    deployTxHash: deployData?.FactoryDeployment?.[0]?.txHash,
    olsData,
    olsLoading,
    fpmmPool,
    ...useDailySnapshots(normalizedPoolId, fpmmPool),
    ...usePoolRates(pool, network),
  };
}

function usePoolTabState({
  fpmmPool,
  olsData,
  olsLoading,
  requestedTab,
  urlParams,
}: {
  fpmmPool: boolean;
  olsData: { OlsPool: OlsPool[] } | undefined;
  olsLoading: boolean;
  requestedTab: Tab;
  urlParams: URLSearchParams;
}) {
  const hasOlsPool = selectActiveOlsPool(olsData?.OlsPool) !== null;
  const olsTabVisible = hasOlsPool || olsLoading;
  const visibleTabs = useMemo(
    () =>
      TABS.filter(
        (tab) =>
          (tab !== "ols" || olsTabVisible) && (tab !== "breaches" || fpmmPool),
      ),
    [olsTabVisible, fpmmPool],
  );
  const tab = visibleTabs.includes(requestedTab)
    ? requestedTab
    : (visibleTabs[0] ?? "providers");
  const activeSearch =
    readSearchParam(urlParams, SEARCH_PARAM_BY_TAB[tab]) ?? "";

  return { visibleTabs, tab, activeSearch };
}

function PoolDetail({ initialSearch }: { initialSearch: string }) {
  const { network } = useNetwork();
  const { poolId } = useParams<{ poolId: string }>();
  const decodedId = decodePoolId(poolId);
  const normalizedPoolId = normalizePoolIdForChain(decodedId, network.chainId);
  const poolAddress = stripChainIdFromPoolId(normalizedPoolId);
  const { urlParams, replacePoolURL, setTabSearch } = usePoolUrlState(
    initialSearch,
    normalizedPoolId,
  );
  const rawTab = readSearchParam(urlParams, "tab");
  const requestedTab: Tab = TABS.includes(rawTab as Tab)
    ? (rawTab as Tab)
    : "providers";
  const limit = parseTabLimit(readSearchParam(urlParams, "limit"));
  const detail = usePoolDetailData(normalizedPoolId, network);
  const { visibleTabs, tab, activeSearch } = usePoolTabState({
    fpmmPool: detail.fpmmPool,
    olsData: detail.olsData,
    olsLoading: detail.olsLoading,
    requestedTab,
    urlParams,
  });
  const poolMissing = !detail.poolLoading && !detail.poolErr && !detail.pool;

  useEffect(() => {
    if (
      detail.pool &&
      tab !== requestedTab &&
      TABS.includes(rawTab as Tab) &&
      !visibleTabs.includes(rawTab as Tab)
    ) {
      replacePoolURL(tab, limit);
    }
  }, [
    detail.pool,
    tab,
    requestedTab,
    rawTab,
    visibleTabs,
    limit,
    replacePoolURL,
  ]);

  return (
    <div className="space-y-6">
      <PoolBreadcrumb
        pool={detail.pool}
        poolAddress={poolAddress}
        network={network}
      />

      <PoolOverview
        poolErr={detail.poolErr}
        poolLoading={detail.poolLoading}
        pool={detail.pool}
        normalizedPoolId={normalizedPoolId}
        deployTxHash={detail.deployTxHash}
        tradingLimits={detail.tradingLimits}
        tradingLimitsError={detail.tradingLimitsError}
        fpmmPool={detail.fpmmPool}
        network={network}
        dailySnapshots={detail.dailySnapshots}
        dailySnapshotLoading={detail.dailySnapshotLoading}
        dailySnapshotError={detail.dailySnapshotError}
        poolNeedsRates={detail.poolNeedsRates}
        ratesLoading={detail.ratesLoading}
        ratesError={detail.ratesError}
        thresholdsLoading={detail.thresholdsLoading}
        thresholdsError={detail.thresholdsError}
        rates={detail.rates}
      />

      {!poolMissing && (
        <>
          <PoolTablist
            visibleTabs={visibleTabs}
            active={tab}
            onSelect={(t) => replacePoolURL(t, limit)}
            limit={limit}
            onLimitChange={(l) => replacePoolURL(tab, l)}
          />

          <PoolTabPanel
            tab={tab}
            normalizedPoolId={normalizedPoolId}
            limit={limit}
            pool={detail.pool}
            activeSearch={activeSearch}
            setTabSearch={setTabSearch}
            tradingLimits={detail.tradingLimits}
            tradingLimitsError={detail.tradingLimitsError}
            fpmmPool={detail.fpmmPool}
            network={network}
            thresholdsLoading={detail.thresholdsLoading}
            thresholdsError={detail.thresholdsError}
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

function useDailySnapshots(normalizedPoolId: string, fpmmPool: boolean) {
  // Hoisted out of `_tabs/swaps-tab.tsx` so sub-hero charts render
  // independently of which tab is active. useGQL dedupes identical tab-local
  // queries by key + vars.
  const { data, error, isLoading } = useGQL<{
    PoolDailySnapshot: PoolSnapshot[];
  }>(
    fpmmPool ? POOL_DAILY_SNAPSHOTS_CHART : null,
    { poolId: normalizedPoolId },
    SNAPSHOT_REFRESH_MS,
  );
  return {
    dailySnapshots: data?.PoolDailySnapshot ?? [],
    dailySnapshotError: error,
    dailySnapshotLoading: isLoading,
  };
}

function usePoolRates(pool: Pool | null, network: PoolNetwork) {
  const poolNeedsRates = pool ? !canPricePool(pool, network, new Map()) : false;
  const { data, error } = useGQL<{
    Pool: Array<Pick<Pool, "token0" | "token1" | "oraclePrice" | "oracleOk">>;
  }>(
    poolNeedsRates ? ORACLE_RATES : null,
    { chainId: network.chainId },
    SNAPSHOT_REFRESH_MS,
  );
  const ratePools = useMemo(() => data?.Pool ?? [], [data]);
  const rates = useMemo(
    () => buildOracleRateMap(ratePools, network),
    [ratePools, network],
  );
  return {
    poolNeedsRates,
    rates,
    ratesError: error !== undefined,
    ratesLoading: poolNeedsRates && data === undefined && !error,
  };
}

const urlSearchSubscribers = new Set<() => void>();

function normalizeSearch(search: string) {
  if (!search) return "";
  return search.startsWith("?") ? search : `?${search}`;
}

function windowLocationSearch() {
  if (typeof window === "undefined") return "";
  return window.location.search;
}

function subscribeURLSearch(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  urlSearchSubscribers.add(onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    urlSearchSubscribers.delete(onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

function notifyURLSearchSubscribers() {
  for (const subscriber of urlSearchSubscribers) subscriber();
}

function useURLSearch(initialSearch: string) {
  return useSyncExternalStore(subscribeURLSearch, windowLocationSearch, () =>
    normalizeSearch(initialSearch),
  );
}
