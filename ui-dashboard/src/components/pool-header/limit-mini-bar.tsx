"use client";

import { pressureColorClass } from "@/lib/health";

export type WindowSummary = {
  pressure: number;
  /** Absolute netflow — direction isn't meaningful for "how close to the cap". */
  netflow: number;
  limit: number;
};

/** Compact form: 12K, 3.4M, 500. Omits decimals for values < 1000. */
export function formatShort(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 999_950) {
    return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return value.toFixed(0);
}

/** `netflow/limit` for one window, or an em-dash when the window is absent. */
export function formatPair(summary: WindowSummary | null): string {
  return summary
    ? `${formatShort(summary.netflow)}/${formatShort(summary.limit)}`
    : "—";
}

export function MiniBar({
  summary,
  title,
}: {
  summary: WindowSummary | null;
  title: string;
}) {
  const pct = summary ? Math.min(summary.pressure * 100, 100) : 0;
  const color = summary ? pressureColorClass(summary.pressure) : "bg-slate-600";
  const rawPct = summary ? Math.round(summary.pressure * 100) : 0;
  // aria-valuenow must stay within [valuemin, valuemax] to be a valid ARIA
  // progressbar, so the raw (uncapped) percentage goes into aria-valuetext
  // with an explicit "over limit" suffix when breached — SRs still hear the
  // overage magnitude, just through the valid-state channel.
  const valueText = summary
    ? summary.pressure > 1
      ? `${rawPct}% (over limit)`
      : `${rawPct}%`
    : "no data";
  return (
    <div className="h-2 rounded-full bg-slate-700" title={title}>
      <div
        className={`h-2 rounded-full transition-all ${color}`}
        style={{ width: `${pct}%` }}
        role="progressbar"
        aria-label={title}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText}
      />
    </div>
  );
}
