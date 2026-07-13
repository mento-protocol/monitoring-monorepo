import type { ReactNode } from "react";
import { AddressLink } from "@/components/address-link";
import { ChainIcon } from "@/components/chain-icon";
import { formatUSD, relativeTime } from "@/lib/format";
import {
  weiToUsd,
  type TraderWindowRow,
  type VolumeRangeKey,
} from "@/lib/volume";
import {
  parseUsdWei,
  type CorridorRow,
  type SwapOutlierRow,
  type TraderCohortSummary,
} from "@/lib/volume-insights";
import { networkForChainId } from "@/lib/networks";
import { explorerTxUrl, poolName } from "@/lib/tokens";
import type { PoolMeta } from "../_lib/types";
import { LpFriendlinessBadge } from "./lp-friendliness-badge";

export function CohortPanel({
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
        <CohortPanelSkeleton />
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

export function CorridorPanel({
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
        <InsightTableSkeleton cols={4} label="Loading corridor map" />
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

export function OutlierPanel({
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
        <InsightTableSkeleton cols={3} label="Loading outlier swaps" />
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

// Mirrors CohortPanel's loaded shape (3-stat mini grid + 3 leader rows +
// caption line) so the section doesn't grow when the query resolves — the
// old `<Skeleton rows={4} />` (4 generic 40px bars) undershot the real
// content by roughly half.
function CohortPanelSkeleton() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-label="Loading cohort comparison"
    >
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`cohort-skel-stat-${i}`} className="min-w-0">
            <div className="h-[11px] w-10 animate-pulse rounded bg-slate-800/50" />
            <div className="mt-1 h-[18px] w-8 animate-pulse rounded bg-slate-800/50" />
          </div>
        ))}
      </div>
      <div className="space-y-2 text-xs">
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`cohort-skel-leader-${i}`}
            className="flex items-center justify-between gap-3"
          >
            <div className="h-3 w-16 animate-pulse rounded bg-slate-800/40" />
            <div className="h-3 w-28 animate-pulse rounded bg-slate-800/40" />
          </div>
        ))}
      </div>
      <div className="h-[11px] w-40 animate-pulse rounded bg-slate-800/40" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

// Corridor/outlier queries cap at 10 rows (`INSIGHT_ROW_LIMIT` in
// `v3-flow-insights.tsx`), and that cap is the common case in production —
// both tables are usually query-capped (`isPartial`), which also renders a
// trailing "Top-query subset…" caption below the table. `INSIGHT_PANEL_SKELETON_ROWS`
// mirrors the cap so the skeleton doesn't undershoot the loaded table on the
// (common) capped path. The row rhythm (`py-3` + `h-3`, 36px) matches the
// measured real row height (~36-37px) so an uncapped result (fewer than 10
// rows, no trailing warning line) doesn't overshoot the loaded panel either —
// real rows are denser than the shared `TableSkeleton`'s 36px/44px
// main-table geometry, so this stays a local skeleton rather than reusing
// that primitive.
//
// A live measurement (2026-07-13, 1440x900, production build/data) with the
// row rhythm above already in place still showed the flow-insights section
// growing 496px -> 542px (+46px) between the SWR-loading and loaded phases,
// isolating the remaining gap to that trailing caption paragraph
// (`pt-2 text-[11px]`), which this skeleton didn't reserve at all. Its
// column (~421px wide inside the xl:grid-cols-3 layout, minus the panel's
// p-4 padding) is narrow relative to the longer outlier caption text
// ("Top-query subset; eligible outliers beyond the fetch cap may be
// absent.", ~68 chars), so it can wrap to 2 lines. The reserved placeholder
// below always renders 2 lines (`mt-2` + 2x `h-3` + `space-y-1` =
// 8 + 12 + 4 + 12 = 36px): 496 + 36 = 532, a 10px gap against the measured
// 542px loaded height (within the ±24px parity bar), with margin on both
// sides for measurement noise.
const INSIGHT_PANEL_SKELETON_ROWS = 10;

function InsightTableSkeleton({
  cols,
  label,
}: {
  cols: number;
  label: string;
}) {
  return (
    <div role="status" aria-label={label}>
      <div className="flex gap-3 border-b border-slate-800 py-2.5">
        {Array.from({ length: cols }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`insight-skel-th-${i}`}
            className="h-3 flex-1 animate-pulse rounded bg-slate-800/50"
          />
        ))}
      </div>
      <div className="divide-y divide-slate-800/40">
        {Array.from({ length: INSIGHT_PANEL_SKELETON_ROWS }, (_, rowIdx) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`insight-skel-row-${rowIdx}`} className="flex gap-3 py-3">
            {Array.from({ length: cols }, (_, colIdx) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key
              <div
                key={`insight-skel-cell-${rowIdx}-${colIdx}`}
                className="h-3 flex-1 animate-pulse rounded bg-slate-800/40"
              />
            ))}
          </div>
        ))}
      </div>
      {/* Reserves the trailing "Top-query subset…" caption both panels
          render when isPartial && rows.length > 0 — the common capped case
          (see INSIGHT_PANEL_SKELETON_ROWS above), reserved unconditionally
          since this skeleton has no isPartial input of its own. */}
      <div className="mt-2 space-y-1">
        <div className="h-3 w-full animate-pulse rounded bg-slate-800/40" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-slate-800/40" />
      </div>
      <span className="sr-only">Loading…</span>
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
      role={
        variant === "error"
          ? "alert"
          : variant === "warn"
            ? "status"
            : undefined
      }
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
