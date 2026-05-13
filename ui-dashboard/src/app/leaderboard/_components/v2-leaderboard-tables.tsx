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
  buildBrokerViaMarkerIdRegex,
  cmpBigInt,
  weiToUsd,
  type BrokerTraderViaRoute,
  type BrokerTraderWindowRow,
} from "@/lib/leaderboard";
import { useTableSort } from "@/lib/use-table-sort";
import { networkForChainId } from "@/lib/networks";
import { useBrokerViaMarkers } from "../_lib/use-broker-via-markers";
import { AggregatorLabel } from "./aggregator-breakdown-section";
import { SystemAddressChip } from "./system-address-chip";

const PAGE_LIMIT = 50;

// ─── Trader table ─────────────────────────────────────────────────────────

const TRADER_SORT_KEYS = ["volume", "swaps", "lastSeen"] as const;
type TraderSortKey = (typeof TRADER_SORT_KEYS)[number];
const TRADER_VALID_KEYS = new Set<TraderSortKey>(TRADER_SORT_KEYS);

export function V2LeaderboardTraderTable({
  cutoff,
  traders,
  isLoading,
  hasError,
}: {
  cutoff: number;
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

  const viaUnavailableReason =
    cutoff <= 0
      ? "Via attribution is shown for bounded time windows only. All-time marker history can exceed the query cap."
      : undefined;

  // Keep the Via side query scoped to the rows actually rendered. Sort changes
  // can change the visible top-50 slice, so attribution follows `visibleRows`
  // instead of fetching markers for every aggregated trader in the response.
  const viaMarkerRegex = useMemo(
    () =>
      isLoading || hasError || viaUnavailableReason
        ? null
        : buildBrokerViaMarkerIdRegex(visibleRows, cutoff),
    [cutoff, hasError, isLoading, viaUnavailableReason, visibleRows],
  );
  const viaResult = useBrokerViaMarkers(viaMarkerRegex);
  const viaTruncated = Boolean(viaResult.data?.truncated);
  const viaRows = viaTruncated ? [] : (viaResult.data?.rows ?? []);
  const viaByTrader = useMemo(
    () => aggregateBrokerViaByTrader(viaRows),
    [viaRows],
  );
  const viaErrorReason = viaTruncated
    ? "Couldn't load complete v2 route attribution before the query page limit."
    : undefined;

  if (hasError) {
    return (
      <ErrorBox message="Couldn't load the v2 trader leaderboard. Retrying automatically every 30 s." />
    );
  }
  if (isLoading) return <Skeleton rows={10} />;
  if (visibleRows.length === 0) {
    return (
      <EmptyBox message="No legacy-v2 traders in this window. Either v2 volume has stopped — celebrate — or try widening the range / showing system addresses." />
    );
  }

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800">
          <Th align="right">#</Th>
          <Th>Trader</Th>
          <Th>Via</Th>
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
        {visibleRows.map((row, idx) => {
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
                  {row.isSystemAddress && <SystemAddressChip />}
                </span>
              </Td>
              <Td>
                <ViaCell
                  routes={viaByTrader.get(
                    `${row.chainId}-${row.trader.toLowerCase()}`,
                  )}
                  isLoading={Boolean(viaMarkerRegex) && viaResult.isLoading}
                  hasError={Boolean(viaResult.error) || viaTruncated}
                  errorReason={viaErrorReason}
                  unavailableReason={viaUnavailableReason}
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
        })}
      </tbody>
    </Table>
  );
}

function ViaCell({
  routes,
  isLoading,
  hasError,
  errorReason,
  unavailableReason,
}: {
  routes: readonly BrokerTraderViaRoute[] | undefined;
  isLoading: boolean;
  hasError: boolean;
  errorReason?: string;
  unavailableReason?: string;
}) {
  if (isLoading) {
    return <span className="text-slate-500">...</span>;
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
      title={`Observed route labels: ${routes
        .map((route) => brokerViaDisplayName(route.aggregator))
        .join(", ")}`}
    >
      {shown.map((route) => (
        <AggregatorLabel
          key={route.aggregator}
          name={route.aggregator}
          label={brokerViaDisplayName(route.aggregator)}
        />
      ))}
      {hidden.length > 0 && (
        <span className="rounded bg-slate-800/60 px-1.5 py-0.5 text-[11px] font-medium text-slate-300">
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
