"use client";

import { Fragment, useMemo, useState } from "react";
import { useGQL } from "@/lib/graphql";
import { Table, Row, Td, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import { AddressLink } from "@/components/address-link";
import { Skeleton, EmptyBox, ErrorBox } from "@/components/feedback";
import { formatUSD, relativeTime } from "@/lib/format";
import {
  aggregateTraderPoolsByWindow,
  cmpBigInt,
  computeFlow,
  weiToUsd,
  type TraderPoolDailyRow,
  type TraderPoolWindowRow,
  type TraderWindowRow,
} from "@/lib/leaderboard";
import { computeLpFriendliness } from "@/lib/leaderboard-insights";
import { useTableSort } from "@/lib/use-table-sort";
import { networkForChainId } from "@/lib/networks";
import { poolName } from "@/lib/tokens";
import { TRADER_POOL_DAILY_FOR_TRADER } from "@/lib/queries/leaderboard";
import { TraderPoolDailyForTraderSchema } from "@/lib/queries/leaderboard-schemas";
import { FlowBadge } from "./flow-badge";
import { LpFriendlinessBadge } from "./lp-friendliness-badge";
import { SystemAddressChip } from "./system-address-chip";

const SORT_KEYS = ["volume", "swaps", "pools", "fees", "lastSeen"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const VALID_KEYS = new Set<SortKey>(SORT_KEYS);

const PAGE_LIMIT = 50;

export function LeaderboardTable({
  cutoff,
  traders,
  pools,
  isLoading,
  hasError,
}: {
  /** Same cutoff timestamp the parent query uses. Passed in (rather than
   * recomputed in `TraderRow`) so per-row breakdown queries flush their
   * SWR cache key when the parent's UTC-day rollover ticker fires. */
  cutoff: number;
  traders: readonly TraderWindowRow[];
  pools: ReadonlyMap<string, { token0: string | null; token1: string | null }>;
  isLoading: boolean;
  hasError: boolean;
}) {
  const { sortKey, sortDir, handleSort } = useTableSort<SortKey>({
    defaultKey: "volume",
    defaultDir: "desc",
    validKeys: VALID_KEYS,
    paramPrefix: "leaderboard",
  });

  const sorted = useMemo(() => {
    const sign = sortDir === "asc" ? 1 : -1;
    const arr = [...traders];
    // Comparator falls back to `(chainId, trader)` lexicographic on the
    // primary key tying — without this, equal-key rows reorder across
    // SWR polls and the rank column shifts (cursor 3184000775).
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "volume":
          cmp = sign * cmpBigInt(a.volumeUsdWei, b.volumeUsdWei);
          break;
        case "swaps":
          cmp = sign * (a.swapCount - b.swapCount);
          break;
        case "pools":
          cmp = sign * (a.uniquePoolsApprox - b.uniquePoolsApprox);
          break;
        case "fees":
          cmp = sign * cmpBigInt(a.feesPaidUsdWei, b.feesPaidUsdWei);
          break;
        case "lastSeen":
          cmp = sign * (a.lastSeenTimestamp - b.lastSeenTimestamp);
          break;
      }
      if (cmp !== 0) return cmp;
      if (a.chainId !== b.chainId) return a.chainId - b.chainId;
      return a.trader.localeCompare(b.trader);
    });
    return arr.slice(0, PAGE_LIMIT);
  }, [traders, sortKey, sortDir]);

  if (hasError) {
    return (
      <ErrorBox message="Couldn't load the leaderboard. The indexer's GraphQL endpoint may be temporarily unavailable — retrying automatically every 30 s." />
    );
  }

  if (isLoading) {
    return <Skeleton rows={10} />;
  }

  if (sorted.length === 0) {
    return (
      <EmptyBox message="No traders matched this window. Try widening the range or toggling system addresses on." />
    );
  }

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800">
          <Th align="right">#</Th>
          <Th>Trader</Th>
          <SortableTh
            sortKey="volume"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Volume
          </SortableTh>
          <SortableTh
            sortKey="swaps"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Swaps
          </SortableTh>
          <SortableTh
            sortKey="pools"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Pools
          </SortableTh>
          <Th>Top pool</Th>
          <Th>Flow</Th>
          <SortableTh
            sortKey="fees"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Fees paid
          </SortableTh>
          <SortableTh
            sortKey="lastSeen"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Last active
          </SortableTh>
          <Th align="right" className="w-8" aria-label="Expand">
            <span className="sr-only">Expand</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((trader, idx) => (
          <TraderRow
            key={`${trader.chainId}-${trader.trader}`}
            rank={idx + 1}
            trader={trader}
            cutoff={cutoff}
            pools={pools}
          />
        ))}
      </tbody>
    </Table>
  );
}

function TraderRow({
  rank,
  trader,
  cutoff,
  pools,
}: {
  rank: number;
  trader: TraderWindowRow;
  /** Cutoff timestamp from the parent — already accounts for UTC-day
   * rollover, so the breakdown SWR cache key flips at midnight too
   * (codex 3184420044, cursor 3184433460). */
  cutoff: number;
  pools: ReadonlyMap<string, { token0: string | null; token1: string | null }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const network = networkForChainId(trader.chainId);
  // Only fetch the pool breakdown after the user opens the row — paying for
  // 50 sub-queries upfront would defeat the point of paginated fetches.
  const breakdown = useGQL<{
    TraderPoolDailySnapshot: TraderPoolDailyRow[];
  }>(
    expanded ? TRADER_POOL_DAILY_FOR_TRADER : null,
    {
      chainId: trader.chainId,
      trader: trader.trader,
      afterTimestamp: cutoff,
    },
    { refreshInterval: 60_000, schema: TraderPoolDailyForTraderSchema },
  );
  const breakdownRows: TraderPoolWindowRow[] = useMemo(() => {
    if (!breakdown.data?.TraderPoolDailySnapshot) return [];
    return aggregateTraderPoolsByWindow(breakdown.data.TraderPoolDailySnapshot);
  }, [breakdown.data]);
  const primary = breakdownRows[0];
  const flow = primary ? computeFlow(primary) : null;
  const primaryPoolMeta = primary
    ? pools.get(primary.poolId.toLowerCase())
    : null;
  const primaryPoolLabel =
    primary && network && primaryPoolMeta
      ? poolName(network, primaryPoolMeta.token0, primaryPoolMeta.token1)
      : null;

  return (
    <Fragment>
      <Row>
        <Td align="right" muted>
          {rank}
        </Td>
        <Td>
          <span className="inline-flex items-center gap-1.5">
            {network && <ChainIcon network={network} />}
            <AddressLink address={trader.trader} chainId={trader.chainId} />
            {trader.isSystemAddress && <SystemAddressChip />}
          </span>
        </Td>
        <Td align="right" mono>
          {formatUSD(weiToUsd(trader.volumeUsdWei))}
        </Td>
        <Td align="right" mono>
          {trader.swapCount.toLocaleString()}
        </Td>
        <Td
          align="right"
          mono
          title={`Lower bound — max single-day unique pool count over the window. The trader may have touched more distinct pools across days.`}
        >
          ≥ {trader.uniquePoolsApprox}
        </Td>
        <Td>
          {expanded ? (
            primaryPoolLabel ? (
              <span className="text-slate-300">{primaryPoolLabel}</span>
            ) : breakdown.isLoading ? (
              <span className="text-slate-500">…</span>
            ) : (
              <span className="text-slate-500">—</span>
            )
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </Td>
        <Td>
          {flow ? (
            <FlowBadge flow={flow} />
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </Td>
        <Td align="right" mono>
          {formatUSD(weiToUsd(trader.feesPaidUsdWei))}
        </Td>
        <Td align="right" muted>
          {relativeTime(String(trader.lastSeenTimestamp))}
        </Td>
        <Td align="right">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `Collapse pool breakdown for ${trader.trader}`
                : `Expand pool breakdown for ${trader.trader}`
            }
            onClick={() => setExpanded((v) => !v)}
            className="rounded p-1 text-slate-500 hover:bg-slate-800/60 hover:text-slate-200 transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              // Both states need an explicit `transform` so the CSS
              // transition fires on collapse too — `undefined` would
              // remove the inline style and snap back instantly.
              style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 150ms ease",
              }}
            >
              <path d="M5 3l6 5-6 5V3z" />
            </svg>
          </button>
        </Td>
      </Row>
      {expanded && (
        <tr>
          <td colSpan={10} className="bg-slate-900/40 px-2 sm:px-4 pb-4 pt-2">
            <ExpandedBreakdown
              rows={breakdownRows}
              pools={pools}
              chainId={trader.chainId}
              isLoading={breakdown.isLoading}
              hasError={!!breakdown.error}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function ExpandedBreakdown({
  rows,
  pools,
  chainId,
  isLoading,
  hasError,
}: {
  rows: readonly TraderPoolWindowRow[];
  pools: ReadonlyMap<string, { token0: string | null; token1: string | null }>;
  chainId: number;
  isLoading: boolean;
  hasError: boolean;
}) {
  if (hasError) {
    return (
      <p className="text-xs text-red-400">
        Failed to load this trader&apos;s pool breakdown.
      </p>
    );
  }
  if (isLoading) return <Skeleton rows={2} />;
  if (rows.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        No per-pool detail available for this window.
      </p>
    );
  }
  const network = networkForChainId(chainId);
  return (
    <div className="rounded-md border border-slate-800/70 bg-slate-950/40">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-800/60 text-slate-500">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Pool
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Volume
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Swaps
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Flow
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Fees paid
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              LP
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 10).map((p) => {
            const meta = pools.get(p.poolId.toLowerCase());
            const label =
              network && meta
                ? poolName(network, meta.token0, meta.token1)
                : null;
            const sym0 =
              meta && network
                ? (network.tokenSymbols[(meta.token0 ?? "").toLowerCase()] ??
                  null)
                : null;
            const sym1 =
              meta && network
                ? (network.tokenSymbols[(meta.token1 ?? "").toLowerCase()] ??
                  null)
                : null;
            const flow = computeFlow(p);
            const lp = computeLpFriendliness(p);
            return (
              <tr
                key={p.poolId}
                className="border-b border-slate-800/40 last:border-b-0"
              >
                <td className="px-3 py-1.5 text-slate-300">
                  {label ?? (
                    <span className="font-mono text-slate-500">{p.poolId}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-300">
                  {formatUSD(weiToUsd(p.volumeUsdWei))}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-300">
                  {p.swapCount}
                </td>
                <td className="px-3 py-1.5">
                  <FlowBadge
                    flow={flow}
                    token0Symbol={sym0}
                    token1Symbol={sym1}
                  />
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-400">
                  {formatUSD(weiToUsd(p.feesPaidUsdWei))}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <LpFriendlinessBadge value={lp} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 10 && (
        <p className="px-3 py-2 text-[11px] text-slate-500">
          Showing top 10 of {rows.length} pools by volume.
        </p>
      )}
    </div>
  );
}
