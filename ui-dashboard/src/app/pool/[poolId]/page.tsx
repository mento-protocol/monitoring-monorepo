"use client";

import { AddressLink } from "@/components/address-link";
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
import { SnapshotChart } from "@/components/snapshot-chart";
import { Row, Table, Td, Th } from "@/components/table";
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
  POOL_DEPLOYMENT,
  POOL_DETAIL_WITH_HEALTH,
  POOL_LIQUIDITY,
  POOL_REBALANCES,
  POOL_RESERVES,
  POOL_SNAPSHOTS,
  POOL_SWAPS,
  TRADING_LIMITS,
} from "@/lib/queries";
import { computeHealthStatus, computeRebalancerLiveness } from "@/lib/health";
import { isFpmm, poolName, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import type {
  LiquidityEvent,
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
import { useEffect } from "react";
import React, { Suspense, useCallback } from "react";

export default function PoolDetailPage() {
  return (
    <Suspense>
      <PoolDetail />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------

const TABS = [
  "swaps",
  "reserves",
  "rebalances",
  "liquidity",
  "oracle",
] as const;
type Tab = (typeof TABS)[number];

function PoolDetail() {
  const { network } = useNetwork();
  const { poolId } = useParams<{ poolId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const decodedId = decodeURIComponent(poolId);
  const rawTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "swaps";
  const limit = Number(searchParams.get("limit") ?? "25");

  const setURL = useCallback(
    (t: Tab, lim: number) => {
      const p = new URLSearchParams(searchParams.toString());
      if (t !== "swaps") p.set("tab", t);
      else p.delete("tab");
      if (lim !== 25) p.set("limit", String(lim));
      else p.delete("limit");
      const qs = p.toString();
      router.replace(
        `/pool/${encodeURIComponent(decodedId)}${qs ? `?${qs}` : ""}`,
        { scroll: false },
      );
    },
    [router, decodedId, searchParams],
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
      const networkParam = searchParams.get("network");
      const dest = networkParam ? `/pools?network=${networkParam}` : "/pools";
      router.replace(dest);
    }
  }, [pool, poolLoading, poolErr, router, searchParams]);

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
            {t}
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
        {tab === "swaps" && (
          <SwapsTab poolId={decodedId} limit={limit} pool={pool} />
        )}
        {tab === "reserves" && (
          <ReservesTab poolId={decodedId} limit={limit} pool={pool} />
        )}
        {tab === "rebalances" && (
          <RebalancesTab poolId={decodedId} limit={limit} />
        )}
        {tab === "liquidity" && (
          <LiquidityTab poolId={decodedId} limit={limit} pool={pool} />
        )}
        {tab === "oracle" && (
          <OracleTab poolId={decodedId} limit={limit} pool={pool} />
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

function SwapsTab({
  poolId,
  limit,
  pool,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
}) {
  const { network } = useNetwork();
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
      {swaps.length === 0 ? (
        <EmptyBox message="No swaps for this pool." />
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
            {swaps.map((s) => {
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
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
}) {
  const { data, error, isLoading } = useGQL<{ ReserveUpdate: ReserveUpdate[] }>(
    POOL_RESERVES,
    { poolId, limit },
  );
  const { network } = useNetwork();
  const rows = data?.ReserveUpdate ?? [];
  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

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
          {(() => {
            const feedVal =
              pool?.oraclePrice && pool.oraclePrice !== "0"
                ? Number(pool.oraclePrice) / 1e24
                : null;
            const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
            const showUsd = feedVal !== null;
            return [...rows].reverse().map((r) => {
              const raw0 = parseWei(r.reserve0, pool?.token0Decimals ?? 18);
              const raw1 = parseWei(r.reserve1, pool?.token1Decimals ?? 18);
              // USD values: USDm ≈ $1, non-USDm × feedVal
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
            });
          })()}
        </tbody>
      </Table>
    </>
  );
}

function RebalancesTab({ poolId, limit }: { poolId: string; limit: number }) {
  const { data, error, isLoading } = useGQL<{
    RebalanceEvent: RebalanceEvent[];
  }>(POOL_REBALANCES, { poolId, limit });
  const rows = data?.RebalanceEvent ?? [];

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return <EmptyBox message="No rebalance events for this pool." />;

  return (
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
        {rows.map((r) => (
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
  );
}

function LiquidityTab({
  poolId,
  limit,
  pool,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
}) {
  const { network } = useNetwork();
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
      {rows.length === 0 ? (
        <EmptyBox message="No liquidity events for this pool." />
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
            {rows.map((r) => (
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

function OracleTab({
  poolId,
  limit,
  pool,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
}) {
  const { network } = useNetwork();
  const { data, error, isLoading } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(ORACLE_SNAPSHOTS, { poolId, limit });
  const rows = data?.OracleSnapshot ?? [];

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

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
          {[...rows].reverse().map((r) => (
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
    </>
  );
}
