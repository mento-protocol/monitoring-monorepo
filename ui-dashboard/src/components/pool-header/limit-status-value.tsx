"use client";

import { isVirtualPool, type Pool, type TradingLimit } from "@/lib/types";
import { parseWei, TRADING_LIMITS_INTERNAL_DECIMALS } from "@/lib/format";
import {
  formatPair,
  MiniBar,
  type WindowSummary,
} from "@/components/pool-header/limit-mini-bar";

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

export function LimitStatusValue({
  pool,
  tradingLimits,
  hasError = false,
}: {
  pool: Pool;
  tradingLimits: TradingLimit[];
  hasError?: boolean;
}) {
  // VirtualPools have their own tile (`BrokerLimitStatusValue`) fed by the
  // wrapped v2 exchange's Broker limits; this FPMM tile never renders for one.
  if (isVirtualPool(pool)) return <span className="text-slate-500">—</span>;

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
