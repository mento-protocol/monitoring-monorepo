"use client";

import { AddressLink } from "@/components/address-link";
import { BreachHistoryPanel } from "@/components/breach-history-panel";
import { ErrorBox } from "@/components/feedback";
import { HealthPanel } from "@/components/health-panel";
import { LimitPanel } from "@/components/limit-panel";
import { useNetwork } from "@/components/network-provider";
import { PoolTvlOverTimeChart } from "@/components/pool-tvl-over-time-chart";
import { PoolVolumeOverTimeChart } from "@/components/pool-volume-over-time-chart";
import { ReservesPanel } from "@/components/reserves-panel";
import { normalizePoolIdForChain } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import type { PoolDetailInitialData } from "@/lib/pool-detail-initial-data";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import {
  OLS_POOL,
  ORACLE_RATES,
  POOL_DEPLOYMENT,
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
import type { OlsPool, Pool, TradingLimit } from "@/lib/types";
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
import { HeaderCardSkeleton } from "./header-card-skeleton";
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
import { useObservedPoolDetail } from "../_lib/use-observed-pool-detail";
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
  initialData,
}: {
  initialSearch?: string;
  /** Server-prefetched pool-detail responses, forwarded to matching `useGQL`
   *  calls as `fallbackData` so the overview and extension fields paint
   *  populated. */
  initialData?: PoolDetailInitialData | undefined;
} = {}) {
  return (
    <Suspense>
      <PoolDetail initialSearch={initialSearch} initialData={initialData} />
    </Suspense>
  );
}

type SearchParamsReader = Pick<URLSearchParams, "get" | "toString">;
type PoolNetwork = ReturnType<typeof useNetwork>["network"];
type ReplacePoolURL = (tab: Tab, limit: number) => void;
type SetTabSearch = (tab: Tab, value: string) => void;
type PoolDetailProps = {
  initialSearch: string;
  initialData?: PoolDetailInitialData | undefined;
};

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

function usePoolDetailData(
  normalizedPoolId: string,
  network: PoolNetwork,
  initialData?: PoolDetailInitialData,
) {
  const {
    error: poolErr,
    isLoading: poolLoading,
    pool: observedPool,
  } = useObservedPoolDetail(normalizedPoolId, network.chainId, initialData);
  const { pool, thresholdsLoading, thresholdsError, healthRefreshError } =
    usePoolWithThresholds(
      observedPool,
      normalizedPoolId,
      network.chainId,
      initialData,
    );
  const {
    data: limitsData,
    error: limitsError,
    isLoading: limitsLoading,
  } = useGQL<{
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
    poolRefreshError: poolErr ?? healthRefreshError,
    poolLoading,
    thresholdsLoading,
    thresholdsError,
    tradingLimits: limitsData?.TradingLimit ?? [],
    tradingLimitsError: limitsError !== undefined,
    tradingLimitsLoading: isLoadingWithoutData(limitsLoading, limitsData),
    deployTxHash: deployData?.FactoryDeployment?.[0]?.txHash,
    olsData,
    olsLoading,
    fpmmPool,
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

function isPoolUnavailable({
  poolLoading,
  poolErr,
  pool,
}: {
  poolLoading: boolean;
  poolErr: Error | undefined;
  pool: Pool | null;
}): boolean {
  return (
    (!poolLoading && !poolErr && !pool) || hasErrorWithoutData(poolErr, pool)
  );
}

function PoolDetail({ initialSearch, initialData }: PoolDetailProps) {
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
  const detail = usePoolDetailData(normalizedPoolId, network, initialData);
  const { visibleTabs, tab, activeSearch } = usePoolTabState({
    fpmmPool: detail.fpmmPool,
    olsData: detail.olsData,
    olsLoading: detail.olsLoading,
    requestedTab,
    urlParams,
  });
  const poolUnavailable = isPoolUnavailable(detail);

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
        poolRefreshError={detail.poolRefreshError}
        poolLoading={detail.poolLoading}
        pool={detail.pool}
        normalizedPoolId={normalizedPoolId}
        deployTxHash={detail.deployTxHash}
        tradingLimits={detail.tradingLimits}
        tradingLimitsError={detail.tradingLimitsError}
        fpmmPool={detail.fpmmPool}
        network={network}
        poolNeedsRates={detail.poolNeedsRates}
        ratesLoading={detail.ratesLoading}
        ratesError={detail.ratesError}
        thresholdsLoading={detail.thresholdsLoading}
        thresholdsError={detail.thresholdsError}
        rates={detail.rates}
        initialData={initialData}
      />

      {!poolUnavailable && (
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
            tradingLimitsLoading={detail.tradingLimitsLoading}
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
  poolRefreshError,
  poolLoading,
  pool,
  normalizedPoolId,
  deployTxHash,
  tradingLimits,
  tradingLimitsError,
  fpmmPool,
  network,
  poolNeedsRates,
  ratesLoading,
  ratesError,
  thresholdsLoading,
  thresholdsError,
  rates,
  initialData,
}: {
  poolErr: Error | undefined;
  poolRefreshError: Error | undefined;
  poolLoading: boolean;
  pool: Pool | null;
  normalizedPoolId: string;
  deployTxHash: string | undefined;
  tradingLimits: TradingLimit[];
  tradingLimitsError: boolean;
  fpmmPool: boolean;
  network: ReturnType<typeof useNetwork>["network"];
  poolNeedsRates: boolean;
  ratesLoading: boolean;
  ratesError: boolean;
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
  rates: OracleRateMap;
  initialData?: PoolDetailInitialData | undefined;
}) {
  const poolRefreshErrorMessage = poolRefreshError?.message;
  if (hasErrorWithoutData(poolErr, pool))
    return <ErrorBox message={`Failed to load pool: ${poolErr.message}`} />;
  // Gate on data presence, not `isLoading`. SWR keeps `isLoading` true while it
  // revalidates and does NOT count `fallbackData` as "loaded data", so with the
  // SSR-prefetched fallback `poolLoading` stays true even though `pool` is already
  // present. Rendering on `pool` lets the header paint on the first (server)
  // render, eliminating the skeleton→header swap that is the measured CLS. The
  // reserved-height skeleton only shows when there is genuinely no pool yet
  // (the degraded path where the SSR prefetch missed).
  if (!pool)
    return isLoadingWithoutData(poolLoading, pool) ? (
      <HeaderCardSkeleton />
    ) : (
      <ErrorBox message={`Pool ${normalizedPoolId} not found.`} />
    );

  return (
    <>
      {poolRefreshErrorMessage !== undefined && (
        <ErrorBox
          message={`Pool health inputs refresh failed — showing the last confirmed state (${poolRefreshErrorMessage})`}
        />
      )}
      <PoolHeader
        pool={pool}
        deployTxHash={deployTxHash}
        tradingLimits={tradingLimits}
        tradingLimitsError={tradingLimitsError}
        initialV2Exchange={initialData?.v2Exchange}
        initialExchangeVolume={initialData?.brokerExchange24h}
        initialBreakerConfig={initialData?.breakerConfig}
      />
      <HealthPanel pool={pool} />
      {fpmmPool && (
        <PoolChartsRow
          pool={pool}
          network={network}
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
  poolNeedsRates,
  ratesLoading,
  ratesError,
  thresholdsLoading,
  thresholdsError,
  rates,
}: {
  pool: Pool;
  network: ReturnType<typeof useNetwork>["network"];
  poolNeedsRates: boolean;
  ratesLoading: boolean;
  ratesError: boolean;
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
  rates: OracleRateMap;
}) {
  const isLoading = (poolNeedsRates && ratesLoading) || thresholdsLoading;
  const hasError =
    (poolNeedsRates && ratesError) || thresholdsError !== undefined;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <PoolTvlOverTimeChart
        poolId={pool.id}
        pool={pool}
        network={network}
        isLoading={isLoading}
        hasError={hasError}
        rates={rates}
        historySupported
      />
      <PoolVolumeOverTimeChart
        poolId={pool.id}
        pool={pool}
        network={network}
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
  tradingLimitsLoading,
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
  tradingLimitsLoading: boolean;
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
        <ActiveTabContent
          tab={tab}
          normalizedPoolId={normalizedPoolId}
          limit={limit}
          pool={pool}
          activeSearch={activeSearch}
          setTabSearch={setTabSearch}
          tradingLimits={tradingLimits}
          tradingLimitsError={tradingLimitsError}
          tradingLimitsLoading={tradingLimitsLoading}
          fpmmPool={fpmmPool}
          network={network}
        />
      </TokenAmountTrustGate>
    </div>
  );
}

type ActiveTabContentProps = {
  tab: Tab;
  normalizedPoolId: string;
  limit: number;
  pool: Pool | null;
  activeSearch: string;
  setTabSearch: (tab: Tab, value: string) => void;
  tradingLimits: TradingLimit[];
  tradingLimitsError: boolean;
  tradingLimitsLoading: boolean;
  fpmmPool: boolean;
  network: ReturnType<typeof useNetwork>["network"];
};

// Split out of `PoolTabPanel` so the per-tab switch (one branch per entry in
// `TABS`) doesn't push the wrapper function over the repo's
// max-lines-per-function budget.
function ActiveTabContent(props: ActiveTabContentProps) {
  const {
    tab,
    normalizedPoolId,
    limit,
    pool,
    activeSearch,
    setTabSearch,
    tradingLimits,
    tradingLimitsError,
    tradingLimitsLoading,
    fpmmPool,
    network,
  } = props;
  return (
    <>
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
          isLoading={tradingLimitsLoading}
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
    </>
  );
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
