"use client";

import { Suspense, useCallback } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useGQL } from "@/lib/graphql";
import {
  POOL_DETAIL_WITH_HEALTH,
  POOL_SWAPS,
  POOL_RESERVES,
  POOL_REBALANCES,
  POOL_LIQUIDITY,
  ORACLE_SNAPSHOTS,
  POOL_SNAPSHOTS,
} from "@/lib/queries";
import {
  truncateAddress,
  formatWei,
  relativeTime,
  formatTimestamp,
  formatBlock,
} from "@/lib/format";
import { poolName, tokenSymbol, isFpmm } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import type {
  Pool,
  SwapEvent,
  ReserveUpdate,
  RebalanceEvent,
  LiquidityEvent,
  OracleSnapshot,
  PoolSnapshot,
} from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import { Skeleton, EmptyBox, ErrorBox } from "@/components/feedback";
import { SourceBadge, KindBadge } from "@/components/badges";
import { LimitSelect } from "@/components/controls";
import { SenderCell } from "@/components/sender-cell";
import { TxHashCell } from "@/components/tx-hash-cell";
import { ReserveChart } from "@/components/reserve-chart";
import { OraclePriceChart } from "@/components/oracle-price-chart";
import { HealthPanel } from "@/components/health-panel";
import { SnapshotChart } from "@/components/snapshot-chart";

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

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-400">
        <Link href="/" className="hover:text-indigo-400">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-200">
          {pool
            ? poolName(network, pool.token0, pool.token1)
            : truncateAddress(decodedId)}
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
        {tab === "swaps" && <SwapsTab poolId={decodedId} limit={limit} />}
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
        <span className="font-mono text-sm text-slate-500" title={pool.id}>
          {truncateAddress(pool.id)}
        </span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <Stat
          label="Token 0"
          value={truncateAddress(pool.token0)}
          title={pool.token0 ?? undefined}
          mono
        />
        <Stat
          label="Token 1"
          value={truncateAddress(pool.token1)}
          title={pool.token1 ?? undefined}
          mono
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
  value: string;
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

function SwapsTab({ poolId, limit }: { poolId: string; limit: number }) {
  const { data, error, isLoading } = useGQL<{ SwapEvent: SwapEvent[] }>(
    POOL_SWAPS,
    { poolId, limit },
  );
  const swaps = data?.SwapEvent ?? [];

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (swaps.length === 0) return <EmptyBox message="No swaps for this pool." />;

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Tx</Th>
          <Th>Sender</Th>
          <Th align="right">Amt0 In</Th>
          <Th align="right">Amt1 In</Th>
          <Th align="right">Amt0 Out</Th>
          <Th align="right">Amt1 Out</Th>
          <Th align="right">Block</Th>
          <Th>Time</Th>
        </tr>
      </thead>
      <tbody>
        {swaps.map((s) => (
          <Row key={s.id}>
            <TxHashCell txHash={s.txHash} />
            <SenderCell address={s.sender} />
            <Td mono small align="right">
              {formatWei(s.amount0In)}
            </Td>
            <Td mono small align="right">
              {formatWei(s.amount1In)}
            </Td>
            <Td mono small align="right">
              {formatWei(s.amount0Out)}
            </Td>
            <Td mono small align="right">
              {formatWei(s.amount1Out)}
            </Td>
            <Td mono small muted align="right">
              {formatBlock(s.blockNumber)}
            </Td>
            <Td small muted title={formatTimestamp(s.blockTimestamp)}>
              {relativeTime(s.blockTimestamp)}
            </Td>
          </Row>
        ))}
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

  // VirtualPools never emit UpdateReserves/Rebalanced so they never generate snapshots
  if (pool && !isFpmm(pool)) {
    return (
      <EmptyBox message="VirtualPool — no snapshot data available." />
    );
  }

  const { data, error, isLoading } = useGQL<{
    PoolSnapshot: PoolSnapshot[];
  }>(POOL_SNAPSHOTS, { poolId, limit });
  const rows = data?.PoolSnapshot ?? [];

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
