"use client";

import { AddressLink } from "@/components/address-link";
import { useAddressLabels } from "@/components/address-labels-provider";
import { KindBadge, RebalancerBadge, SourceBadge } from "@/components/badges";
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
  parseWei,
  parseOraclePriceToNumber,
  relativeTime,
} from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import {
  ORACLE_SNAPSHOTS,
  OLS_LIQUIDITY_EVENTS,
  OLS_POOL,
  POOL_DEPLOYMENT,
  POOL_DETAIL_WITH_HEALTH,
  POOL_LIQUIDITY,
  POOL_LP_POSITIONS,
  POOL_REBALANCES,
  POOL_RESERVES,
  POOL_SNAPSHOTS,
  POOL_SWAPS,
  TRADING_LIMITS,
} from "@/lib/queries";
import { computeHealthStatus, computeRebalancerLiveness } from "@/lib/health";
import { isFpmm, poolName, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
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
import { buildPoolNotFoundDest } from "@/lib/routing";

export default function PoolDetailPage() {
  return (
    <Suspense>
      <PoolDetail />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------

const TABS = [
  "trades",
  "reserves",
  "rebalances",
  "liquidity",
  "oracle",
  "providers",
  "ols",
] as const;
type Tab = (typeof TABS)[number];
type SearchableTab = Extract<
  Tab,
  "trades" | "reserves" | "rebalances" | "liquidity" | "oracle"
>;

const SEARCH_PARAM_BY_TAB: Record<SearchableTab, string> = {
  trades: "tradesQ",
  reserves: "reservesQ",
  rebalances: "rebalancesQ",
  liquidity: "liquidityQ",
  oracle: "oracleQ",
};

function isSearchableTab(tab: Tab): tab is SearchableTab {
  return (
    tab === "trades" ||
    tab === "reserves" ||
    tab === "rebalances" ||
    tab === "liquidity" ||
    tab === "oracle"
  );
}

function addressSearchTerms(
  address: string | null | undefined,
  getLabel: (address: string | null) => string,
): Array<string | null | undefined> {
  if (!address) return [];
  return [address, getLabel(address)];
}

function matchesRowSearch(
  query: string,
  parts: Array<string | number | null | undefined>,
): boolean {
  return matchesSearch(buildSearchBlob(parts), query);
}

function getTabLabel(tab: Tab) {
  return tab === "providers" ? "LPs" : tab;
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

function PoolDetail() {
  const { network } = useNetwork();
  const { poolId } = useParams<{ poolId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const decodedId = decodeURIComponent(poolId);
  const rawTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "trades";
  const limit = Number(searchParams.get("limit") ?? "25");
  const activeSearch = isSearchableTab(tab)
    ? (searchParams.get(SEARCH_PARAM_BY_TAB[tab]) ?? "")
    : "";

  const getCurrentParams = useCallback(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search);
    }
    return new URLSearchParams(searchParams.toString());
  }, [searchParams]);

  const replaceURL = useCallback(
    (params: URLSearchParams) => {
      const qs = params.toString();
      router.replace(
        `/pool/${encodeURIComponent(decodedId)}${qs ? `?${qs}` : ""}`,
        { scroll: false },
      );
    },
    [router, decodedId],
  );

  const setURL = useCallback(
    (t: Tab, lim: number) => {
      const p = getCurrentParams();
      if (t !== "trades") p.set("tab", t);
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
  } = useGQL<{ Pool: Pool[] }>(POOL_DETAIL_WITH_HEALTH, { id: decodedId });

  const pool = poolData?.Pool?.[0] ?? null;

  // When the pool is not found on the current network (e.g. user switched
  // networks while viewing a pool), redirect to /pools rather than showing
  // an error — the pool may simply not exist on the new chain.
  // Preserve the active ?network= param so the user lands on the correct chain.
  useEffect(() => {
    if (!poolLoading && !poolErr && !pool) {
      router.replace(buildPoolNotFoundDest(searchParams.get("network")));
    }
  }, [pool, poolLoading, poolErr, router, searchParams]);

  // Return null while redirect is pending to avoid a transient error flash
  // and unnecessary error announcement for assistive tech.
  if (!poolLoading && !poolErr && !pool) return null;

  const { data: limitsData } = useGQL<{ TradingLimit: TradingLimit[] }>(
    TRADING_LIMITS,
    { poolId: decodedId },
  );
  const tradingLimits = limitsData?.TradingLimit ?? [];

  const { data: deployData } = useGQL<{
    FactoryDeployment: { txHash: string }[];
  }>(POOL_DEPLOYMENT, { poolId: decodedId });
  const deployTxHash = deployData?.FactoryDeployment?.[0]?.txHash;

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
            <AddressLink address={decodedId} />
          )}
        </span>
      </nav>

      {poolErr ? (
        <ErrorBox message={`Failed to load pool: ${poolErr.message}`} />
      ) : poolLoading ? (
        <Skeleton rows={2} />
      ) : !pool ? (
        <ErrorBox message={`Pool ${decodedId} not found.`} />
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
        {TABS.map((t) => (
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
        <div className="ml-auto hidden sm:flex items-center">
          <LimitSelect
            id="tab-limit"
            value={limit}
            onChange={(l) => setURL(tab, l)}
          />
        </div>
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "trades" && (
          <TradesTab
            poolId={decodedId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("trades", value)}
          />
        )}
        {tab === "reserves" && (
          <ReservesTab
            poolId={decodedId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("reserves", value)}
          />
        )}
        {tab === "rebalances" && (
          <RebalancesTab
            poolId={decodedId}
            limit={limit}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("rebalances", value)}
          />
        )}
        {tab === "liquidity" && (
          <LiquidityTab
            poolId={decodedId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("liquidity", value)}
          />
        )}
        {tab === "oracle" && (
          <OracleTab
            poolId={decodedId}
            limit={limit}
            pool={pool}
            search={activeSearch}
            onSearchChange={(value) => setTabSearch("oracle", value)}
          />
        )}
        {tab === "providers" && <LpsTab poolId={decodedId} pool={pool} />}
        {tab === "ols" && (
          <OlsTab poolId={decodedId} limit={limit} pool={pool} />
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
  const name = poolName(network, pool.token0, pool.token1);
  const isVirtual = pool.source?.includes("virtual");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rebalancerLiveness = computeRebalancerLiveness(
    { ...pool, healthStatus: computeHealthStatus(pool, network.chainId) },
    nowSeconds,
  );

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h1 className="text-xl font-bold text-white">{name}</h1>
        {network.hasVirtualPools && <SourceBadge source={pool.source} />}
        <span className="text-sm">
          <AddressLink address={pool.id} />
        </span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
        <Stat
          label="Token 0"
          value={pool.token0 ? <AddressLink address={pool.token0} /> : "—"}
        />
        <Stat
          label="Token 1"
          value={pool.token1 ? <AddressLink address={pool.token1} /> : "—"}
        />
        <Stat
          label="Rebalancing Strategy"
          value={
            isVirtual || !pool.rebalancerAddress ? (
              <span className="text-slate-500">—</span>
            ) : (
              <span className="flex items-center gap-1.5 flex-wrap">
                <AddressLink address={pool.rebalancerAddress} />
                <RebalancerBadge status={rebalancerLiveness} />
              </span>
            )
          }
        />
        <Stat
          label="Created at block"
          value={
            <a
              href={`${network.explorerBaseUrl}/block/${pool.createdAtBlock}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 font-mono"
            >
              {formatBlock(pool.createdAtBlock)}
            </a>
          }
        />
        <Stat
          label="Created"
          value={
            deployTxHash ? (
              <a
                href={`${network.explorerBaseUrl}/tx/${deployTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 hover:text-indigo-300"
              >
                {relativeTime(pool.createdAtTimestamp)}
              </a>
            ) : (
              relativeTime(pool.createdAtTimestamp)
            )
          }
          title={formatTimestamp(pool.createdAtTimestamp)}
        />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  title,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div>
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

function TradesTab({
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
  const { getLabel } = useAddressLabels();
  const query = normalizeSearch(search);

  const { data, error, isLoading } = useGQL<{ SwapEvent: SwapEvent[] }>(
    POOL_SWAPS,
    { poolId, limit },
  );
  const swaps = data?.SwapEvent ?? [];

  const fpmmPool = pool ? isFpmm(pool) : false;
  // Passing null as the query key skips the request — VirtualPools have no snapshots.
  const { data: snapshotData } = useGQL<{ PoolSnapshot: PoolSnapshot[] }>(
    fpmmPool ? POOL_SNAPSHOTS : null,
    { poolId, limit },
  );
  const snapshots = snapshotData?.PoolSnapshot ?? [];

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  const filteredSwaps = useMemo(() => {
    if (!query) return swaps;
    return swaps.filter((s) => {
      const soldToken0 = BigInt(s.amount0In) > BigInt(0);
      const soldAmt = soldToken0 ? s.amount0In : s.amount1In;
      const boughtAmt = soldToken0 ? s.amount1Out : s.amount0Out;
      const soldSym = soldToken0 ? sym0 : sym1;
      const boughtSym = soldToken0 ? sym1 : sym0;
      const soldDec = soldToken0
        ? (pool?.token0Decimals ?? 18)
        : (pool?.token1Decimals ?? 18);
      const boughtDec = soldToken0
        ? (pool?.token1Decimals ?? 18)
        : (pool?.token0Decimals ?? 18);

      return matchesRowSearch(query, [
        s.txHash,
        ...addressSearchTerms(s.sender, getLabel),
        ...addressSearchTerms(s.recipient, getLabel),
        soldSym,
        boughtSym,
        formatWei(soldAmt, soldDec),
        formatWei(boughtAmt, boughtDec),
        s.blockNumber,
      ]);
    });
  }, [swaps, query, sym0, sym1, pool, getLabel]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;

  return (
    <>
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
          onChange={onSearchChange}
          placeholder="Search trades by tx, address, label, token, amount, or block…"
          ariaLabel="Search trades"
        />
      )}
      {swaps.length === 0 ? (
        <EmptyBox message="No trades for this pool." />
      ) : filteredSwaps.length === 0 ? (
        <EmptyBox message="No trades match your search." />
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
              const soldToken0 = BigInt(s.amount0In) > BigInt(0);
              const soldAmt = soldToken0 ? s.amount0In : s.amount1In;
              const boughtAmt = soldToken0 ? s.amount1Out : s.amount0Out;
              const soldSym = soldToken0 ? sym0 : sym1;
              const boughtSym = soldToken0 ? sym1 : sym0;
              const soldDec = soldToken0
                ? (pool?.token0Decimals ?? 18)
                : (pool?.token1Decimals ?? 18);
              const boughtDec = soldToken0
                ? (pool?.token1Decimals ?? 18)
                : (pool?.token0Decimals ?? 18);
              return (
                <Row key={s.id}>
                  <TxHashCell txHash={s.txHash} />
                  <SenderCell
                    address={s.sender}
                    className="hidden sm:table-cell"
                  />
                  <SenderCell address={s.recipient} />
                  <Td mono small align="right">
                    {formatWei(soldAmt, soldDec)} {soldSym}
                  </Td>
                  <Td mono small align="right">
                    {formatWei(boughtAmt, boughtDec)} {boughtSym}
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
  const showUsd = feedVal !== null;

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

function RebalancesTab({
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
  const { getLabel } = useAddressLabels();
  const query = normalizeSearch(search);

  const { data, error, isLoading } = useGQL<{
    RebalanceEvent: RebalanceEvent[];
  }>(POOL_REBALANCES, { poolId, limit });
  const rows = data?.RebalanceEvent ?? [];

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      return matchesRowSearch(query, [
        r.txHash,
        ...addressSearchTerms(r.sender, getLabel),
        ...addressSearchTerms(r.caller, getLabel),
        Number(r.priceDifferenceBefore).toLocaleString(),
        Number(r.priceDifferenceAfter).toLocaleString(),
        r.effectivenessRatio
          ? `${(Number(r.effectivenessRatio) * 100).toFixed(1)}%`
          : null,
        r.blockNumber,
      ]);
    });
  }, [rows, query, getLabel]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return <EmptyBox message="No rebalance events for this pool." />;

  return (
    <>
      <TableSearch
        value={search}
        onChange={onSearchChange}
        placeholder="Search rebalances by tx, strategy, rebalancer, label, or block…"
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
              <Th>Rebalancer</Th>
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
                <SenderCell address={r.caller} />
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
  const { getLabel } = useAddressLabels();
  const query = normalizeSearch(search);

  const { data, error, isLoading } = useGQL<{
    LiquidityEvent: LiquidityEvent[];
  }>(POOL_LIQUIDITY, { poolId, limit });
  const rows = data?.LiquidityEvent ?? [];

  const fpmmPool = pool ? isFpmm(pool) : false;
  // Passing null as the query key skips the request — VirtualPools have no snapshots.
  const { data: snapshotData } = useGQL<{ PoolSnapshot: PoolSnapshot[] }>(
    fpmmPool ? POOL_SNAPSHOTS : null,
    { poolId, limit },
  );
  const snapshots = snapshotData?.PoolSnapshot ?? [];

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      return matchesRowSearch(query, [
        r.txHash,
        r.kind,
        ...addressSearchTerms(r.sender, getLabel),
        formatWei(r.amount0),
        formatWei(r.amount1),
        formatWei(r.liquidity),
        sym0,
        sym1,
        r.blockNumber,
      ]);
    });
  }, [rows, query, getLabel, sym0, sym1]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;

  return (
    <>
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
          onChange={onSearchChange}
          placeholder="Search liquidity by tx, sender, label, kind, amount, or block…"
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

function LpsTab({ poolId, pool }: { poolId: string; pool: Pool | null }) {
  // Only FPMM pools have LP mechanics — skip the fetch for non-FPMM pools.
  // Pass null to useGQL when we know the pool type and it isn't FPMM so the
  // hook is always called (Rules of Hooks) but the network request is skipped.
  const isFpmmPool = pool ? isFpmm(pool) : null; // null = still loading
  const shouldSkip = isFpmmPool === false;

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

  return (
    <>
      <div className="mb-3 rounded border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
        LP balances are shown in LP token units. Until we index LP token
        decimals explicitly, the formatted display assumes the standard 18
        decimals.
      </div>
      <LpConcentrationChart
        positions={positions}
        totalLiquidity={totalLiquidity}
      />
      <Table>
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <Th>#</Th>
            <Th>Address</Th>
            <Th align="right">Net LP Tokens</Th>
            <Th align="right">Share</Th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position, i) => {
            // Scale up by 1e6 before converting to Number to preserve precision
            // for large bigint liquidity values that exceed JS safe integer range.
            const sharePct =
              totalLiquidity > BigInt(0)
                ? (
                    Number(
                      (position.netLiquidity * BigInt(1_000_000)) /
                        totalLiquidity,
                    ) / 10000
                  ).toFixed(2)
                : "0.00";
            return (
              <Row key={position.address}>
                <Td small muted>
                  {i + 1}
                </Td>
                <Td>
                  <AddressLink address={position.address} />
                </Td>
                <Td mono small align="right">
                  {formatWei(position.netLiquidity.toString())}
                </Td>
                <Td mono small align="right">
                  {sharePct}%
                </Td>
              </Row>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}

function OracleTab({
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
  const query = normalizeSearch(search);

  const { data, error, isLoading } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(ORACLE_SNAPSHOTS, { poolId, limit });
  const rows = data?.OracleSnapshot ?? [];

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  // Reverse once to get newest-first order, then filter
  const orderedRows = useMemo(() => [...rows].reverse(), [rows]);

  const filteredRows = useMemo(() => {
    if (!query) return orderedRows;
    return orderedRows.filter((r) => {
      const statusAliases = r.oracleOk
        ? "ok true healthy pass good ✓"
        : "fail false unhealthy bad ✗";

      return matchesRowSearch(query, [
        r.source,
        statusAliases,
        parseOraclePriceToNumber(r.oraclePrice, sym0).toFixed(6),
        Number(r.priceDifference) > 0 ? r.priceDifference : null,
        r.rebalanceThreshold > 0 ? String(r.rebalanceThreshold) : null,
        r.numReporters,
        r.blockNumber,
      ]);
    });
  }, [orderedRows, query, sym0]);

  if (pool?.source?.includes("virtual")) {
    return <EmptyBox message="VirtualPool — no oracle data available." />;
  }

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return (
      <EmptyBox message="No oracle snapshots yet. Oracle data is captured on pool activity (swaps, rebalances)." />
    );

  return (
    <>
      <OracleChart snapshots={rows} token0Symbol={sym0} token1Symbol={sym1} />
      <OraclePriceChart
        snapshots={rows}
        token0={pool?.token0 ?? null}
        token1={pool?.token1 ?? null}
      />
      <TableSearch
        value={search}
        onChange={onSearchChange}
        placeholder="Search oracle rows by source, status, price, or block…"
        ariaLabel="Search oracle"
      />
      {filteredRows.length === 0 ? (
        <EmptyBox message="No oracle snapshots match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Source</Th>
              <Th align="right">Oracle OK</Th>
              <Th align="right">
                Price ({sym0}/{sym1})
              </Th>
              <Th align="right">Price Diff</Th>
              <Th align="right">Threshold</Th>
              <Th align="right">Reporters</Th>
              <Th align="right">Block</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <Row key={r.id}>
                <Td small>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 font-mono">
                    {r.source}
                  </span>
                </Td>
                <Td small align="right">
                  <span
                    className={r.oracleOk ? "text-emerald-400" : "text-red-400"}
                  >
                    {r.oracleOk ? "✓" : "✗"}
                  </span>
                </Td>
                <Td mono small align="right">
                  {parseOraclePriceToNumber(r.oraclePrice, sym0).toFixed(6)}
                </Td>
                <Td mono small align="right">
                  {Number(r.priceDifference) > 0 ? r.priceDifference : "—"}
                </Td>
                <Td mono small align="right">
                  {r.rebalanceThreshold > 0 ? r.rebalanceThreshold : "—"}
                </Td>
                <Td mono small align="right">
                  {r.numReporters}
                </Td>
                <Td mono small muted align="right">
                  {formatBlock(r.blockNumber)}
                </Td>
                <Td small muted title={formatTimestamp(r.timestamp)}>
                  {relativeTime(r.timestamp)}
                </Td>
              </Row>
            ))}
          </tbody>
        </Table>
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
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
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

  // Incentives: raw uint64, FEE_DENOMINATOR = 1e18 in the contract.
  // percentage = value / 1e18 * 100. With 4 decimal places: (v * 10000) / 1e16.
  // Sanity: v=1e18 (100%) → 1e22/1e16 = 1e6 scaled → integer=100, frac=0 → "100.0000%" ✓
  //         v=1e15 (0.1%) → 1e19/1e16 = 1000 scaled → integer=0, frac=1000 → "0.1000%" ✓
  // Use BigInt to avoid precision loss on large uint64 values.
  const toPercent = (raw: string): string => {
    if (!raw || raw === "0") return "0.0000%";
    const v = BigInt(raw);
    const TEN_K = BigInt(10000);
    const DIVISOR = BigInt("10000000000000000"); // 1e16
    const scaled = (v * TEN_K) / DIVISOR;
    const integer = scaled / TEN_K;
    const frac = scaled % TEN_K;
    return `${integer}.${String(frac).padStart(4, "0")}%`;
  };

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
}: {
  poolId: string;
  olsAddress: string | null;
  limit: number;
  pool: Pool | null;
  network: ReturnType<typeof useNetwork>["network"];
}) {
  // Skip the query until the active olsAddress is known (avoids mixing events
  // from historical OLS contracts in pools that have been re-registered).
  const query = olsAddress ? OLS_LIQUIDITY_EVENTS : null;
  const { data, error, isLoading } = useGQL<{
    OlsLiquidityEvent: OlsLiquidityEvent[];
  }>(query, olsAddress ? { poolId, olsAddress, limit } : {});

  const events = data?.OlsLiquidityEvent ?? [];

  return (
    <OlsLiquidityTable
      events={events}
      pool={pool}
      network={network}
      isLoading={isLoading}
      error={error ?? null}
    />
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
