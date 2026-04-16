"use client";

import { AddressLink } from "@/components/address-link";
import { useAddressLabels } from "@/components/address-labels-provider";
import { KindBadge, SourceBadge } from "@/components/badges";
import { DeviationCell } from "@/components/pool-header/deviation-cell";
import {
  HealthScoreInfoIcon,
  HealthScoreValue,
} from "@/components/pool-header/health-score-value";
import { OraclePriceValue } from "@/components/pool-header/oracle-price-value";
import { OracleStatusValue } from "@/components/pool-header/oracle-status-value";
import { RebalanceStatusValue } from "@/components/pool-header/rebalance-status-value";
import { LimitSelect } from "@/components/controls";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { HealthPanel } from "@/components/health-panel";
import { LimitPanel } from "@/components/limit-panel";
import { ReservesPanel } from "@/components/reserves-panel";
import { useNetwork } from "@/components/network-provider";
import { OracleChart } from "@/components/oracle-chart";
import { OraclePriceChart } from "@/components/oracle-price-chart";
import { ReserveChart } from "@/components/reserve-chart";
import { SenderCell } from "@/components/sender-cell";
import { TagsCell } from "@/components/tags-cell";
import { LiquidityChart } from "@/components/liquidity-chart";
import { LpConcentrationChart } from "@/components/lp-concentration-chart";
import { SnapshotChart } from "@/components/snapshot-chart";
import { Row, Table, Td, Th } from "@/components/table";
import { TableSearch } from "@/components/table-search";
import { TxHashCell } from "@/components/tx-hash-cell";
import {
  formatBlock,
  formatTimestamp,
  formatWei,
  getSwapDirection,
  normalizePoolIdForChain,
  parseWei,
  parseOraclePriceToNumber,
  relativeTime,
  toPercent,
} from "@/lib/format";
import {
  DEFAULT_PAGE_SIZE,
  ENVIO_MAX_ROWS,
  SEARCH_BOOTSTRAP_LIMIT,
  SEARCH_MAX_LIMIT,
} from "@/lib/constants";
import { buildOrderBy } from "@/lib/table-sort";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import { useGQL } from "@/lib/graphql";
import {
  ORACLE_SNAPSHOTS,
  ORACLE_SNAPSHOTS_CHART,
  ORACLE_SNAPSHOTS_COUNT_PAGE,
  OLS_LIQUIDITY_EVENTS_COUNT,
  OLS_LIQUIDITY_EVENTS_PAGE,
  OLS_POOL,
  POOL_DAILY_SNAPSHOTS_CHART,
  POOL_DEPLOYMENT,
  POOL_DETAIL_WITH_HEALTH,
  POOL_LIQUIDITY_COUNT,
  POOL_LIQUIDITY_PAGE,
  POOL_LP_POSITIONS,
  POOL_REBALANCES_COUNT,
  POOL_REBALANCES_PAGE,
  POOL_RESERVES,
  POOL_SWAPS_COUNT,
  POOL_SWAPS_PAGE,
  TRADING_LIMITS,
} from "@/lib/queries";
import { Pagination } from "@/components/pagination";
import {
  explorerAddressUrl,
  isFpmm,
  poolName,
  tokenSymbol,
  USDM_SYMBOLS,
} from "@/lib/tokens";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import {
  buildSearchBlob,
  matchesSearch,
  normalizeSearch,
} from "@/lib/table-search";
import type {
  LiquidityEvent,
  LiquidityPosition,
  OlsLiquidityEvent,
  OlsPool,
  OracleSnapshot,
  Pool,
  PoolSnapshot,
  RebalanceEvent,
  ReserveUpdate,
  SwapEvent,
  TradingLimit,
} from "@/lib/types";
import { NetworkAwareLink } from "@/components/network-aware-link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import React, { Suspense, useCallback, useEffect, useMemo } from "react";
import { buildPoolDetailUrl, buildPoolNotFoundDest } from "@/lib/routing";

export default function PoolDetailPage() {
  return (
    <Suspense>
      <PoolDetail />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------

const TABS = [
  "providers",
  "swaps",
  "reserves",
  "rebalances",
  "liquidity",
  "oracle",
  "ols",
] as const;
type Tab = (typeof TABS)[number];
type SearchableTab = Extract<
  Tab,
  | "providers"
  | "swaps"
  | "reserves"
  | "rebalances"
  | "liquidity"
  | "oracle"
  | "ols"
>;

const SEARCH_PARAM_BY_TAB: Record<SearchableTab, string> = {
  providers: "providersQ",
  swaps: "swapsQ",
  reserves: "reservesQ",
  rebalances: "rebalancesQ",
  liquidity: "liquidityQ",
  oracle: "oracleQ",
  ols: "olsQ",
};

function isSearchableTab(tab: Tab): tab is SearchableTab {
  return (
    tab === "providers" ||
    tab === "swaps" ||
    tab === "reserves" ||
    tab === "rebalances" ||
    tab === "liquidity" ||
    tab === "oracle" ||
    tab === "ols"
  );
}

function addressSearchTerms(
  address: string | null | undefined,
  getName: (address: string | null) => string,
  getTags: (address: string | null) => string[],
): Array<string | null | undefined> {
  if (!address) return [];
  return [address, getName(address), ...getTags(address)];
}

function matchesRowSearch(
  query: string,
  parts: Array<string | number | null | undefined>,
): boolean {
  return matchesSearch(buildSearchBlob(parts), query);
}

function getTabLabel(tab: Tab) {
  if (tab === "providers") return "LPs";
  if (tab === "ols") return "OLS";
  return tab;
}

export function getDebtTokenSideLabel(
  pool: Pool | null,
  debtToken: string,
): "token0" | "token1" | "unknown" {
  if (!pool?.token0 || !pool?.token1 || !debtToken) return "unknown";
  const normalizedDebtToken = debtToken.toLowerCase();
  if (pool.token0.toLowerCase() === normalizedDebtToken) return "token0";
  if (pool.token1.toLowerCase() === normalizedDebtToken) return "token1";
  return "unknown";
}

/**
 * Defensive selector for the current OLS row shown in the pool detail view.
 *
 * The GraphQL query already filters `isActive = true`, but this helper makes the
 * UI robust against stale/misconfigured query changes and gives us a focused
 * regression test for multi-registration pools.
 */
export function selectActiveOlsPool(
  rows: OlsPool[] | null | undefined,
): OlsPool | null {
  if (!rows || rows.length === 0) return null;

  const activeRows = rows.filter((row) => row.isActive);
  if (activeRows.length === 0) return null;

  return (
    [...activeRows].sort(
      (a, b) => Number(b.updatedAtTimestamp) - Number(a.updatedAtTimestamp),
    )[0] ?? null
  );
}

export function decodePoolId(rawPoolId: string): string {
  try {
    return decodeURIComponent(rawPoolId);
  } catch {
    return rawPoolId;
  }
}

const MAX_TAB_LIMIT = 200;

export function parseTabLimit(rawLimit: string | null): number {
  const parsed = Number(rawLimit ?? "25");
  if (!Number.isInteger(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, MAX_TAB_LIMIT);
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
    (t: SearchableTab, value: string) => {
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

  // Pool not found on the current network → redirect to the active
  // network's /pools. Using network.id (not the pool id's chainId) honors a
  // selector change the user may have just made.
  useEffect(() => {
    if (!poolLoading && !poolErr && !pool) {
      router.replace(buildPoolNotFoundDest(network.id));
    }
  }, [pool, poolLoading, poolErr, router, network.id]);

  const { data: limitsData } = useGQL<{ TradingLimit: TradingLimit[] }>(
    TRADING_LIMITS,
    { poolId: normalizedPoolId },
  );
  const tradingLimits = limitsData?.TradingLimit ?? [];

  const { data: deployData } = useGQL<{
    FactoryDeployment: { txHash: string }[];
  }>(POOL_DEPLOYMENT, { poolId: normalizedPoolId });
  const deployTxHash = deployData?.FactoryDeployment?.[0]?.txHash;

  const { data: olsData, isLoading: olsLoading } = useGQL<{
    OlsPool: OlsPool[];
  }>(OLS_POOL, { poolId: normalizedPoolId });

  // Return null while redirect is pending to avoid a transient error flash
  // and unnecessary error announcement for assistive tech. MUST sit below
  // all hook declarations so React sees the same hook order every render —
  // an early return above a hook violates the Rules of Hooks and throws
  // "Rendered fewer hooks than expected" when the query resolves mid-page.
  if (!poolLoading && !poolErr && !pool) return null;
  const hasOlsPool = selectActiveOlsPool(olsData?.OlsPool) !== null;
  // Keep OLS tab visible while loading so ?tab=ols deep links don't flicker
  const olsTabVisible = hasOlsPool || olsLoading;
  const visibleTabs = TABS.filter((t) => t !== "ols" || olsTabVisible);
  const tab = visibleTabs.includes(requestedTab)
    ? requestedTab
    : (visibleTabs[0] ?? "providers");
  const activeSearch = isSearchableTab(tab)
    ? (searchParams.get(SEARCH_PARAM_BY_TAB[tab]) ?? "")
    : "";

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-400">
        <NetworkAwareLink href="/pools" className="hover:text-indigo-400">
          Pools
        </NetworkAwareLink>
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
          <PoolHeader pool={pool} deployTxHash={deployTxHash} />
          <HealthPanel pool={pool} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ReservesPanel pool={pool} />
            <LimitPanel pool={pool} tradingLimits={tradingLimits} />
          </div>
        </>
      )}

      <div
        className="flex gap-1 border-b border-slate-800"
        role="tablist"
        aria-label="Pool data tabs"
      >
        {visibleTabs.map((t) => (
          <button
            key={t}
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            onClick={() => setURL(t, limit)}
            className={`px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium capitalize transition-colors ${
              tab === t
                ? "border-b-2 border-indigo-500 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {getTabLabel(t)}
          </button>
        ))}
        {/* Oracle tab manages its own page size — hide the global limit selector */}
        {tab !== "oracle" && (
          <div className="ml-auto hidden sm:flex items-center">
            <LimitSelect
              id="tab-limit"
              value={limit}
              onChange={(l) => setURL(tab, l)}
            />
          </div>
        )}
      </div>

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

// ---------------------------------------------------------------------------
// Pool header
// ---------------------------------------------------------------------------

function PoolHeader({
  pool,
  deployTxHash,
}: {
  pool: Pool;
  deployTxHash?: string;
}) {
  const { network } = useNetwork();
  const isVirtual = pool.source?.includes("virtual");
  // pool.id is the namespaced multichain ID ("42220-0x…"). Strip the chain
  // prefix so AddressLink receives a plain hex address for explorer links.
  const poolContractAddress = stripChainIdFromPoolId(pool.id);

  // Mirror poolName's USDm-last ordering so the linked title matches the
  // breadcrumb and historical display, but keep each symbol as a separate
  // anchor to its token contract on the explorer.
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0) && !USDM_SYMBOLS.has(sym1);
  const firstSym = usdmIsToken0 ? sym1 : sym0;
  const firstAddr = usdmIsToken0 ? pool.token1 : pool.token0;
  const secondSym = usdmIsToken0 ? sym0 : sym1;
  const secondAddr = usdmIsToken0 ? pool.token0 : pool.token1;
  const titleSymbol = (sym: string, addr: string | null) =>
    addr ? (
      <a
        href={explorerAddressUrl(network, addr)}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-indigo-300 transition-colors"
      >
        {sym}
      </a>
    ) : (
      sym
    );

  const createdRelative = relativeTime(pool.createdAtTimestamp);
  const createdTitle = formatTimestamp(pool.createdAtTimestamp);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h1 className="text-xl font-bold text-white">
          {titleSymbol(firstSym, firstAddr)}/
          {titleSymbol(secondSym, secondAddr)}
        </h1>
        <SourceBadge source={pool.source} />
        <span className="text-sm">
          <AddressLink address={poolContractAddress} />
        </span>
        {/* `ml-auto` pushes "Created …" to the far edge so the title row
            reads as `identity ← → metadata` rather than trailing ragged-left
            after the address. */}
        {deployTxHash ? (
          <a
            href={`${network.explorerBaseUrl}/tx/${deployTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            title={createdTitle}
            className="ml-auto text-xs text-slate-500 hover:text-indigo-400 transition-colors"
          >
            Created {createdRelative}
          </a>
        ) : (
          <span className="ml-auto text-xs text-slate-500" title={createdTitle}>
            Created {createdRelative}
          </span>
        )}
      </div>
      {/* `justify-between` distributes any trailing slack on the row as
          wider uniform gaps between cells, so the row spans edge-to-edge
          instead of leaving whitespace at the right. Each text cell gets
          `min-w-36` so the shortest one (Health Score) doesn't feel
          squished against the left edge while long cells size to content. */}
      <dl className="flex flex-wrap justify-between gap-x-6 gap-y-4 text-sm">
        <Stat
          className="min-w-36"
          label={
            <span className="inline-flex items-center gap-1">
              Health Score
              <HealthScoreInfoIcon />
            </span>
          }
          value={
            isVirtual ? (
              <span className="text-slate-500">—</span>
            ) : (
              <HealthScoreValue pool={pool} />
            )
          }
        />
        <Stat
          className="min-w-36"
          label="Oracle Status"
          value={
            isVirtual ? (
              <span className="text-slate-500">—</span>
            ) : (
              <OracleStatusValue pool={pool} network={network} />
            )
          }
        />
        <Stat
          className="min-w-36"
          label="Oracle Price"
          value={
            isVirtual ? (
              <span className="text-slate-500">—</span>
            ) : (
              <OraclePriceValue pool={pool} network={network} />
            )
          }
        />
        <Stat
          className="min-w-36"
          label="Rebalance Status"
          value={
            isVirtual || !pool.rebalancerAddress ? (
              <span className="text-slate-500">—</span>
            ) : (
              <RebalanceStatusValue
                pool={pool}
                network={network}
                strategyAddress={pool.rebalancerAddress}
              />
            )
          }
        />
        <DeviationCell pool={pool} network={network} />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  title,
  mono,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  title?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-slate-400">{label}</dt>
      <dd className={`text-white ${mono ? "font-mono" : ""}`} title={title}>
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab content
// ---------------------------------------------------------------------------

function SwapsTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { network } = useNetwork();
  const { getName, getTags } = useAddressLabels();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const { data: countData, error: countError } = useGQL<{
    SwapEvent: { id: string }[];
  }>(POOL_SWAPS_COUNT, { poolId, limit: ENVIO_MAX_ROWS, offset: 0 });
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.SwapEvent?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockNumber", "desc"), []);

  const { data, error, isLoading } = useGQL<{ SwapEvent: SwapEvent[] }>(
    POOL_SWAPS_PAGE,
    { poolId, limit: fetchLimit, offset: fetchOffset, orderBy },
  );
  const swaps = data?.SwapEvent ?? [];

  const fpmmPool = pool ? isFpmm(pool) : false;
  // Passing null as the query key skips the request — VirtualPools have no snapshots.
  // Daily rollup: one row per pool per UTC day, returned in chronological (asc)
  // order. Server-side aggregation avoids the 1000-row cap that hourly hit.
  // `snapshotError` is surfaced inline below so a rollout lag or transient
  // Hasura failure doesn't silently strip the chart from the swaps tab.
  const { data: snapshotData, error: snapshotError } = useGQL<{
    PoolDailySnapshot: PoolSnapshot[];
  }>(
    fpmmPool ? POOL_DAILY_SNAPSHOTS_CHART : null,
    { poolId },
    SNAPSHOT_REFRESH_MS,
  );
  const snapshots = snapshotData?.PoolDailySnapshot ?? [];

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  const dec0 = pool?.token0Decimals ?? 18;
  const dec1 = pool?.token1Decimals ?? 18;

  const filteredSwaps = useMemo(() => {
    if (!query) return swaps;
    return swaps.filter((s) => {
      const d = getSwapDirection(s, sym0, sym1, dec0, dec1);

      return matchesRowSearch(query, [
        s.txHash,
        ...addressSearchTerms(s.sender, getName, getTags),
        ...addressSearchTerms(s.recipient, getName, getTags),
        d.soldSym,
        d.boughtSym,
        formatWei(d.soldAmt, d.soldDec),
        formatWei(d.boughtAmt, d.boughtDec),
        s.blockNumber,
      ]);
    });
  }, [swaps, query, sym0, sym1, dec0, dec1, getName, getTags]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;

  return (
    <>
      {fpmmPool && snapshotError && (
        <ErrorBox
          message={`Daily volume chart unavailable: ${snapshotError.message}`}
        />
      )}
      {fpmmPool && snapshots.length > 0 && (
        <SnapshotChart
          snapshots={snapshots}
          token0Symbol={sym0}
          token1Symbol={sym1}
        />
      )}
      {swaps.length > 0 && (
        <TableSearch
          value={search}
          onChange={handleSearchChange}
          placeholder="Search swaps by tx, address, name, tag, token, amount, or block…"
          ariaLabel="Search swaps"
        />
      )}
      {swaps.length === 0 ? (
        <EmptyBox message="No swaps for this pool." />
      ) : filteredSwaps.length === 0 ? (
        <EmptyBox message="No swaps match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Sender
              </th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Tags
              </th>
              <Th>Trader</Th>
              <Th align="right">Sold</Th>
              <Th align="right">Bought</Th>
              <th
                scope="col"
                className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
              >
                Block
              </th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredSwaps.map((s) => {
              const d = getSwapDirection(s, sym0, sym1, dec0, dec1);
              return (
                <Row key={s.id}>
                  <TxHashCell txHash={s.txHash} />
                  <SenderCell
                    address={s.sender}
                    className="hidden sm:table-cell"
                  />
                  <TagsCell
                    address={s.sender}
                    className="hidden sm:table-cell"
                  />
                  <SenderCell address={s.recipient} />
                  <Td mono small align="right">
                    {formatWei(d.soldAmt, d.soldDec)} {d.soldSym}
                  </Td>
                  <Td mono small align="right">
                    {formatWei(d.boughtAmt, d.boughtDec)} {d.boughtSym}
                  </Td>
                  <td className="hidden md:table-cell px-2 sm:px-4 py-1.5 sm:py-2 font-mono text-[10px] sm:text-xs text-slate-400 text-right">
                    {formatBlock(s.blockNumber)}
                  </td>
                  <Td small muted title={formatTimestamp(s.blockTimestamp)}>
                    {relativeTime(s.blockTimestamp)}
                  </Td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
      {!isSearching && (
        <Pagination
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setRawPage}
        />
      )}
      {countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} swaps — older entries
          may exist beyond this page range.
        </p>
      )}
      {isSearching && total > SEARCH_MAX_LIMIT && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search is limited to the most recent{" "}
          {SEARCH_MAX_LIMIT.toLocaleString()} swaps.
        </p>
      )}
      {countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
    </>
  );
}

function ReservesTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { data, error, isLoading } = useGQL<{ ReserveUpdate: ReserveUpdate[] }>(
    POOL_RESERVES,
    { poolId, limit },
  );
  const { network } = useNetwork();
  const query = normalizeSearch(search);

  const rows = data?.ReserveUpdate ?? [];
  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  // Reverse once to get newest-first order, then filter
  const orderedRows = useMemo(() => [...rows].reverse(), [rows]);

  const feedVal =
    pool?.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 1e24
      : null;
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const usdmIsToken1 = USDM_SYMBOLS.has(sym1);
  const hasUsdmSide = usdmIsToken0 !== usdmIsToken1;
  const showUsd = feedVal !== null && hasUsdmSide;

  const filteredRows = useMemo(() => {
    if (!query) return orderedRows;
    return orderedRows.filter((r) => {
      const raw0 = parseWei(r.reserve0, pool?.token0Decimals ?? 18);
      const raw1 = parseWei(r.reserve1, pool?.token1Decimals ?? 18);
      const usd0 = feedVal && !usdmIsToken0 ? raw0 * feedVal : raw0;
      const usd1 = feedVal && usdmIsToken0 ? raw1 * feedVal : raw1;
      const total = usd0 + usd1;

      return matchesRowSearch(query, [
        r.txHash,
        sym0,
        sym1,
        formatWei(r.reserve0, pool?.token0Decimals ?? 18, 2),
        formatWei(r.reserve1, pool?.token1Decimals ?? 18, 2),
        showUsd
          ? total.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })
          : null,
        r.blockNumber,
      ]);
    });
  }, [orderedRows, query, sym0, sym1, pool, feedVal, usdmIsToken0, showUsd]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return <EmptyBox message="No reserve updates for this pool." />;

  return (
    <>
      <ReserveChart
        rows={rows}
        token0={pool?.token0 ?? null}
        token1={pool?.token1 ?? null}
        pool={pool}
      />
      <TableSearch
        value={search}
        onChange={onSearchChange}
        placeholder="Search reserves by tx, token, amount, or block…"
        ariaLabel="Search reserves"
      />
      {filteredRows.length === 0 ? (
        <EmptyBox message="No reserve updates match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <Th align="right">{sym0} Reserve</Th>
              <Th align="right">{sym1} Reserve</Th>
              <Th align="right">Total (USD)</Th>
              <Th align="right">Block</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => {
              const raw0 = parseWei(r.reserve0, pool?.token0Decimals ?? 18);
              const raw1 = parseWei(r.reserve1, pool?.token1Decimals ?? 18);
              const usd0 = feedVal && !usdmIsToken0 ? raw0 * feedVal : raw0;
              const usd1 = feedVal && usdmIsToken0 ? raw1 * feedVal : raw1;
              const total = usd0 + usd1;

              return (
                <Row key={r.id}>
                  <TxHashCell txHash={r.txHash} />
                  <Td mono small align="right">
                    <div>
                      {formatWei(r.reserve0, pool?.token0Decimals ?? 18, 2)}{" "}
                      {sym0}
                    </div>
                    {showUsd && (
                      <div className="text-xs text-slate-500">
                        ≈ $
                        {usd0.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    )}
                  </Td>
                  <Td mono small align="right">
                    <div>
                      {formatWei(r.reserve1, pool?.token1Decimals ?? 18, 2)}{" "}
                      {sym1}
                    </div>
                    {showUsd && (
                      <div className="text-xs text-slate-500">
                        ≈ $
                        {usd1.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    )}
                  </Td>
                  <Td mono small align="right">
                    {showUsd
                      ? `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : "—"}
                  </Td>
                  <Td mono small muted align="right">
                    {formatBlock(r.blockNumber)}
                  </Td>
                  <Td small muted title={formatTimestamp(r.blockTimestamp)}>
                    {relativeTime(r.blockTimestamp)}
                  </Td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}

export function RebalancesTab({
  poolId,
  limit,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { getName, getTags } = useAddressLabels();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const { data: countData, error: countError } = useGQL<{
    RebalanceEvent: { id: string }[];
  }>(POOL_REBALANCES_COUNT, { poolId, limit: ENVIO_MAX_ROWS, offset: 0 });
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.RebalanceEvent?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockNumber", "desc"), []);

  const { data, error, isLoading } = useGQL<{
    RebalanceEvent: RebalanceEvent[];
  }>(POOL_REBALANCES_PAGE, {
    poolId,
    limit: fetchLimit,
    offset: fetchOffset,
    orderBy,
  });
  const rows = data?.RebalanceEvent ?? [];

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      return matchesRowSearch(query, [
        r.txHash,
        ...addressSearchTerms(r.sender, getName, getTags),
        ...addressSearchTerms(r.caller, getName, getTags),
        Number(r.priceDifferenceBefore).toLocaleString(),
        Number(r.priceDifferenceAfter).toLocaleString(),
        r.effectivenessRatio
          ? `${(Number(r.effectivenessRatio) * 100).toFixed(1)}%`
          : null,
        r.blockNumber,
      ]);
    });
  }, [rows, query, getName, getTags]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return <EmptyBox message="No rebalance events for this pool." />;

  return (
    <>
      <TableSearch
        value={search}
        onChange={handleSearchChange}
        placeholder="Search rebalances by tx, strategy, rebalancer, name, tag, or block…"
        ariaLabel="Search rebalances"
      />
      {filteredRows.length === 0 ? (
        <EmptyBox message="No rebalances match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <Th>Strategy</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Strat. Tags
              </th>
              <Th>Rebalancer</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Caller Tags
              </th>
              <Th align="right">Before (bps)</Th>
              <Th align="right">After (bps)</Th>
              <Th align="right">Effectiveness</Th>
              <Th align="right">Block</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <Row key={r.id}>
                <TxHashCell txHash={r.txHash} />
                <SenderCell address={r.sender} />
                <TagsCell address={r.sender} className="hidden sm:table-cell" />
                <SenderCell address={r.caller} />
                <TagsCell address={r.caller} className="hidden sm:table-cell" />
                <Td mono small align="right">
                  {Number(r.priceDifferenceBefore).toLocaleString()}
                </Td>
                <Td mono small align="right">
                  {Number(r.priceDifferenceAfter).toLocaleString()}
                </Td>
                <Td mono small align="right">
                  {r.effectivenessRatio
                    ? `${(Number(r.effectivenessRatio) * 100).toFixed(1)}%`
                    : "—"}
                </Td>
                <Td mono small muted align="right">
                  {formatBlock(r.blockNumber)}
                </Td>
                <Td small muted title={formatTimestamp(r.blockTimestamp)}>
                  {relativeTime(r.blockTimestamp)}
                </Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
      {!isSearching && (
        <Pagination
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setRawPage}
        />
      )}
      {countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} rebalances — older
          entries may exist beyond this page range.
        </p>
      )}
      {isSearching && total > SEARCH_MAX_LIMIT && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search is limited to the most recent{" "}
          {SEARCH_MAX_LIMIT.toLocaleString()} rebalances.
        </p>
      )}
      {countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
    </>
  );
}

function LiquidityTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { network } = useNetwork();
  const { getName, getTags } = useAddressLabels();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const { data: countData, error: countError } = useGQL<{
    LiquidityEvent: { id: string }[];
  }>(POOL_LIQUIDITY_COUNT, { poolId, limit: ENVIO_MAX_ROWS, offset: 0 });
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.LiquidityEvent?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockNumber", "desc"), []);

  const { data, error, isLoading } = useGQL<{
    LiquidityEvent: LiquidityEvent[];
  }>(POOL_LIQUIDITY_PAGE, {
    poolId,
    limit: fetchLimit,
    offset: fetchOffset,
    orderBy,
  });
  const rows = data?.LiquidityEvent ?? [];

  const fpmmPool = pool ? isFpmm(pool) : false;
  const { data: snapshotData, error: snapshotError } = useGQL<{
    PoolDailySnapshot: PoolSnapshot[];
  }>(
    fpmmPool ? POOL_DAILY_SNAPSHOTS_CHART : null,
    { poolId },
    SNAPSHOT_REFRESH_MS,
  );
  const snapshots = useMemo(
    () => [...(snapshotData?.PoolDailySnapshot ?? [])].reverse(),
    [snapshotData],
  );

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      return matchesRowSearch(query, [
        r.txHash,
        r.kind,
        ...addressSearchTerms(r.sender, getName, getTags),
        formatWei(r.amount0),
        formatWei(r.amount1),
        formatWei(r.liquidity),
        sym0,
        sym1,
        r.blockNumber,
      ]);
    });
  }, [rows, query, getName, getTags, sym0, sym1]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;

  return (
    <>
      {fpmmPool && snapshotError && (
        <ErrorBox
          message={`Liquidity chart unavailable: ${snapshotError.message}`}
        />
      )}
      {fpmmPool && snapshots.length > 0 && (
        <LiquidityChart
          snapshots={snapshots}
          pool={pool}
          token0Symbol={sym0}
          token1Symbol={sym1}
        />
      )}
      {rows.length > 0 && (
        <TableSearch
          value={search}
          onChange={handleSearchChange}
          placeholder="Search liquidity by tx, sender, name, tag, kind, amount, or block…"
          ariaLabel="Search liquidity"
        />
      )}
      {rows.length === 0 ? (
        <EmptyBox message="No liquidity events for this pool." />
      ) : filteredRows.length === 0 ? (
        <EmptyBox message="No liquidity events match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <Th>Kind</Th>
              <Th>Sender</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Tags
              </th>
              <Th align="right">Amount 0</Th>
              <Th align="right">Amount 1</Th>
              <Th align="right">Liquidity</Th>
              <Th align="right">Block</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <Row key={r.id}>
                <TxHashCell txHash={r.txHash} />
                <td className="px-4 py-2">
                  <KindBadge kind={r.kind} />
                </td>
                <SenderCell address={r.sender} />
                <TagsCell address={r.sender} className="hidden sm:table-cell" />
                <Td mono small align="right">
                  {formatWei(r.amount0)}
                </Td>
                <Td mono small align="right">
                  {formatWei(r.amount1)}
                </Td>
                <Td mono small align="right">
                  {formatWei(r.liquidity)}
                </Td>
                <Td mono small muted align="right">
                  {formatBlock(r.blockNumber)}
                </Td>
                <Td small muted title={formatTimestamp(r.blockTimestamp)}>
                  {relativeTime(r.blockTimestamp)}
                </Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
      {!isSearching && (
        <Pagination
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setRawPage}
        />
      )}
      {countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} liquidity events —
          older entries may exist beyond this page range.
        </p>
      )}
      {isSearching && total > SEARCH_MAX_LIMIT && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search is limited to the most recent{" "}
          {SEARCH_MAX_LIMIT.toLocaleString()} liquidity events.
        </p>
      )}
      {countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
    </>
  );
}

function isLiquidityPositionSchemaError(error: Error | undefined) {
  if (!error) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("liquidityposition") &&
    (msg.includes("cannot query field") ||
      msg.includes("not found in type") ||
      msg.includes("field not found"))
  );
}

function LpsTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const isFpmmPool = pool ? isFpmm(pool) : null;
  const shouldSkip = isFpmmPool === false;
  const { getName, getTags } = useAddressLabels();
  const { network } = useNetwork();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const {
    data: indexedData,
    error: indexedError,
    isLoading: indexedLoading,
  } = useGQL<{
    LiquidityPosition: LiquidityPosition[];
  }>(shouldSkip ? null : POOL_LP_POSITIONS, { poolId });

  const positions = useMemo(
    () =>
      (indexedData?.LiquidityPosition ?? [])
        .map((position) => ({
          address: position.address,
          netLiquidity: BigInt(position.netLiquidity),
        }))
        .filter((position) => position.netLiquidity > BigInt(0))
        .sort((a, b) =>
          a.netLiquidity === b.netLiquidity
            ? 0
            : a.netLiquidity > b.netLiquidity
              ? -1
              : 1,
        ),
    [indexedData],
  );

  const totalLiquidity = useMemo(
    () =>
      positions.reduce(
        (acc, position) => acc + position.netLiquidity,
        BigInt(0),
      ),
    [positions],
  );

  if (isFpmmPool === false) {
    return (
      <EmptyBox message="LP provider data is only available for FPMM pools." />
    );
  }
  if (indexedError) {
    if (isLiquidityPositionSchemaError(indexedError)) {
      return (
        <EmptyBox message="LP provider data is unavailable until this environment is reindexed with the LiquidityPosition schema." />
      );
    }
    return <ErrorBox message={indexedError.message} />;
  }
  if (indexedLoading) return <Skeleton rows={5} />;
  if (positions.length === 0)
    return <EmptyBox message="No active LP positions for this pool." />;

  const rankedPositions = positions.map((p, i) => ({ ...p, rank: i + 1 }));
  const filteredPositions = query
    ? rankedPositions.filter((p) =>
        matchesRowSearch(query, [
          ...addressSearchTerms(p.address, getName, getTags),
        ]),
      )
    : rankedPositions;

  const isSearching = query.length > 0;
  const lpTotal = filteredPositions.length;
  const lpTotalPages = lpTotal > 0 ? Math.ceil(lpTotal / limit) : 1;
  const lpPage = Math.max(1, Math.min(rawPage, lpTotalPages));
  const pagedPositions = isSearching
    ? filteredPositions
    : filteredPositions.slice((lpPage - 1) * limit, lpPage * limit);

  // Derive per-position token amounts from pool reserves and LP share.
  // positionTokenAmount = positionShare * poolReserve
  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);
  const dec0 = pool?.token0Decimals ?? 18;
  const dec1 = pool?.token1Decimals ?? 18;
  const reserves0Raw = parseWei(pool?.reserves0 ?? "0", dec0);
  const reserves1Raw = parseWei(pool?.reserves1 ?? "0", dec1);
  const hasReserves = reserves0Raw > 0 || reserves1Raw > 0;

  // Oracle price for USD conversion — same logic as ReservesTab.
  const feedVal =
    pool?.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 1e24
      : null;
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const usdmIsToken1 = USDM_SYMBOLS.has(sym1);
  // Only show USD values when exactly one side is USDm (ensures meaningful conversion)
  const hasUsdmSide = usdmIsToken0 !== usdmIsToken1; // XOR: exactly one side is USDm
  const showUsd = feedVal !== null && hasReserves && hasUsdmSide;

  return (
    <>
      <LpConcentrationChart
        positions={positions}
        totalLiquidity={totalLiquidity}
        getLabel={(addr) => getName(addr)}
        pool={pool}
        sym0={sym0}
        sym1={sym1}
        reserves0Raw={reserves0Raw}
        reserves1Raw={reserves1Raw}
        feedVal={feedVal}
        usdmIsToken0={usdmIsToken0}
      />
      <TableSearch
        value={search}
        onChange={handleSearchChange}
        placeholder="Search LPs by address, name, or tag..."
        ariaLabel="Search LPs"
      />
      {filteredPositions.length === 0 ? (
        <EmptyBox message="No LPs match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>#</Th>
              <Th>Address</Th>
              <Th align="right">{sym0}</Th>
              <Th align="right">{sym1}</Th>
              {showUsd && <Th align="right">Total Value</Th>}
              <Th align="right">Share</Th>
            </tr>
          </thead>
          <tbody>
            {pagedPositions.map((position) => {
              // Scale up by 1e6 before converting to Number to preserve precision
              // for large bigint liquidity values that exceed JS safe integer range.
              const shareNum =
                totalLiquidity > BigInt(0)
                  ? Number(
                      (position.netLiquidity * BigInt(1_000_000)) /
                        totalLiquidity,
                    ) / 1_000_000
                  : 0;
              const sharePct = (shareNum * 100).toFixed(2);

              const tok0 = hasReserves ? shareNum * reserves0Raw : null;
              const tok1 = hasReserves ? shareNum * reserves1Raw : null;

              // Convert each token to USD only when we have a valid USDm-paired oracle price.
              // tok0Usd = USD value of tok0:
              //   - if tok0 IS USDm → already in USD, value = tok0
              //   - if tok1 IS USDm → tok0 is the non-stable, convert via feedVal
              //   - otherwise → no valid conversion, null
              const tok0Usd: number | null =
                tok0 === null || !hasUsdmSide
                  ? null
                  : usdmIsToken0
                    ? tok0 // tok0 is USDm → already USD
                    : feedVal !== null
                      ? tok0 * feedVal // tok0 is non-stable → convert
                      : null;
              const tok1Usd: number | null =
                tok1 === null || !hasUsdmSide
                  ? null
                  : usdmIsToken1
                    ? tok1 // tok1 is USDm → already USD
                    : feedVal !== null
                      ? tok1 * feedVal // tok1 is non-stable → convert
                      : null;
              const totalUsd =
                tok0Usd !== null && tok1Usd !== null ? tok0Usd + tok1Usd : null;

              const fmtTok = (
                v: number | null,
                sym: string,
                vUsd: number | null,
              ) => {
                if (v === null) return "—";
                const formatted = v.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                });
                const showSubUsd = vUsd !== null && !USDM_SYMBOLS.has(sym);
                return (
                  <div>
                    <span>
                      {formatted} {sym}
                    </span>
                    {showSubUsd && (
                      <div className="text-xs text-slate-500">
                        ≈ $
                        {vUsd!.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <Row key={position.address}>
                  <Td small muted>
                    {position.rank}
                  </Td>
                  <Td>
                    <AddressLink address={position.address} />
                  </Td>
                  <Td mono small align="right">
                    {fmtTok(tok0, sym0, tok0Usd)}
                  </Td>
                  <Td mono small align="right">
                    {fmtTok(tok1, sym1, tok1Usd)}
                  </Td>
                  {showUsd && (
                    <Td mono small align="right">
                      {totalUsd !== null
                        ? `$${totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </Td>
                  )}
                  <Td mono small align="right">
                    {sharePct}%
                  </Td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
      {!isSearching && (
        <Pagination
          page={lpPage}
          pageSize={limit}
          total={lpTotal}
          onPageChange={setRawPage}
        />
      )}
    </>
  );
}

type OracleSortCol =
  | "timestamp"
  | "oracleOk"
  | "oraclePrice"
  | "priceDifference";

function OracleTab({
  poolId,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { network } = useNetwork();
  const query = normalizeSearch(search);

  const [rawPage, setRawPage] = React.useState(1);
  const [sortCol, setSortCol] = React.useState<OracleSortCol>("timestamp");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  // Wrap search handler so changing the query always resets to page 1
  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const { data: countData, error: countError } = useGQL<{
    OracleSnapshot: { id: string }[];
  }>(ORACLE_SNAPSHOTS_COUNT_PAGE, {
    poolId,
    limit: ENVIO_MAX_ROWS,
    offset: 0,
  });
  // Preserve last known total on count error so pagination stays visible.
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.OracleSnapshot?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  // Clamp page to valid range once total is known, so a stale page
  // index never leaves the user stranded past the last page.
  const totalPages = total > 0 ? Math.ceil(total / DEFAULT_PAGE_SIZE) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const setPage = React.useCallback((p: number) => setRawPage(p), []);

  // When search is active: fetch from offset 0 so filtering spans a large
  // bounded window rather than just the current page. Bootstrap before count
  // resolves, then expand up to a capped maximum to avoid unbounded pulls.
  // Always use timestamp desc for search queries so "most recent N" is accurate
  // regardless of the current table sort column.
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : DEFAULT_PAGE_SIZE;
  const isSearchCapped = isSearching && total > SEARCH_MAX_LIMIT;
  const fetchOffset = isSearching ? 0 : (page - 1) * DEFAULT_PAGE_SIZE;
  // Table sort (user-controlled)
  const tableOrderBy = useMemo(
    () => buildOrderBy(sortCol, sortDir, "timestamp"),
    [sortCol, sortDir],
  );
  // Search always uses newest-first so the bounded window is chronologically
  // consistent with what the warning text says ("most recent N snapshots")
  const searchOrderBy = useMemo(() => buildOrderBy("timestamp", "desc"), []);
  const orderBy = isSearching ? searchOrderBy : tableOrderBy;

  const { data, error, isLoading } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(ORACLE_SNAPSHOTS, {
    poolId,
    limit: fetchLimit,
    offset: fetchOffset,
    orderBy,
  });

  const rows = data?.OracleSnapshot ?? [];

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  // Charts use a dedicated query (200 most recent rows) so they always show
  // full history context regardless of table pagination or sort state.
  const { data: chartData } = useGQL<{ OracleSnapshot: OracleSnapshot[] }>(
    ORACLE_SNAPSHOTS_CHART,
    { poolId, limit: 200 },
  );
  const chartRows = useMemo(() => {
    const raw = chartData?.OracleSnapshot ?? [];
    return [...raw].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }, [chartData]);

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      const statusAliases = r.oracleOk
        ? "ok true healthy pass good ✓"
        : "fail false unhealthy bad ✗";
      return matchesRowSearch(query, [
        r.source,
        statusAliases,
        parseOraclePriceToNumber(r.oraclePrice, sym0).toFixed(6),
        Number(r.priceDifference) > 0 ? r.priceDifference : null,
        r.rebalanceThreshold > 0 ? String(r.rebalanceThreshold) : null,
        r.txHash,
      ]);
    });
  }, [rows, query, sym0]);

  const toggleSort = React.useCallback(
    (col: OracleSortCol) => {
      if (sortCol === col) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortCol(col);
        setSortDir(col === "oracleOk" ? "asc" : "desc");
      }
      setRawPage(1);
    },
    [sortCol],
  );

  if (pool?.source?.includes("virtual")) {
    return <EmptyBox message="VirtualPool — no oracle data available." />;
  }

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return (
      <EmptyBox message="No oracle snapshots yet. Oracle data is captured on pool activity (swaps, rebalances)." />
    );

  // Arrows and aria-sort are suppressed during search: sort controls remain
  // clickable (to stage a sort for when search is cleared) but the UI does not
  // announce a sort that isn't currently applied to the visible rows.
  const arrow = (col: OracleSortCol) =>
    !isSearching && sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : "";
  const ariaSortFor = (
    col: OracleSortCol,
  ): "ascending" | "descending" | "none" =>
    !isSearching && sortCol === col
      ? sortDir === "asc"
        ? "ascending"
        : "descending"
      : "none";

  return (
    <>
      <OracleChart
        snapshots={chartRows}
        token0Symbol={sym0}
        token1Symbol={sym1}
      />
      <OraclePriceChart
        snapshots={chartRows}
        token0={pool?.token0 ?? null}
        token1={pool?.token1 ?? null}
      />
      <TableSearch
        value={search}
        onChange={handleSearchChange}
        placeholder="Search oracle rows by source, status, price, or tx hash…"
        ariaLabel="Search oracle"
      />
      {filteredRows.length === 0 ? (
        <EmptyBox message="No oracle snapshots match your search." />
      ) : (
        <>
          <Table>
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50">
                <Th>Source</Th>
                <Th align="right" aria-sort={ariaSortFor("oracleOk")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("oracleOk")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Oracle OK{arrow("oracleOk")}
                  </button>
                </Th>
                <Th align="right" aria-sort={ariaSortFor("oraclePrice")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("oraclePrice")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Price ({sym0}/{sym1}){arrow("oraclePrice")}
                  </button>
                </Th>
                <Th align="right" aria-sort={ariaSortFor("priceDifference")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("priceDifference")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Price Diff{arrow("priceDifference")}
                  </button>
                </Th>
                <Th align="right">Threshold</Th>
                <Th aria-sort={ariaSortFor("timestamp")}>
                  <button
                    type="button"
                    onClick={() => toggleSort("timestamp")}
                    className="hover:text-indigo-400 transition-colors"
                  >
                    Time{arrow("timestamp")}
                  </button>
                </Th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const txUrl = r.txHash
                  ? `${network.explorerBaseUrl}/tx/${r.txHash}`
                  : null;
                const diffBps = Number(r.priceDifference);
                const thresholdBps = r.rebalanceThreshold;
                const diffPct =
                  diffBps > 0 && thresholdBps > 0
                    ? ((diffBps / thresholdBps) * 100).toFixed(1)
                    : null;
                return (
                  <Row key={r.id}>
                    <Td small>
                      {txUrl ? (
                        <a
                          href={txUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 font-mono hover:text-indigo-400 transition-colors"
                        >
                          {r.source}
                        </a>
                      ) : (
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 font-mono">
                          {r.source}
                        </span>
                      )}
                    </Td>
                    <Td small align="right">
                      <span
                        className={
                          r.oracleOk ? "text-emerald-400" : "text-red-400"
                        }
                      >
                        {r.oracleOk ? "✓" : "✗"}
                      </span>
                    </Td>
                    <Td mono small align="right">
                      {parseOraclePriceToNumber(r.oraclePrice, sym0).toFixed(6)}
                    </Td>
                    <Td mono small align="right">
                      {diffBps > 0 ? (
                        <span title={`${diffBps.toLocaleString()} bps`}>
                          {diffPct !== null ? `${diffPct}%` : `${diffBps} bps`}
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td mono small align="right">
                      {thresholdBps > 0 ? (
                        <span title={`${thresholdBps.toLocaleString()} bps`}>
                          {(thresholdBps / 100).toFixed(2)}%
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td small muted title={formatTimestamp(r.timestamp)}>
                      {txUrl ? (
                        <a
                          href={txUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-indigo-400 transition-colors"
                        >
                          {relativeTime(r.timestamp)}
                        </a>
                      ) : (
                        relativeTime(r.timestamp)
                      )}
                    </Td>
                  </Row>
                );
              })}
            </tbody>
          </Table>
          {!isSearching && (
            <Pagination
              page={page}
              pageSize={DEFAULT_PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          )}
          {countCapped && !isSearching && (
            <p className="px-1 pt-1 text-xs text-amber-400">
              Showing first {ENVIO_MAX_ROWS.toLocaleString()} snapshots — older
              entries may exist beyond this page range.
            </p>
          )}
          {!countError && isSearchCapped && (
            <p className="px-1 pt-1 text-xs text-amber-400">
              Search is limited to the most recent{" "}
              {SEARCH_MAX_LIMIT.toLocaleString()} snapshots.
            </p>
          )}
          {countError && isSearching && (
            <p className="px-1 pt-1 text-xs text-amber-400">
              Could not load total count — search covers the most recent{" "}
              {SEARCH_BOOTSTRAP_LIMIT.toLocaleString()} snapshots only.
            </p>
          )}
          {countError && !isSearching && (
            <p className="px-1 pt-1 text-xs text-amber-400">
              Could not load total count — pagination may be incomplete.
            </p>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// OLS Tab
// ---------------------------------------------------------------------------

function OlsTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { network } = useNetwork();
  const {
    data: olsData,
    error: olsErr,
    isLoading: olsLoading,
  } = useGQL<{
    OlsPool: OlsPool[];
  }>(OLS_POOL, { poolId });
  const olsPool = selectActiveOlsPool(olsData?.OlsPool);

  if (olsErr) return <ErrorBox message={olsErr.message} />;
  if (olsLoading) return <Skeleton rows={3} />;

  return (
    <div className="space-y-6">
      <OlsStatusPanel olsPool={olsPool} pool={pool} network={network} />
      <OlsLiquidityEvents
        poolId={poolId}
        olsAddress={olsPool?.olsAddress ?? null}
        limit={limit}
        pool={pool}
        network={network}
        search={search}
        onSearchChange={onSearchChange}
      />
    </div>
  );
}

export function OlsStatusPanel({
  olsPool,
  pool,
  network,
}: {
  olsPool: OlsPool | null;
  pool: Pool | null;
  network: ReturnType<typeof useNetwork>["network"];
}) {
  if (!olsPool) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <p className="text-slate-400 text-sm">
          This pool is not registered with the Open Liquidity Strategy.
        </p>
      </div>
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const lastRebalance = Number(olsPool.lastRebalance);
  const cooldown = Number(olsPool.rebalanceCooldown);
  const elapsed = lastRebalance > 0 ? nowSeconds - lastRebalance : null;

  let cooldownStatus: string;
  if (lastRebalance === 0) {
    cooldownStatus = "—";
  } else if (elapsed !== null && elapsed >= cooldown) {
    cooldownStatus = "Ready to rebalance";
  } else if (elapsed !== null) {
    const remaining = cooldown - elapsed;
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    cooldownStatus = `Cooling down (${h}h ${m}m left)`;
  } else {
    cooldownStatus = "—";
  }

  const debtTokenSym = tokenSymbol(network, olsPool.debtToken || null);
  const debtTokenSide = getDebtTokenSideLabel(pool, olsPool.debtToken);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-white">
          Open Liquidity Strategy
        </h3>
        {olsPool.isActive ? (
          <span className="inline-flex items-center rounded-full bg-emerald-900/60 px-2.5 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-700/50">
            Active
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-red-900/60 px-2.5 py-0.5 text-xs font-medium text-red-300 ring-1 ring-red-700/50">
            Removed
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        <Stat
          label="Debt Token"
          value={
            !olsPool.debtToken
              ? "Unknown"
              : `${debtTokenSym} (${debtTokenSide})`
          }
        />
        <Stat
          label="Cooldown"
          value={
            cooldown > 0
              ? `${Math.floor(cooldown / 3600)}h ${Math.floor((cooldown % 3600) / 60)}m`
              : "None"
          }
        />
        <Stat label="Cooldown Status" value={cooldownStatus} />
        <Stat
          label="OLS Rebalances"
          value={String(olsPool.olsRebalanceCount)}
        />
        <Stat
          label="Last Rebalance"
          value={
            lastRebalance > 0 ? relativeTime(String(lastRebalance)) : "Never"
          }
          title={
            lastRebalance > 0
              ? formatTimestamp(String(lastRebalance))
              : undefined
          }
        />
        <Stat
          label="Protocol Fee Recipient"
          value={
            olsPool.protocolFeeRecipient ? (
              <AddressLink address={olsPool.protocolFeeRecipient} />
            ) : (
              "Unknown"
            )
          }
        />
        <Stat
          label="Expansion Incentive (Liquidity Source)"
          value={toPercent(olsPool.liquiditySourceIncentiveExpansion)}
        />
        <Stat
          label="Contraction Incentive (Liquidity Source)"
          value={toPercent(olsPool.liquiditySourceIncentiveContraction)}
        />
        <Stat
          label="Expansion Incentive (Protocol)"
          value={toPercent(olsPool.protocolIncentiveExpansion)}
        />
        <Stat
          label="Contraction Incentive (Protocol)"
          value={toPercent(olsPool.protocolIncentiveContraction)}
        />
        <Stat
          label="OLS Contract"
          value={<AddressLink address={olsPool.olsAddress} />}
        />
      </dl>
    </div>
  );
}

/**
 * Fetches OLS liquidity events scoped to the active OLS contract address,
 * preventing event mixing when a pool has been re-registered to a new OLS contract.
 */
function OlsLiquidityEvents({
  poolId,
  olsAddress,
  limit,
  pool,
  network,
  search,
  onSearchChange,
}: {
  poolId: string;
  olsAddress: string | null;
  limit: number;
  pool: Pool | null;
  network: ReturnType<typeof useNetwork>["network"];
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { getName, getTags } = useAddressLabels();
  const searchQuery = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const countQuery = olsAddress ? OLS_LIQUIDITY_EVENTS_COUNT : null;
  const { data: countData, error: countError } = useGQL<{
    OlsLiquidityEvent: { id: string }[];
  }>(
    countQuery,
    olsAddress ? { poolId, olsAddress, limit: ENVIO_MAX_ROWS, offset: 0 } : {},
  );
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.OlsLiquidityEvent?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = searchQuery.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockTimestamp", "desc"), []);

  const gqlQuery = olsAddress ? OLS_LIQUIDITY_EVENTS_PAGE : null;
  const { data, error, isLoading } = useGQL<{
    OlsLiquidityEvent: OlsLiquidityEvent[];
  }>(
    gqlQuery,
    olsAddress
      ? { poolId, olsAddress, limit: fetchLimit, offset: fetchOffset, orderBy }
      : {},
  );

  const events = data?.OlsLiquidityEvent ?? [];

  const filteredEvents = useMemo(() => {
    if (!searchQuery) return events;
    return events.filter((e) => {
      const givenSym = tokenSymbol(network, e.tokenGivenToPool);
      const takenSym = tokenSymbol(network, e.tokenTakenFromPool);
      const givenDec =
        pool?.token0?.toLowerCase() === e.tokenGivenToPool.toLowerCase()
          ? (pool?.token0Decimals ?? 18)
          : (pool?.token1Decimals ?? 18);
      const takenDec =
        pool?.token0?.toLowerCase() === e.tokenTakenFromPool.toLowerCase()
          ? (pool?.token0Decimals ?? 18)
          : (pool?.token1Decimals ?? 18);
      return matchesRowSearch(searchQuery, [
        e.txHash,
        e.direction === 0 ? "expand" : "contract",
        ...addressSearchTerms(e.caller, getName, getTags),
        formatWei(e.amountGivenToPool, givenDec),
        givenSym,
        formatWei(e.amountTakenFromPool, takenDec),
        takenSym,
      ]);
    });
  }, [events, searchQuery, pool, network, getName, getTags]);

  return (
    <>
      {events.length > 0 && (
        <TableSearch
          value={search}
          onChange={handleSearchChange}
          placeholder="Search OLS events by tx, caller, direction, amount, or token..."
          ariaLabel="Search OLS events"
        />
      )}
      {searchQuery && events.length > 0 && filteredEvents.length === 0 ? (
        <EmptyBox message="No OLS events match your search." />
      ) : (
        <OlsLiquidityTable
          events={filteredEvents}
          pool={pool}
          network={network}
          isLoading={isLoading}
          error={error ?? null}
        />
      )}
      {!isSearching && (
        <Pagination
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setRawPage}
        />
      )}
      {countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} OLS events — older
          entries may exist beyond this page range.
        </p>
      )}
      {isSearching && total > SEARCH_MAX_LIMIT && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search is limited to the most recent{" "}
          {SEARCH_MAX_LIMIT.toLocaleString()} OLS events.
        </p>
      )}
      {countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
    </>
  );
}

export function OlsLiquidityTable({
  events,
  pool,
  network,
  isLoading,
  error,
}: {
  events: OlsLiquidityEvent[];
  pool: Pool | null;
  network: ReturnType<typeof useNetwork>["network"];
  isLoading: boolean;
  error: Error | null;
}) {
  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (events.length === 0)
    return <EmptyBox message="No OLS liquidity events for this pool." />;

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Time</Th>
          <Th>Direction</Th>
          <Th align="right">Given to Pool</Th>
          <Th align="right">Taken from Pool</Th>
          <Th>Caller</Th>
          <Th>Tx</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => {
          const givenSym = tokenSymbol(network, e.tokenGivenToPool);
          const takenSym = tokenSymbol(network, e.tokenTakenFromPool);
          const givenDec =
            pool?.token0?.toLowerCase() === e.tokenGivenToPool.toLowerCase()
              ? (pool?.token0Decimals ?? 18)
              : (pool?.token1Decimals ?? 18);
          const takenDec =
            pool?.token0?.toLowerCase() === e.tokenTakenFromPool.toLowerCase()
              ? (pool?.token0Decimals ?? 18)
              : (pool?.token1Decimals ?? 18);
          return (
            <Row key={e.id}>
              <Td small muted title={formatTimestamp(e.blockTimestamp)}>
                {relativeTime(e.blockTimestamp)}
              </Td>
              <td className="px-4 py-2">
                {e.direction === 0 ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-900/60 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-700/50">
                    EXPAND
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-red-900/60 px-2 py-0.5 text-xs font-medium text-red-300 ring-1 ring-red-700/50">
                    CONTRACT
                  </span>
                )}
              </td>
              <Td mono small align="right">
                {formatWei(e.amountGivenToPool, givenDec)} {givenSym}
              </Td>
              <Td mono small align="right">
                {formatWei(e.amountTakenFromPool, takenDec)} {takenSym}
              </Td>
              <SenderCell address={e.caller} />
              <TxHashCell txHash={e.txHash} />
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}
