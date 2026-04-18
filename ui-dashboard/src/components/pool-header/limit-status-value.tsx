"use client";

import type { Pool, TradingLimit } from "@/lib/types";
import { parseWei, TRADING_LIMITS_INTERNAL_DECIMALS } from "@/lib/format";
import { pressureColorClass } from "@/lib/health";

type WindowSummary = {
  pressure: number;
  netflow: number;
  limit: number;
};

/** Picks the highest-pressure token in the window so the mini-bar surfaces the tightest constraint. Netflow is absolute — direction isn't meaningful for "how close to the cap". */
function summarizeWindow(
  tradingLimits: TradingLimit[],
  window: "0" | "1",
): WindowSummary | null {
  if (tradingLimits.length === 0) return null;
  let best: WindowSummary | null = null;
  for (const tl of tradingLimits) {
    const pressure = Number(
      (window === "0" ? tl.limitPressure0 : tl.limitPressure1) ?? "0",
    );
    if (best !== null && pressure <= best.pressure) continue;
    const netflowRaw = (window === "0" ? tl.netflow0 : tl.netflow1) ?? "0";
    const limitRaw = (window === "0" ? tl.limit0 : tl.limit1) ?? "0";
    const netflow = Math.abs(
      parseWei(netflowRaw, TRADING_LIMITS_INTERNAL_DECIMALS),
    );
    const limit = parseWei(limitRaw, TRADING_LIMITS_INTERNAL_DECIMALS);
    best = { pressure, netflow, limit };
  }
  return best;
}

/** Compact form: 12K, 3.4M, 500. Omits decimals for values < 1000. */
function formatShort(value: number): string {
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

function MiniBar({
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

export function LimitStatusValue({
  pool,
  tradingLimits,
  hasError = false,
}: {
  pool: Pool;
  tradingLimits: TradingLimit[];
  hasError?: boolean;
}) {
  const isVirtual = pool.source?.includes("virtual");
  if (isVirtual) return <span className="text-slate-500">—</span>;

  // An actual fetch failure leaves `tradingLimits` as `[]`, which would
  // otherwise render the same neutral em-dash as virtual pools and as
  // pools with no trading-limit rows yet. Surface the failure explicitly
  // to match what the Limits tab already shows.
  if (hasError) {
    return <span className="text-xs text-amber-400">Query failed</span>;
  }

  const l0 = summarizeWindow(tradingLimits, "0");
  const l1 = summarizeWindow(tradingLimits, "1");

  if (!l0 && !l1) {
    return <span className="text-slate-500">—</span>;
  }

  const formatPair = (s: WindowSummary | null) =>
    s ? `${formatShort(s.netflow)}/${formatShort(s.limit)}` : "—";

  return (
    <span className="flex flex-col gap-0.5 w-52">
      <span className="grid grid-cols-2 gap-2 h-5 items-center">
        <MiniBar summary={l0} title="5-minute limit (L0)" />
        <MiniBar summary={l1} title="Daily limit (L1)" />
      </span>
      <span className="grid grid-cols-2 gap-2 text-xs text-slate-500 font-mono">
        <span title="5-minute netflow / limit">
          <span className="text-slate-600">5m </span>
          {formatPair(l0)}
        </span>
        <span title="Daily netflow / limit">
          <span className="text-slate-600">1d </span>
          {formatPair(l1)}
        </span>
      </span>
    </span>
  );
}
