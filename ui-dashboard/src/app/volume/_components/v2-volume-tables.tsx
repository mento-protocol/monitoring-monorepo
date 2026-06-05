"use client";

import { useMemo } from "react";
import { Table, Row, Td, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import { AddressLink } from "@/components/address-link";
import { Skeleton, EmptyBox, ErrorBox } from "@/components/feedback";
import { formatUSD, relativeTime } from "@/lib/format";
import {
  aggregateBrokerViaByTrader,
  brokerViaDisplayName,
  cmpBigInt,
  weiToUsd,
  type BrokerTraderViaRoute,
  type BrokerTraderWindowRow,
} from "@/lib/volume";
import { useTableSort } from "@/lib/use-table-sort";
import { networkForChainId } from "@/lib/networks";
import { useBrokerViaMarkers } from "../_lib/use-broker-via-markers";
import { AggregatorLabel } from "./aggregator-breakdown-section";
import { ProtocolActorChip } from "./protocol-actor-chip";

const PAGE_LIMIT = 50;

// ─── Trader table ─────────────────────────────────────────────────────────

const TRADER_SORT_KEYS = ["volume", "swaps", "lastSeen"] as const;
type TraderSortKey = (typeof TRADER_SORT_KEYS)[number];
const TRADER_VALID_KEYS = new Set<TraderSortKey>(TRADER_SORT_KEYS);

function useV2TraderVia({
  cutoff,
  visibleRows,
  isLoading,
  hasError,
}: {
  cutoff: number;
  visibleRows: readonly BrokerTraderWindowRow[];
  isLoading: boolean;
  hasError: boolean;
}) {
  const unavailableReason =
    cutoff <= 0
      ? "Via attribution is shown for bounded time windows only. All-time marker history can exceed the query cap."
      : undefined;
  // Keep the Via side query scoped to the rows actually rendered. Sort changes
  // can change the visible top-50 slice, so attribution follows `visibleRows`
  // instead of fetching markers for every aggregated trader in the response.
  const callers = useMemo(() => {
    if (isLoading || hasError || unavailableReason) return null;
    if (visibleRows.length === 0) return null;
    return [...new Set(visibleRows.map((row) => row.trader.toLowerCase()))];
  }, [hasError, isLoading, unavailableReason, visibleRows]);
  const result = useBrokerViaMarkers(callers, cutoff);
  const truncated = Boolean(result.data?.truncated);
  const rows = truncated ? [] : (result.data?.rows ?? []);
  const byTrader = useMemo(() => aggregateBrokerViaByTrader(rows), [rows]);
  const errorReason = truncated
    ? "Couldn't load complete v2 route attribution before the query page limit."
    : result.error
      ? "Couldn't load v2 route attribution."
      : undefined;
  return {
    byTrader,
    isLoading: Boolean(callers) && result.isLoading,
    hasError: Boolean(result.error) || truncated,
    errorReason,
    unavailableReason,
  };
}

export function V2VolumeTraderTable({
  cutoff,
  traders,
  emptyMessage,
  isLoading,
  hasError,
  hasExploratoryExclusions,
}: {
  cutoff: number;
  traders: readonly BrokerTraderWindowRow[];
  emptyMessage: string;
  isLoading: boolean;
  hasError: boolean;
  hasExploratoryExclusions: boolean;
}) {
  const { sortKey, sortDir, handleSort } = useTableSort<TraderSortKey>({
    defaultKey: "volume",
    defaultDir: "desc",
    validKeys: TRADER_VALID_KEYS,
    paramPrefix: "v2trader",
  });

  const visibleRows = useMemo(() => {
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

  const via = useV2TraderVia({ cutoff, visibleRows, isLoading, hasError });

  if (hasError) {
    return (
      <ErrorBox message="Couldn't load v2 volume. Retrying automatically every 30 s." />
    );
  }
  if (isLoading) return <Skeleton rows={10} />;
  if (visibleRows.length === 0) {
    return (
      <EmptyBox
        message={
          hasExploratoryExclusions
            ? "No legacy-v2 traders left after exploratory exclusions. Clear exclusions or widen the range."
            : emptyMessage
        }
      />
    );
  }

  // The degraded-Via banner mirrors the aggregator-table cap-hit pattern so
  // operators get a visible, keyboard/SR-accessible signal — not just
  // tooltip text — when route attribution is incomplete vs. when the row
  // genuinely has no markers.
  const viaBanner = via.hasError
    ? (via.errorReason ?? "Couldn't load v2 route attribution.")
    : (via.unavailableReason ?? null);
  return (
    <div className="space-y-3">
      {viaBanner && (
        <div
          className="rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90"
          role="status"
        >
          <strong className="font-medium">Via column degraded.</strong>{" "}
          {viaBanner}
        </div>
      )}
      <Table>
        <V2TraderTableHead
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          viaIsLoading={via.isLoading}
        />
        <tbody>
          {visibleRows.map((row, idx) => (
            <V2TraderRow
              key={`${row.chainId}-${row.trader}`}
              row={row}
              rank={idx + 1}
              via={via}
            />
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function V2TraderTableHead({
  sortKey,
  sortDir,
  onSort,
  viaIsLoading,
}: {
  sortKey: TraderSortKey;
  sortDir: "asc" | "desc";
  onSort: (key: TraderSortKey) => void;
  viaIsLoading: boolean;
}) {
  return (
    <thead>
      <tr className="border-b border-slate-800">
        <Th align="right">#</Th>
        <Th>Trader</Th>
        <Th>
          <span className="inline-flex items-center gap-1.5">
            Via
            {viaIsLoading && (
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400"
                title="Loading v2 route attribution"
              />
            )}
          </span>
        </Th>
        <SortableTh
          sortKey="volume"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
        >
          v2 Volume
        </SortableTh>
        <SortableTh
          sortKey="swaps"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
        >
          Swaps
        </SortableTh>
        <SortableTh
          sortKey="lastSeen"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align="right"
        >
          Last active
        </SortableTh>
      </tr>
    </thead>
  );
}

function V2TraderRow({
  row,
  rank,
  via,
}: {
  row: BrokerTraderWindowRow;
  rank: number;
  via: ReturnType<typeof useV2TraderVia>;
}) {
  const network = networkForChainId(row.chainId);
  return (
    <Row>
      <Td align="right" muted>
        {rank}
      </Td>
      <Td>
        <span className="inline-flex items-center gap-1.5">
          {network && <ChainIcon network={network} />}
          <AddressLink address={row.trader} chainId={row.chainId} />
          {row.isProtocolActor && <ProtocolActorChip />}
        </span>
      </Td>
      <Td>
        <ViaCell
          chainId={row.chainId}
          routes={via.byTrader.get(
            `${row.chainId}-${row.trader.toLowerCase()}`,
          )}
          isLoading={via.isLoading}
          hasError={via.hasError}
          errorReason={via.errorReason}
          unavailableReason={via.unavailableReason}
        />
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
}

function ViaCell({
  chainId,
  routes,
  isLoading,
  hasError,
  errorReason,
  unavailableReason,
}: {
  chainId: number;
  routes: readonly BrokerTraderViaRoute[] | undefined;
  isLoading: boolean;
  hasError: boolean;
  errorReason?: string | undefined;
  unavailableReason?: string | undefined;
}) {
  if (isLoading) {
    return (
      <span
        className="inline-flex h-5 min-w-[4.75rem] items-center gap-1.5 rounded bg-slate-800/70 px-2 text-[11px] font-medium text-slate-400"
        title="Loading v2 route attribution"
        aria-label="Loading v2 route attribution"
        role="status"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
        <span>Loading</span>
      </span>
    );
  }
  if (unavailableReason) {
    return (
      <span className="text-slate-500" title={unavailableReason}>
        -
      </span>
    );
  }
  if (hasError) {
    return (
      <span
        className="text-slate-500"
        title={errorReason ?? "Couldn't load v2 route attribution."}
      >
        -
      </span>
    );
  }
  if (!routes || routes.length === 0) {
    return (
      <span
        className="text-slate-500"
        title="No route marker found for this trader in the selected window."
      >
        -
      </span>
    );
  }

  const shown = routes.slice(0, 2);
  const hidden = routes.slice(2);
  return (
    <span
      className="inline-flex max-w-[16rem] flex-wrap items-center gap-1"
      title={routeTooltipText(routes)}
    >
      {shown.map((route) => (
        <ViaRoutePill key={route.key} chainId={chainId} route={route} />
      ))}
      {hidden.length > 0 && (
        <span className="rounded bg-slate-800/60 px-1.5 py-0.5 text-[11px] font-medium text-slate-300">
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

function ViaRoutePill({
  chainId,
  route,
}: {
  chainId: number;
  route: BrokerTraderViaRoute;
}) {
  // Cluster bucket: preserve the "one fleet" signal (trader 0x7DC0…F022
  // rotates across 4 contracts under cluster-7dc08ec28f299c06). Render the
  // existing cluster pill with its deployer-info tooltip — clicking the (i)
  // already deep-links to the explorer entry.
  if (route.isCluster) {
    return (
      <AggregatorLabel
        name={route.aggregator}
        label={brokerViaDisplayName(route.aggregator)}
      />
    );
  }
  // Address pill: the linked AddressLink resolves the address-book label and
  // links to the explorer. For known aggregator labels (Squid, mento-router-v2,
  // etc.) the address-book typically already names them; for `unknown` we fall
  // back to a truncated address — that alone is more useful than the generic
  // bucket name when the trader uses exactly one router.
  // `route.txTo` is narrowed to `string` here by the discriminated union on
  // `BrokerTraderViaRoute` (the cluster branch above carries `txTo: null`).
  // No null fallback needed.
  return (
    <span className="inline-flex items-center gap-1 rounded bg-slate-800/60 px-1.5 py-0.5 text-[11px] font-medium text-slate-300">
      <AddressLink address={route.txTo} chainId={chainId} readOnly />
    </span>
  );
}

function routeTooltipText(routes: readonly BrokerTraderViaRoute[]): string {
  return `Observed routes in this window, ordered by active days: ${routes
    .map((route) => {
      const days = `${route.days} active ${route.days === 1 ? "day" : "days"}`;
      if (route.isCluster) {
        return `${brokerViaDisplayName(route.aggregator)} (${days})`;
      }
      const label = brokerViaDisplayName(route.aggregator);
      return `${label} via ${route.txTo} (${days})`;
    })
    .join(", ")}`;
}
