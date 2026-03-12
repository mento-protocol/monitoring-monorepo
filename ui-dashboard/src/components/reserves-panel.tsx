"use client";

import type { Pool } from "@/lib/types";
import { parseWei, formatWei, formatUSD } from "@/lib/format";
import { tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

interface ReservesPanelProps {
  pool: Pool;
}

export function ReservesPanel({ pool }: ReservesPanelProps) {
  const { network } = useNetwork();
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);

  const r0 =
    pool.reserves0 && pool.reserves0 !== "0"
      ? parseWei(pool.reserves0, pool.token0Decimals ?? 18)
      : null;
  const r1 =
    pool.reserves1 && pool.reserves1 !== "0"
      ? parseWei(pool.reserves1, pool.token1Decimals ?? 18)
      : null;

  const hasReserves = r0 !== null && r1 !== null;
  const total = hasReserves ? r0 + r1 : 0;
  const pct0 = total > 0 ? (r0! / total) * 100 : 50;
  const pct1 = total > 0 ? (r1! / total) * 100 : 50;

  // Dominant side (≥50%) gets indigo, recessive gets emerald — consistent visual signal.
  const color0 = pct0 >= 50 ? "bg-indigo-500" : "bg-emerald-500";
  const color1 = pct1 > 50 ? "bg-indigo-500" : "bg-emerald-500";

  const feedVal =
    pool.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 1e24
      : null;
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const usd0 =
    feedVal !== null && r0 !== null ? (usdmIsToken0 ? r0 : r0 * feedVal) : null;
  const usd1 =
    feedVal !== null && r1 !== null ? (usdmIsToken0 ? r1 * feedVal : r1) : null;
  const totalUsd = usd0 !== null && usd1 !== null ? usd0 + usd1 : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <h2 className="text-base font-semibold text-white">Reserves</h2>
        {totalUsd !== null && (
          <span className="text-sm text-slate-400">
            TVL{" "}
            <span className="text-slate-200 font-mono">
              {formatUSD(totalUsd)}
            </span>
          </span>
        )}
      </div>

      {!hasReserves ? (
        <p className="text-sm text-slate-400">No reserve data available yet.</p>
      ) : (
        <div className="flex gap-4 flex-1 min-h-0">
          <Tank
            symbol={sym0}
            amount={formatWei(pool.reserves0!, pool.token0Decimals ?? 18, 2)}
            pct={pct0}
            usd={usd0}
            colorClass={color0}
          />
          <Tank
            symbol={sym1}
            amount={formatWei(pool.reserves1!, pool.token1Decimals ?? 18, 2)}
            pct={pct1}
            usd={usd1}
            colorClass={color1}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface TankProps {
  symbol: string;
  amount: string;
  pct: number;
  usd: number | null;
  colorClass: string;
}

function Tank({ symbol, amount, pct, usd, colorClass }: TankProps) {
  return (
    <div className="flex flex-col items-center gap-2 flex-1 min-w-0 min-h-0">
      <div
        className="relative w-full flex-1 min-h-0 rounded border border-slate-700 bg-slate-800/80 overflow-hidden flex flex-col-reverse"
        role="meter"
        aria-valuemin={0}
        aria-valuenow={pct}
        aria-valuemax={100}
        aria-label={`${symbol} reserve: ${pct.toFixed(1)}%`}
      >
        <div
          className={`w-full transition-all duration-500 ${colorClass} opacity-70`}
          style={{ height: `${pct}%` }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-xl font-bold text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.8)]">
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="text-center flex-shrink-0">
        <div className="text-sm font-medium text-slate-200">{symbol}</div>
        <div className="text-xs font-mono text-slate-400 mt-0.5">{amount}</div>
        {usd !== null && (
          <div className="text-xs text-slate-500 mt-0.5">
            ≈ {formatUSD(usd)}
          </div>
        )}
      </div>
    </div>
  );
}
