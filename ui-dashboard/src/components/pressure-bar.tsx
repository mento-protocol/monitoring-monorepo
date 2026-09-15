"use client";

import { Tooltip } from "@/components/tooltip";
import { pressureColorClass } from "@/lib/health";

export interface PressureBarProps {
  /** Indexer-computed ratio of |netflow| to the window limit. */
  pressure: string;
  label: string;
  /** Signed raw netflow. The sign is rendered separately from the amount. */
  netflow: string;
  limit: string;
  /** Renders one raw unsigned amount. FPMM rows are 15-decimal internal units;
   * Broker rows are whole token units, so each caller brings its own scale. */
  formatValue: (raw: string) => string;
  /** Token symbol for screen-reader context — avoids repeating unnamed
   * "5-minute limit (L0)" / "Daily limit (L1)" bars on two-token pools. */
  tokenSymbol: string;
  /** Optional explanation of the window, shown as an info tooltip. */
  hint?: string | undefined;
}

/** One trading-limit window as a labelled bar. Window periods come from the
 * on-chain config — the FPMM contract fixes L0 at 5 minutes and L1 at 24 hours,
 * the v2 Broker configures both per exchange — so callers pass the label. */
export function PressureBar({
  pressure,
  label,
  netflow,
  limit,
  formatValue,
  tokenSymbol,
  hint,
}: PressureBarProps) {
  const ratio = Number(pressure);
  const pct = Math.min(ratio * 100, 100);
  const displayPct = (ratio * 100).toFixed(1);
  const color = pressureColorClass(ratio);

  const netflowHuman = formatValue(netflow.replace(/^-/, ""));
  const limitHuman = formatValue(limit);
  const sign = netflow.startsWith("-") ? "-" : "+";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-sm text-slate-200">
          {label}
          {hint ? <Tooltip label={label} content={hint} /> : null}
        </span>
        <span className="text-sm text-slate-200 font-mono">{displayPct}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-700">
        <div
          className={`h-2 rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-label={`${label} for ${tokenSymbol}`}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={
            ratio > 1 ? `${displayPct}% (over limit)` : `${displayPct}%`
          }
        />
      </div>
      <div className="text-xs text-slate-400">
        Netflow: {sign}
        {netflowHuman} / Limit: {limitHuman}
      </div>
    </div>
  );
}
