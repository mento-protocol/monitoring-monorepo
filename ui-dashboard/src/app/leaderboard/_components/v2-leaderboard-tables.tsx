"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { Table, Row, Td, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import { AddressLink } from "@/components/address-link";
import { Skeleton, EmptyBox, ErrorBox } from "@/components/feedback";
import { formatUSD, relativeTime } from "@/lib/format";
import {
  aggregateBrokerViaByTrader,
  buildBrokerViaMarkerIdRegex,
  cmpBigInt,
  weiToUsd,
  type BrokerAggregatorTraderDayMarkerRow,
  type BrokerTraderViaRoute,
  type BrokerTraderWindowRow,
} from "@/lib/leaderboard";
import { useTableSort } from "@/lib/use-table-sort";
import { networkForChainId } from "@/lib/networks";
import { BROKER_AGGREGATOR_TRADER_DAY_MARKERS } from "@/lib/queries/leaderboard-via";
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

  const viaMarkerRegex = useMemo(
    () =>
      isLoading || hasError
        ? null
        : buildBrokerViaMarkerIdRegex(sorted, cutoff),
    [cutoff, hasError, isLoading, sorted],
  );
  const viaResult = useGQL<{
    BrokerAggregatorTraderDayMarker: BrokerAggregatorTraderDayMarkerRow[];
  }>(
    viaMarkerRegex ? BROKER_AGGREGATOR_TRADER_DAY_MARKERS : null,
    viaMarkerRegex ? { idRegex: viaMarkerRegex, limit: ENVIO_MAX_ROWS } : {},
    undefined,
    { timeoutMs: 8_000 },
  );
  const viaByTrader = useMemo(
    () =>
      aggregateBrokerViaByTrader(
        viaResult.data?.BrokerAggregatorTraderDayMarker ?? [],
      ),
    [viaResult.data],
  );

  if (hasError) {
    return (
      <ErrorBox message="Couldn't load the v2 trader leaderboard. Retrying automatically every 30 s." />
    );
  }
  if (isLoading) return <Skeleton rows={10} />;
  if (sorted.length === 0) {
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
                  {row.isSystemAddress && <SystemAddressChip />}
                </span>
              </Td>
              <Td>
                <ViaCell
                  routes={viaByTrader.get(
                    `${row.chainId}-${row.trader.toLowerCase()}`,
                  )}
                  isLoading={Boolean(viaMarkerRegex) && viaResult.isLoading}
                  hasError={Boolean(viaResult.error)}
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
}: {
  routes: readonly BrokerTraderViaRoute[] | undefined;
  isLoading: boolean;
  hasError: boolean;
}) {
  if (isLoading) {
    return <span className="text-slate-500">...</span>;
  }
  if (hasError) {
    return (
      <span
        className="text-slate-500"
        title="Couldn't load v2 route attribution."
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
      title={`Observed route buckets: ${routes.map((route) => route.aggregator).join(", ")}`}
    >
      {shown.map((route) => (
        <AggregatorLabel key={route.aggregator} name={route.aggregator} />
      ))}
      {hidden.length > 0 && (
        <span className="rounded bg-slate-800/60 px-1.5 py-0.5 text-[11px] font-medium text-slate-300">
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
