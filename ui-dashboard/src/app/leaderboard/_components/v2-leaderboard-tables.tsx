"use client";

import { useMemo } from "react";
import { Table, Row, Td, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import { AddressLink } from "@/components/address-link";
import { Skeleton, EmptyBox, ErrorBox } from "@/components/feedback";
import { formatUSD, relativeTime } from "@/lib/format";
import {
  weiToUsd,
  type BrokerAggregatorWindowRow,
  type BrokerTraderWindowRow,
} from "@/lib/leaderboard";
import { useTableSort } from "@/lib/use-table-sort";
import { networkForChainId } from "@/lib/networks";

const PAGE_LIMIT = 50;

// ─── Trader table ─────────────────────────────────────────────────────────

const TRADER_SORT_KEYS = ["volume", "swaps", "lastSeen"] as const;
type TraderSortKey = (typeof TRADER_SORT_KEYS)[number];
const TRADER_VALID_KEYS = new Set<TraderSortKey>(TRADER_SORT_KEYS);

export function V2LeaderboardTraderTable({
  traders,
  isLoading,
  hasError,
}: {
  traders: readonly BrokerTraderWindowRow[];
  isLoading: boolean;
  hasError: boolean;
}) {
  const { sortKey, sortDir, handleSort } = useTableSort<TraderSortKey>({
    defaultKey: "volume",
    defaultDir: "desc",
    validKeys: TRADER_VALID_KEYS,
    paramPrefix: "v2trader",
  });

  const sorted = useMemo(() => {
    const sign = sortDir === "asc" ? 1 : -1;
    const arr = [...traders];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "volume":
          cmp = sign * cmpBigInt(a.volumeUsdWei, b.volumeUsdWei);
          break;
        case "swaps":
          cmp = sign * (a.swapCount - b.swapCount);
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
      <ErrorBox message="Couldn't load the v2 producer leaderboard. Retrying automatically every 30 s." />
    );
  }
  if (isLoading) return <Skeleton rows={10} />;
  if (sorted.length === 0) {
    return (
      <EmptyBox message="No legacy-v2 producers in this window. Either v2 volume has stopped — celebrate — or try widening the range / showing system addresses." />
    );
  }

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800">
          <Th align="right">#</Th>
          <Th>Producer</Th>
          <SortableTh
            sortKey="volume"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            v2 Volume
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
            sortKey="lastSeen"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Last active
          </SortableTh>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, idx) => {
          const network = networkForChainId(row.chainId);
          return (
            <Row key={`${row.chainId}-${row.trader}`}>
              <Td align="right" muted>
                {idx + 1}
              </Td>
              <Td>
                <span className="inline-flex items-center gap-1.5">
                  {network && <ChainIcon network={network} />}
                  <AddressLink address={row.trader} chainId={row.chainId} />
                  {row.isSystemAddress && (
                    <span
                      className="rounded bg-slate-700/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-slate-300"
                      title="Mento internal contract (rebalancer, NTT, treasury, etc.)"
                    >
                      System
                    </span>
                  )}
                </span>
              </Td>
              <Td align="right" mono>
                {formatUSD(weiToUsd(row.volumeUsdWei))}
              </Td>
              <Td align="right" mono>
                {row.swapCount.toLocaleString()}
              </Td>
              <Td align="right" muted>
                {relativeTime(String(row.lastSeenTimestamp))}
              </Td>
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}

// ─── Aggregator table ─────────────────────────────────────────────────────

const AGG_SORT_KEYS = ["volume", "swaps", "traders"] as const;
type AggSortKey = (typeof AGG_SORT_KEYS)[number];
const AGG_VALID_KEYS = new Set<AggSortKey>(AGG_SORT_KEYS);

export function V2LeaderboardAggregatorTable({
  aggregators,
  isLoading,
  hasError,
}: {
  aggregators: readonly BrokerAggregatorWindowRow[];
  isLoading: boolean;
  hasError: boolean;
}) {
  const { sortKey, sortDir, handleSort } = useTableSort<AggSortKey>({
    defaultKey: "volume",
    defaultDir: "desc",
    validKeys: AGG_VALID_KEYS,
    paramPrefix: "v2agg",
  });

  const sorted = useMemo(() => {
    const sign = sortDir === "asc" ? 1 : -1;
    const arr = [...aggregators];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "volume":
          cmp = sign * cmpBigInt(a.volumeUsdWei, b.volumeUsdWei);
          break;
        case "swaps":
          cmp = sign * (a.swapCount - b.swapCount);
          break;
        case "traders":
          cmp = sign * (a.uniqueTradersApprox - b.uniqueTradersApprox);
          break;
      }
      if (cmp !== 0) return cmp;
      if (a.chainId !== b.chainId) return a.chainId - b.chainId;
      return a.aggregator.localeCompare(b.aggregator);
    });
    return arr.slice(0, PAGE_LIMIT);
  }, [aggregators, sortKey, sortDir]);

  if (hasError) {
    return (
      <ErrorBox message="Couldn't load the v2 aggregator breakdown. Retrying automatically every 30 s." />
    );
  }
  if (isLoading) return <Skeleton rows={4} />;
  if (sorted.length === 0) {
    return (
      <EmptyBox message="No legacy-v2 aggregator activity in this window." />
    );
  }

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800">
          <Th align="right">#</Th>
          <Th>Aggregator</Th>
          <Th>Last-seen router</Th>
          <SortableTh
            sortKey="volume"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            v2 Volume
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
            sortKey="traders"
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            align="right"
          >
            Unique traders
          </SortableTh>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, idx) => {
          const network = networkForChainId(row.chainId);
          return (
            <Row key={`${row.chainId}-${row.aggregator}`}>
              <Td align="right" muted>
                {idx + 1}
              </Td>
              <Td>
                <span className="inline-flex items-center gap-1.5">
                  {network && <ChainIcon network={network} />}
                  <AggregatorLabel name={row.aggregator} />
                </span>
              </Td>
              <Td>
                <AddressLink
                  address={row.lastSeenAggregatorAddress}
                  chainId={row.chainId}
                  readOnly
                />
              </Td>
              <Td align="right" mono>
                {formatUSD(weiToUsd(row.volumeUsdWei))}
              </Td>
              <Td align="right" mono>
                {row.swapCount.toLocaleString()}
              </Td>
              <Td
                align="right"
                mono
                title="Lower bound: max single-day uniqueTraders across the window's days. True window-unique would need a per-window marker."
              >
                ≥ {row.uniqueTradersApprox.toLocaleString()}
              </Td>
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Render the canonical aggregator name with light styling. "unknown" gets a
 * warning amber so the curation backlog stands out — this is the row that
 * triggers a follow-up to add the router to `aggregators.json` and (more
 * importantly) reach out to whoever runs it about migrating to v3.
 */
function AggregatorLabel({ name }: { name: string }) {
  const isUnknown = name === "unknown";
  const isCluster = name.startsWith("cluster-");
  const isSystem = name === "system";
  const isDirect = name === "direct";
  const className = isUnknown
    ? "rounded bg-amber-900/40 px-1.5 py-0.5 text-[11px] font-medium text-amber-200"
    : isCluster
      ? "rounded bg-slate-800/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-300"
      : isSystem || isDirect
        ? "rounded bg-slate-800/60 px-1.5 py-0.5 text-[11px] font-medium text-slate-300"
        : "rounded bg-indigo-900/30 px-1.5 py-0.5 text-[11px] font-medium text-indigo-200";
  return <span className={className}>{name}</span>;
}

function cmpBigInt(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
