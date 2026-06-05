"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { AddressLink } from "@/components/address-link";
import { ChainIcon } from "@/components/chain-icon";
import { Skeleton } from "@/components/feedback";
import { formatUSD, relativeTime } from "@/lib/format";
import {
  aggregateTradersByWindow,
  weiToUsd,
  type VolumeRangeKey,
  type TraderDailyRow,
  type TraderPoolDailyRow,
  type TraderWindowRow,
} from "@/lib/volume";
import {
  buildCorridorRows,
  buildTraderCohortSummary,
  filterSwapOutliers,
  parseUsdWei,
  previousVolumeWindowBounds,
  traderDayKey,
  type CorridorRow,
  type SwapOutlierRow,
  type TraderCohortSummary,
} from "@/lib/volume-insights";
import {
  SWAP_EVENT_OUTLIERS,
  TRADER_DAILY_WINDOW_TOP,
  TRADER_POOL_DAILY_TOP,
} from "@/lib/queries/volume";
import {
  SwapEventOutliersSchema,
  TraderDailyWindowTopSchema,
  TraderPoolDailyTopSchema,
} from "@/lib/queries/volume-schemas";
import { networkForChainId } from "@/lib/networks";
import { explorerTxUrl, poolName } from "@/lib/tokens";
import type { PoolMeta } from "../_lib/types";
import { LpFriendlinessBadge } from "./lp-friendliness-badge";

const INSIGHT_ROW_LIMIT = 10;
const SWAP_OUTLIER_FETCH_LIMIT = ENVIO_MAX_ROWS;

type FlowTableState = {
  isLoading: boolean;
  hasError: boolean;
  isCapHit: boolean;
};

export function V3FlowInsights({
  range,
  rangeLabel,
  cutoff,
  traderRows,
  traders,
  pools,
  protocolActorFilter,
  tableState,
}: {
  range: VolumeRangeKey;
  rangeLabel: string;
  cutoff: number;
  traderRows: readonly TraderDailyRow[];
  traders: readonly TraderWindowRow[];
  pools: PoolMeta;
  protocolActorFilter: ReadonlyArray<boolean>;
  tableState: FlowTableState;
}) {
  const model = useV3FlowInsightModel({
    range,
    cutoff,
    traderRows,
    traders,
    protocolActorFilter,
    isTraderCapHit: tableState.isCapHit,
  });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-slate-300">
          Flow insights ({rangeLabel})
        </h2>
        {model.insightPartial && (
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-300">
            Approximate top-query view
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <CohortPanel
          range={range}
          summary={model.cohortSummary}
          isLoading={tableState.isLoading || model.previousTradersIsLoading}
          hasError={tableState.hasError || model.previousTradersHasError}
          isPartial={model.isCohortCapHit}
        />
        <CorridorPanel
          rows={model.corridorRows}
          pools={pools}
          isLoading={tableState.isLoading || model.traderPoolIsLoading}
          hasError={tableState.hasError || model.traderPoolHasError}
          isPartial={model.isCorridorCapHit}
        />
        <OutlierPanel
          rows={model.swapOutliers}
          pools={pools}
          isLoading={tableState.isLoading || model.swapOutliersIsLoading}
          hasError={tableState.hasError || model.swapOutliersHasError}
          isPartial={model.isOutlierPartial}
        />
      </div>
    </section>
  );
}

function useV3FlowInsightModel({
  range,
  cutoff,
  traderRows,
  traders,
  protocolActorFilter,
  isTraderCapHit,
}: {
  range: VolumeRangeKey;
  cutoff: number;
  traderRows: readonly TraderDailyRow[];
  traders: readonly TraderWindowRow[];
  protocolActorFilter: ReadonlyArray<boolean>;
  isTraderCapHit: boolean;
}) {
  const previousBounds = useMemo(
    () => previousVolumeWindowBounds(range, cutoff),
    [range, cutoff],
  );
  const { previousTradersResult, traderPoolResult, swapOutliersResult } =
    useV3FlowInsightQueries({
      previousBounds,
      cutoff,
      protocolActorFilter,
    });
  const allowedTraderDayKeys = useMemo(
    () => buildAllowedTraderDayKeys(traderRows),
    [traderRows],
  );
  const previousTraders = useMemo(
    () =>
      aggregateTradersByWindow(
        previousTradersResult.data?.TraderDailySnapshot ?? [],
      ),
    [previousTradersResult.data],
  );
  const cohortSummary = useMemo(
    () =>
      previousBounds
        ? buildTraderCohortSummary({
            current: traders,
            previous: previousTraders,
          })
        : null,
    [previousBounds, traders, previousTraders],
  );
  const corridorRows = useMemo(
    () =>
      buildCorridorRows({
        rows: traderPoolResult.data?.TraderPoolDailySnapshot ?? [],
        allowedTraderDayKeys,
        limit: INSIGHT_ROW_LIMIT,
      }),
    [traderPoolResult.data, allowedTraderDayKeys],
  );
  const swapOutliers = useMemo(
    () =>
      filterSwapOutliers({
        rows: swapOutliersResult.data?.SwapEvent ?? [],
        allowedTraderDayKeys,
        limit: INSIGHT_ROW_LIMIT,
      }),
    [swapOutliersResult.data, allowedTraderDayKeys],
  );
  const isSwapOutlierFetchCapHit =
    (swapOutliersResult.data?.SwapEvent.length ?? 0) ===
    SWAP_OUTLIER_FETCH_LIMIT;
  const isCohortCapHit =
    isTraderCapHit ||
    (previousTradersResult.data?.TraderDailySnapshot.length ?? 0) ===
      ENVIO_MAX_ROWS;
  const isCorridorCapHit =
    isTraderCapHit ||
    (traderPoolResult.data?.TraderPoolDailySnapshot.length ?? 0) ===
      ENVIO_MAX_ROWS;
  const isOutlierPartial = isTraderCapHit || isSwapOutlierFetchCapHit;
  return {
    cohortSummary,
    corridorRows,
    swapOutliers,
    previousTradersIsLoading: previousTradersResult.isLoading,
    previousTradersHasError: !!previousTradersResult.error,
    traderPoolIsLoading: traderPoolResult.isLoading,
    traderPoolHasError: !!traderPoolResult.error,
    swapOutliersIsLoading: swapOutliersResult.isLoading,
    swapOutliersHasError: !!swapOutliersResult.error,
    isCohortCapHit,
    isCorridorCapHit,
    isOutlierPartial,
    insightPartial: isCohortCapHit || isCorridorCapHit || isOutlierPartial,
  };
}

function useV3FlowInsightQueries({
  previousBounds,
  cutoff,
  protocolActorFilter,
}: {
  previousBounds:
    | ReturnType<typeof previousVolumeWindowBounds>
    | null
    | undefined;
  cutoff: number;
  protocolActorFilter: ReadonlyArray<boolean>;
}) {
  const previousTradersResult = useGQL<{
    TraderDailySnapshot: TraderDailyRow[];
  }>(
    previousBounds ? TRADER_DAILY_WINDOW_TOP : null,
    previousBounds
      ? {
          afterTimestamp: previousBounds.afterTimestamp,
          beforeTimestamp: previousBounds.beforeTimestamp,
          isProtocolActorIn: protocolActorFilter,
          limit: ENVIO_MAX_ROWS,
        }
      : undefined,
    60_000,
    { timeoutMs: 8_000, schema: TraderDailyWindowTopSchema },
  );
  const traderPoolResult = useGQL<{
    TraderPoolDailySnapshot: TraderPoolDailyRow[];
  }>(
    TRADER_POOL_DAILY_TOP,
    { afterTimestamp: cutoff, limit: ENVIO_MAX_ROWS },
    60_000,
    { timeoutMs: 8_000, schema: TraderPoolDailyTopSchema },
  );
  const swapOutliersResult = useGQL<{
    SwapEvent: SwapOutlierRow[];
  }>(
    SWAP_EVENT_OUTLIERS,
    { afterTimestamp: cutoff, limit: SWAP_OUTLIER_FETCH_LIMIT },
    60_000,
    { timeoutMs: 8_000, schema: SwapEventOutliersSchema },
  );
  return { previousTradersResult, traderPoolResult, swapOutliersResult };
}

function buildAllowedTraderDayKeys(
  traderRows: readonly TraderDailyRow[],
): Set<string> {
  const keys = new Set<string>();
  for (const row of traderRows) {
    const key = traderDayKey(row.chainId, row.trader, row.timestamp);
    if (key !== null) keys.add(key);
  }
  return keys;
}

function CohortPanel({
  range,
  summary,
  isLoading,
  hasError,
  isPartial,
}: {
  range: VolumeRangeKey;
  summary: TraderCohortSummary | null;
  isLoading: boolean;
  hasError: boolean;
  isPartial: boolean;
}) {
  return (
    <InsightPanel title="Cohort + dormancy">
      {range === "all" ? (
        <PanelMessage message="Select a bounded range to compare trader cohorts." />
      ) : hasError ? (
        <PanelMessage
          variant="error"
          message="Couldn't load cohort comparison."
        />
      ) : isLoading || !summary ? (
        <Skeleton rows={4} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="New" value={summary.newCount} />
            <MiniStat label="Returning" value={summary.returningCount} />
            <MiniStat label="Dormant" value={summary.dormantCount} />
          </div>
          <div className="space-y-2 text-xs">
            <CohortLeader label="Top new" row={summary.topNewTrader} />
            <CohortLeader
              label="Top returning"
              row={summary.topReturningTrader}
            />
            <CohortLeader label="Top dormant" row={summary.topDormantTrader} />
          </div>
          <p className="text-[11px] text-slate-500">
            {summary.currentCount.toLocaleString()} active now vs{" "}
            {summary.previousCount.toLocaleString()} in the previous window
            {isPartial ? " (approx.)" : ""}.
          </p>
        </div>
      )}
    </InsightPanel>
  );
}

function CorridorPanel({
  rows,
  pools,
  isLoading,
  hasError,
  isPartial,
}: {
  rows: readonly CorridorRow[];
  pools: PoolMeta;
  isLoading: boolean;
  hasError: boolean;
  isPartial: boolean;
}) {
  return (
    <InsightPanel title="Corridor map">
      {hasError ? (
        <PanelMessage variant="error" message="Couldn't load corridor flows." />
      ) : isLoading ? (
        <Skeleton rows={4} />
      ) : isPartial && rows.length === 0 ? (
        <PanelMessage
          variant="warn"
          message="Corridor data may be incomplete; top-query cap reached."
        />
      ) : rows.length === 0 ? (
        <PanelMessage message="No directional corridors in this window." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th scope="col" className="py-2 pr-3 text-left font-medium">
                  Pool
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Direction
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Pressure
                </th>
                <th scope="col" className="py-2 pl-3 text-right font-medium">
                  LP
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <CorridorTableRow key={row.key} row={row} pools={pools} />
              ))}
            </tbody>
          </table>
          {isPartial && (
            <p className="pt-2 text-[11px] text-amber-300">
              Top-query subset; long-tail corridors may be absent.
            </p>
          )}
        </div>
      )}
    </InsightPanel>
  );
}

function OutlierPanel({
  rows,
  pools,
  isLoading,
  hasError,
  isPartial,
}: {
  rows: readonly SwapOutlierRow[];
  pools: PoolMeta;
  isLoading: boolean;
  hasError: boolean;
  isPartial: boolean;
}) {
  return (
    <InsightPanel title="Outlier swaps">
      {hasError ? (
        <PanelMessage variant="error" message="Couldn't load outlier swaps." />
      ) : isLoading ? (
        <Skeleton rows={4} />
      ) : isPartial && rows.length === 0 ? (
        <PanelMessage
          variant="warn"
          message="Outlier data may be incomplete; top-query cap reached."
        />
      ) : rows.length === 0 ? (
        <PanelMessage message="No outlier swaps in this window." />
      ) : (
        <div>
          <table className="w-full table-fixed text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th
                  scope="col"
                  className="w-[42%] py-2 pr-3 text-left font-medium whitespace-nowrap"
                >
                  Trader
                </th>
                <th
                  scope="col"
                  className="w-[34%] px-3 py-2 text-left font-medium whitespace-nowrap"
                >
                  Pool
                </th>
                <th
                  scope="col"
                  className="w-[24%] py-2 pl-3 text-right font-medium whitespace-nowrap"
                >
                  Volume
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <OutlierTableRow key={row.id} row={row} pools={pools} />
              ))}
            </tbody>
          </table>
          {isPartial && (
            <p className="pt-2 text-[11px] text-amber-300">
              Top-query subset; eligible outliers beyond the fetch cap may be
              absent.
            </p>
          )}
        </div>
      )}
    </InsightPanel>
  );
}

function InsightPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-white">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function PanelMessage({
  message,
  variant = "muted",
}: {
  message: string;
  variant?: "muted" | "warn" | "error";
}) {
  const tone =
    variant === "error"
      ? "text-red-400"
      : variant === "warn"
        ? "text-amber-300"
        : "text-slate-500";

  return (
    <p
      className={"py-8 text-center text-sm " + tone}
      role={variant === "error" ? "alert" : undefined}
    >
      {message}
    </p>
  );
}

function CohortLeader({
  label,
  row,
}: {
  label: string;
  row: TraderWindowRow | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      {row ? (
        <span className="inline-flex items-center gap-1.5">
          {networkForChainId(row.chainId) && (
            <ChainIcon network={networkForChainId(row.chainId)!} />
          )}
          <AddressLink address={row.trader} chainId={row.chainId} />
          <span className="font-mono text-slate-400">
            {formatUSD(weiToUsd(row.volumeUsdWei))}
          </span>
        </span>
      ) : (
        <span className="text-slate-500">—</span>
      )}
    </div>
  );
}

function CorridorTableRow({
  row,
  pools,
}: {
  row: CorridorRow;
  pools: PoolMeta;
}) {
  const network = networkForChainId(row.chainId);
  const meta = pools.get(row.poolId.toLowerCase());
  const label =
    network && meta ? poolName(network, meta.token0, meta.token1) : row.poolId;
  const directionLabel = directionText(row, meta);
  return (
    <tr className="border-b border-slate-800/40 last:border-b-0">
      <td className="py-2 pr-3 text-slate-300">
        <span className="inline-flex items-center gap-1.5">
          {network && <ChainIcon network={network} />}
          <span>{label}</span>
        </span>
      </td>
      <td className="px-3 py-2 text-slate-300">{directionLabel}</td>
      <td className="px-3 py-2 text-right font-mono text-slate-300">
        {formatUSD(weiToUsd(row.netPressureUsdWei))}
      </td>
      <td className="py-2 pl-3 text-right">
        <LpFriendlinessBadge value={row.lpFriendliness} />
      </td>
    </tr>
  );
}

function OutlierTableRow({
  row,
  pools,
}: {
  row: SwapOutlierRow;
  pools: PoolMeta;
}) {
  const network = networkForChainId(row.chainId);
  const meta = pools.get(row.poolId.toLowerCase());
  const label =
    network && meta ? poolName(network, meta.token0, meta.token1) : row.poolId;
  const txUrl = network ? explorerTxUrl(network, row.txHash) : null;
  return (
    <tr className="border-b border-slate-800/40 last:border-b-0">
      <td className="w-[42%] max-w-0 min-w-0 overflow-hidden py-2 pr-3 text-slate-300 whitespace-nowrap">
        <AddressLink
          address={row.caller}
          chainId={row.chainId}
          readOnly
          addressBookWhenAuthenticated
          containerClassName="w-full min-w-0 overflow-hidden whitespace-nowrap"
          className="block min-w-0 max-w-full truncate whitespace-nowrap"
        />
      </td>
      <td className="w-[34%] max-w-0 min-w-0 overflow-hidden px-3 py-2 text-slate-300">
        <span className="block truncate" title={label}>
          {label}
        </span>
      </td>
      <td className="w-[24%] max-w-0 min-w-0 overflow-hidden py-2 pl-3 text-right font-mono text-slate-300">
        <OutlierVolumeLink
          value={row.volumeUsdWei}
          txUrl={txUrl}
          txHash={row.txHash}
          blockTimestamp={row.blockTimestamp}
        />
      </td>
    </tr>
  );
}

function directionText(
  row: CorridorRow,
  meta: { token0: string | null; token1: string | null } | undefined,
): string {
  const network = networkForChainId(row.chainId);
  if (!network || !meta)
    return row.direction === 0 ? "Into token0" : "Into token1";
  const symbols = network.tokenSymbols;
  const token =
    row.direction === 0
      ? symbols[(meta.token0 ?? "").toLowerCase()]
      : symbols[(meta.token1 ?? "").toLowerCase()];
  return token
    ? `Into ${token}`
    : row.direction === 0
      ? "Into token0"
      : "Into token1";
}

function OutlierVolumeLink({
  value,
  txUrl,
  txHash,
  blockTimestamp,
}: {
  value: string;
  txUrl: string | null;
  txHash: string;
  blockTimestamp: string;
}) {
  const label = outlierVolumeLabel(value);
  if (!label) return <span className="text-slate-500">—</span>;
  if (!txUrl) {
    return <span className="inline-block max-w-full truncate">{label}</span>;
  }

  return (
    <a
      href={txUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} · ${txHash} · ${relativeTime(blockTimestamp)}`}
      aria-label={`View transaction ${shortTxHash(txHash)} for outlier swap volume ${label}`}
      className="inline-block max-w-full truncate whitespace-nowrap text-indigo-300 hover:text-indigo-200"
    >
      {label}
    </a>
  );
}

function outlierVolumeLabel(value: string): string | null {
  const parsed = parseUsdWei(value);
  return parsed === null ? null : formatUSD(weiToUsd(parsed));
}

function shortTxHash(txHash: string): string {
  return `${txHash.slice(0, 6)}…${txHash.slice(-4)}`;
}
