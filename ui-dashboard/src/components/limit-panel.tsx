"use client";

import type { Pool, TradingLimit } from "@/lib/types";
import { LimitBadge } from "@/components/badges";
import { computeLimitStatus } from "@/lib/health";
import { tokenSymbol } from "@/lib/tokens";
import { formatWei, TRADING_LIMITS_INTERNAL_DECIMALS } from "@/lib/format";
import { useNetwork } from "@/components/network-provider";

interface PressureBarProps {
  pressure: string;
  label: string;
  netflow: string;
  limit: string;
  decimals: number;
}

/** L0 = 5-minute rolling window, L1 = 24-hour rolling window (hardcoded in TradingLimitsV2.sol).
 * Both track absolute netflow of the given token against a configured ceiling. */
function PressureBar({
  pressure,
  label,
  netflow,
  limit,
  decimals,
}: PressureBarProps) {
  const ratio = Number(pressure);
  const pct = Math.min(ratio * 100, 100);
  const displayPct = (ratio * 100).toFixed(1);
  const color =
    ratio >= 1.0
      ? "bg-red-500"
      : ratio >= 0.8
        ? "bg-amber-500"
        : "bg-emerald-500";

  const netflowHuman = formatWei(netflow.replace(/^-/, ""), decimals, 2);
  const limitHuman = formatWei(limit, decimals, 2);
  const sign = netflow.startsWith("-") ? "-" : "+";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-200">{label}</span>
        <span className="text-sm text-slate-200 font-mono">{displayPct}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-700">
        <div
          className={`h-2 rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={ratio * 100}
          aria-valuemax={100}
        />
      </div>
      <div className="text-xs text-slate-400">
        Netflow: {sign}
        {netflowHuman} / Limit: {limitHuman}
      </div>
    </div>
  );
}

interface LimitPanelProps {
  pool: Pool;
  tradingLimits: TradingLimit[];
}

export function LimitPanel({ pool, tradingLimits }: LimitPanelProps) {
  const { network } = useNetwork();
  const isVirtual = pool.source?.includes("virtual");
  const status = isVirtual ? "N/A" : computeLimitStatus(pool);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">Trading Limits</h2>
        <LimitBadge status={status} />
      </div>

      {isVirtual ? (
        <p className="text-sm text-slate-400">
          VirtualPool — trading limits not applicable.
        </p>
      ) : tradingLimits.length === 0 ? (
        <p className="text-sm text-slate-400">
          No trading limit data available yet.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {tradingLimits.map((tl) => {
            const sym = tokenSymbol(network, tl.token);
            return (
              <div key={tl.id} className="flex flex-col gap-3">
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {sym}
                </div>
                <PressureBar
                  pressure={tl.limitPressure0}
                  label="5-minute limit (L0)"
                  netflow={tl.netflow0}
                  limit={tl.limit0}
                  decimals={TRADING_LIMITS_INTERNAL_DECIMALS}
                />
                <PressureBar
                  pressure={tl.limitPressure1}
                  label="Daily limit (L1)"
                  netflow={tl.netflow1}
                  limit={tl.limit1}
                  decimals={TRADING_LIMITS_INTERNAL_DECIMALS}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
