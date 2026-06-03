"use client";

import type { ReactNode } from "react";
import { Skeleton, ErrorBox, EmptyBox } from "@/components/feedback";
import { formatUSD } from "@/lib/format";

export type TopPoolsListEntry = {
  /** Stable identifier — `${chainId}-${poolAddress}`. */
  poolId: string;
  /** Pool pair name (e.g. "USDC/USDm"), no chain suffix. */
  name: string;
  /** Optional chain badge / icon — rendered next to the name. */
  chainBadge?: ReactNode;
  /** Total USD volume in the selected window (display number). */
  totalUsd: number;
  /** Share of the window's total volume, in `[0, 1]`. */
  share: number;
  /** Color swatch — matches the chart's stack color for the same pool
   *  when this entry is in the chart's top-N; otherwise null (renders
   *  a muted swatch). */
  color: string | null;
};

const MUTED_SWATCH = "#475569"; // slate-600 — same as the chart's "Other"

/**
 * Numbered list of pools by total window volume, rendered alongside
 * the per-pool stacked chart. Top-N entries borrow the chart's stack
 * colors; entries beyond the chart's top-N (i.e. pools that fell into
 * the chart's "Other" bucket) get a muted swatch so the visual mapping
 * between chart and list stays unambiguous.
 */
export function TopPoolsList({
  entries,
  isLoading,
  hasError,
  windowLabel,
}: {
  entries: readonly TopPoolsListEntry[];
  isLoading: boolean;
  hasError: boolean;
  /** Short label for the section title — "1M" / "3M" / "All" etc. */
  windowLabel: string;
}) {
  return (
    <section className="h-full rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
        {/* Title styling matches the "Volume by pool" chart card title
            so the two tiles read as a pair (`text-sm text-slate-400`,
            no font-medium). */}
        <p className="text-sm text-slate-400">Top pools</p>
        {/* Window-label badge mirrors the active state of the chart's
            range pills (`bg-slate-700 text-white shadow-sm`). It's
            read-only — the chart's pills are the canonical control —
            but the matching visual language makes it unambiguous which
            range the list is summarising. */}
        <span
          aria-label={`Window: ${windowLabel}`}
          className="rounded bg-slate-700 px-3 py-1 text-xs font-medium text-white shadow-sm"
        >
          {windowLabel}
        </span>
      </div>
      {hasError ? (
        <ErrorBox message="Couldn't load pool ranking." />
      ) : isLoading ? (
        <Skeleton rows={10} />
      ) : entries.length === 0 ? (
        <EmptyBox message="No pool volume in this window." />
      ) : (
        <ol className="space-y-1.5">
          {entries.map((e, i) => (
            <li
              key={`${e.color ?? "none"}-${e.name}-${e.poolId}`}
              className="flex items-center gap-2 text-[13px] text-slate-200"
            >
              <span className="w-5 flex-shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-500">
                {i + 1}
              </span>
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 flex-shrink-0 rounded-sm"
                style={{ background: e.color ?? MUTED_SWATCH }}
              />
              <span className="truncate text-slate-300">{e.name}</span>
              {e.chainBadge && (
                <span className="inline-flex flex-shrink-0 items-center">
                  {e.chainBadge}
                </span>
              )}
              <span className="ml-auto font-mono tabular-nums">
                {formatUSD(e.totalUsd)}
              </span>
              <span className="w-10 flex-shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-500">
                {(e.share * 100).toFixed(1)}%
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
