"use client";

import { useMemo } from "react";
import { getClusterMetadata } from "@mento-protocol/monitoring-config/aggregators";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { formatUSD } from "@/lib/format";
import { Table, Row, Td, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import { AddressLink } from "@/components/address-link";
import { Skeleton, EmptyBox, ErrorBox } from "@/components/feedback";
import {
  TimeSeriesChartCard,
  type BreakdownSeries,
} from "@/components/time-series-chart-card";
import { useTableSort } from "@/lib/use-table-sort";
import { networkForChainId } from "@/lib/networks";
import { cmpBigInt, weiToUsd } from "@/lib/leaderboard";
import type { AggregatorWindowRow } from "@/lib/leaderboard-aggregators";
import type { TimeSeriesPoint, RangeKey } from "@/lib/time-series";

const PAGE_LIMIT = 50;

const AGG_SORT_KEYS = ["volume", "swaps", "traders"] as const;
type AggSortKey = (typeof AGG_SORT_KEYS)[number];
const AGG_VALID_KEYS = new Set<AggSortKey>(AGG_SORT_KEYS);

type ChartProps = {
  series: TimeSeriesPoint[];
  breakdown: BreakdownSeries[];
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
  ranges: ReadonlyArray<{ key: RangeKey; label: string }>;
  headline: string;
};

export function AggregatorBreakdownSection({
  venueLabel,
  rangeLabel,
  aggregators,
  isLoading,
  hasError,
  isCapHit,
  chart,
}: {
  venueLabel: "v3" | "v2";
  rangeLabel: string;
  aggregators: readonly AggregatorWindowRow[];
  isLoading: boolean;
  hasError: boolean;
  isCapHit: boolean;
  chart?: ChartProps;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-slate-300">
          {venueLabel} volume by aggregator / entry-point ({rangeLabel})
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Canonical name from <code>aggregators.json</code>. Large{" "}
          <span className="rounded bg-amber-900/40 px-1 py-px text-amber-200">
            unknown
          </span>{" "}
          rows are unclassified routers. Cluster rows include a deployer link
          for curation.
        </p>
      </div>
      {isCapHit && (
        <div className="rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90">
          <strong className="font-medium">Approximate aggregator list.</strong>{" "}
          Showing the top {ENVIO_MAX_ROWS.toLocaleString()} aggregator-day rows
          by single-day volume — long-tail aggregators whose daily volume
          doesn&apos;t crack the cap may be missing.
        </div>
      )}
      {chart && (
        <TimeSeriesChartCard
          title={`${venueLabel} volume by aggregator`}
          rangeAriaLabel={`${venueLabel} aggregator chart range`}
          series={chart.series}
          breakdown={chart.breakdown}
          breakdownMode="stacked"
          range={chart.range}
          onRangeChange={chart.onRangeChange}
          ranges={chart.ranges}
          headline={chart.headline}
          change={null}
          isLoading={isLoading}
          hasError={hasError}
          hasSnapshotError={false}
          emptyMessage={`No ${venueLabel} aggregator volume in this window.`}
          chartHeightPx={230}
          yAxisTopPadding={0}
          customSortedHover
        />
      )}
      <AggregatorTable
        aggregators={aggregators}
        venueLabel={venueLabel}
        isLoading={isLoading}
        hasError={hasError}
      />
    </section>
  );
}

function AggregatorTable({
  aggregators,
  venueLabel,
  isLoading,
  hasError,
}: {
  aggregators: readonly AggregatorWindowRow[];
  venueLabel: "v3" | "v2";
  isLoading: boolean;
  hasError: boolean;
}) {
  const { sortKey, sortDir, handleSort } = useTableSort<AggSortKey>({
    defaultKey: "volume",
    defaultDir: "desc",
    validKeys: AGG_VALID_KEYS,
    paramPrefix: `${venueLabel}agg`,
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
      <ErrorBox
        message={`Couldn't load the ${venueLabel} aggregator breakdown. Retrying automatically every 30 s.`}
      />
    );
  }
  if (isLoading) return <Skeleton rows={4} />;
  if (sorted.length === 0) {
    return (
      <EmptyBox
        message={`No ${venueLabel} aggregator activity in this window.`}
      />
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
                <span aria-hidden="true">
                  ≥ {row.uniqueTradersApprox.toLocaleString()}
                </span>
                <span className="sr-only">
                  At least {row.uniqueTradersApprox.toLocaleString()} unique
                  traders (lower bound; max single-day count over the window).
                </span>
              </Td>
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}

function AggregatorLabel({ name }: { name: string }) {
  const meta = getClusterMetadata(name);
  return (
    <span className="inline-flex items-center gap-1">
      <span className={aggregatorLabelClass(name)}>{name}</span>
      {meta && (
        <a
          href={meta.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-700 text-[10px] font-semibold text-slate-400 hover:border-indigo-500 hover:text-indigo-300"
          title={`Shared deployer: ${meta.deployer}. ${meta.note ?? "Cluster label is based on shared deployer provenance."}`}
          aria-label={`${name} shared deployer ${meta.deployer}`}
        >
          i
        </a>
      )}
    </span>
  );
}

function aggregatorLabelClass(name: string): string {
  if (name === "unknown") {
    return "rounded bg-amber-900/40 px-1.5 py-0.5 text-[11px] font-medium text-amber-200";
  }
  if (name.startsWith("cluster-")) {
    return "rounded bg-slate-800/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-300";
  }
  if (name === "system" || name === "direct") {
    return "rounded bg-slate-800/60 px-1.5 py-0.5 text-[11px] font-medium text-slate-300";
  }
  return "rounded bg-indigo-900/30 px-1.5 py-0.5 text-[11px] font-medium text-indigo-200";
}
