"use client";

import { AddressLink } from "@/components/address-link";
import { KindBadge, SourceBadge } from "@/components/badges";
import { LimitSelect } from "@/components/controls";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { HealthPanel } from "@/components/health-panel";
import { LimitPanel } from "@/components/limit-panel";
import { RebalancerPanel } from "@/components/rebalancer-panel";
import { useNetwork } from "@/components/network-provider";
import { OracleChart } from "@/components/oracle-chart";
import { OraclePriceChart } from "@/components/oracle-price-chart";
import { ReserveChart } from "@/components/reserve-chart";
import { SenderCell } from "@/components/sender-cell";
import { SnapshotChart } from "@/components/snapshot-chart";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import {
  formatBlock,
  formatTimestamp,
  formatWei,
  relativeTime,
} from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import {
  ORACLE_SNAPSHOTS,
  POOL_DETAIL_WITH_HEALTH,
  POOL_LIQUIDITY,
  POOL_REBALANCES,
  POOL_RESERVES,
  POOL_SNAPSHOTS,
  POOL_SWAPS,
  TRADING_LIMITS,
} from "@/lib/queries";
import { isFpmm, poolName, tokenSymbol } from "@/lib/tokens";
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
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
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
  "analytics",
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
      const p = new URLSearchParams();
      if (t !== "swaps") p.set("tab", t);
      if (lim !== 25) p.set("limit", String(lim));
      const qs = p.toString();
      router.replace(
        `/pool/${encodeURIComponent(decodedId)}${qs ? `?${qs}` : ""}`,
        { scroll: false },
      );
    },
    [router, decodedId],
  );

  const {
    data: poolData,
    error: poolErr,
    isLoading: poolLoading,
  } = useGQL<{ Pool: Pool[] }>(POOL_DETAIL_WITH_HEALTH, { id: decodedId });

  const pool = poolData?.Pool?.[0] ?? null;

  const { data: limitsData } = useGQL<{ TradingLimit: TradingLimit[] }>(
    TRADING_LIMITS,
    { poolId: decodedId },
  );
  const tradingLimits = limitsData?.TradingLimit ?? [];

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-400">
        <Link href="/" className="hover:text-indigo-400">
          Global
        </Link>
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
          <PoolHeader pool={pool} />
          <HealthPanel pool={pool} />
          <LimitPanel pool={pool} tradingLimits={tradingLimits} />
          <RebalancerPanelWrapper pool={pool} poolId={decodedId} limit={20} />
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
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? "border-b-2 border-indigo-500 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {t}
          </button>
        ))}
        <div className="ml-auto flex items-center">
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
          <LiquidityTab poolId={decodedId} limit={limit} />
        )}
        {tab === "oracle" && (
          <OracleTab poolId={decodedId} limit={limit} pool={pool} />
        )}
        {tab === "analytics" && (
          <AnalyticsTab poolId={decodedId} limit={limit} pool={pool} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rebalancer panel wrapper (fetches rebalances for the panel)
// ---------------------------------------------------------------------------

function RebalancerPanelWrapper({
  pool,
  poolId,
  limit,
}: {
  pool: Pool;
  poolId: string;
  limit: number;
}) {
  const { data } = useGQL<{ RebalanceEvent: RebalanceEvent[] }>(
    POOL_REBALANCES,
    { poolId, limit },
  );
  const rebalances = data?.RebalanceEvent ?? [];
  return <RebalancerPanel pool={pool} rebalances={rebalances} />;
}

// ---------------------------------------------------------------------------
// Pool header
// ---------------------------------------------------------------------------

function PoolHeader({ pool }: { pool: Pool }) {
  const { network } = useNetwork();
  const name = poolName(network, pool.token0, pool.token1);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h1 className="text-xl font-bold text-white">{name}</h1>
        <SourceBadge source={pool.source} />
        <span className="text-sm">
          <AddressLink address={pool.id} />
        </span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <Stat
          label="Token 0"
          value={pool.token0 ? <AddressLink address={pool.token0} /> : "—"}
        />
        <Stat
          label="Token 1"
          value={pool.token1 ? <AddressLink address={pool.token1} /> : "—"}
        />
        <Stat
          label="Created at block"
          value={formatBlock(pool.createdAtBlock)}
        />
        <Stat
          label="Created"
          value={relativeTime(pool.createdAtTimestamp)}
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

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (swaps.length === 0) return <EmptyBox message="No swaps for this pool." />;

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Tx</Th>
          <Th>Sender</Th>
          <Th>Trader</Th>
          <Th align="right">Sold</Th>
          <Th align="right">Bought</Th>
          <Th align="right">Block</Th>
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
          return (
            <Row key={s.id}>
              <TxHashCell txHash={s.txHash} />
              <SenderCell address={s.sender} />
              <SenderCell address={s.recipient} />
              <Td mono small align="right">
                {formatWei(soldAmt)} {soldSym}
              </Td>
              <Td mono small align="right">
                {formatWei(boughtAmt)} {boughtSym}
              </Td>
              <Td mono small muted align="right">
                {formatBlock(s.blockNumber)}
              </Td>
              <Td small muted title={formatTimestamp(s.blockTimestamp)}>
                {relativeTime(s.blockTimestamp)}
              </Td>
            </Row>
          );
        })}
      </tbody>
    </Table>
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
  const rows = data?.ReserveUpdate ?? [];

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
      />
      <Table>
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <Th>Tx</Th>
            <Th align="right">Reserve 0</Th>
            <Th align="right">Reserve 1</Th>
            <Th align="right">Block</Th>
            <Th>Time</Th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <Row key={r.id}>
              <TxHashCell txHash={r.txHash} />
              <Td mono small align="right">
                {formatWei(r.reserve0)}
              </Td>
              <Td mono small align="right">
                {formatWei(r.reserve1)}
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
          <Th>Sender</Th>
          <Th align="right">Price Diff Before</Th>
          <Th align="right">Price Diff After</Th>
          <Th align="right">Block</Th>
          <Th>Time</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Row key={r.id}>
            <TxHashCell txHash={r.txHash} />
            <SenderCell address={r.sender} />
            <Td mono small align="right">
              {formatWei(r.priceDifferenceBefore)}
            </Td>
            <Td mono small align="right">
              {formatWei(r.priceDifferenceAfter)}
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

function LiquidityTab({ poolId, limit }: { poolId: string; limit: number }) {
  const { data, error, isLoading } = useGQL<{
    LiquidityEvent: LiquidityEvent[];
  }>(POOL_LIQUIDITY, { poolId, limit });
  const rows = data?.LiquidityEvent ?? [];

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return <EmptyBox message="No liquidity events for this pool." />;

  return (
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
  const { data, error, isLoading } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(ORACLE_SNAPSHOTS, { poolId, limit });
  const rows = data?.OracleSnapshot ?? [];

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
            <Th align="right">Price (num)</Th>
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
                {r.oraclePrice}
              </Td>
              <Td mono small align="right">
                {r.priceDifference}
              </Td>
              <Td mono small align="right">
                {r.rebalanceThreshold}
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

function AnalyticsTab({
  poolId,
  limit,
  pool,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
}) {
  const { network } = useNetwork();

  // VirtualPools never emit UpdateReserves/Rebalanced so they never generate snapshots.
  // Hooks must all be called before any conditional return (Rules of Hooks).
  const isFpmmPool = pool ? isFpmm(pool) : true; // treat null as non-virtual while loading

  const { data, error, isLoading } = useGQL<{
    PoolSnapshot: PoolSnapshot[];
  }>(isFpmmPool ? POOL_SNAPSHOTS : null, { poolId, limit });
  const rows = data?.PoolSnapshot ?? [];

  // Reuse the oracle snapshots already fetched in OracleTab (SWR deduplicates by key)
  const { data: oracleData } = useGQL<{ OracleSnapshot: OracleSnapshot[] }>(
    isFpmmPool ? ORACLE_SNAPSHOTS : null,
    { poolId, limit },
  );
  const oracleSnapshots = oracleData?.OracleSnapshot ?? [];

  if (pool && !isFpmmPool) {
    return <EmptyBox message="VirtualPool — no snapshot data available." />;
  }

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return (
      <EmptyBox message="No snapshot data yet. Snapshots are created on pool activity." />
    );

  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  return (
    <>
      <OracleChart
        snapshots={oracleSnapshots}
        token0Symbol={sym0}
        token1Symbol={sym1}
      />
      <SnapshotChart snapshots={rows} token0Symbol={sym0} token1Symbol={sym1} />
      <Table>
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <Th>Time</Th>
            <Th align="right">Swaps</Th>
            <Th align="right">Volume (Token 0)</Th>
            <Th align="right">Volume (Token 1)</Th>
            <Th align="right">Cumulative Swaps</Th>
            <Th align="right">Block</Th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <Row key={r.id}>
              <Td small muted title={formatTimestamp(r.timestamp)}>
                {relativeTime(r.timestamp)}
              </Td>
              <Td mono small align="right">
                {r.swapCount}
              </Td>
              <Td mono small align="right">
                {formatWei(r.swapVolume0)}
              </Td>
              <Td mono small align="right">
                {formatWei(r.swapVolume1)}
              </Td>
              <Td mono small align="right">
                {r.cumulativeSwapCount}
              </Td>
              <Td mono small muted align="right">
                {formatBlock(r.blockNumber)}
              </Td>
            </Row>
          ))}
        </tbody>
      </Table>
    </>
  );
}
