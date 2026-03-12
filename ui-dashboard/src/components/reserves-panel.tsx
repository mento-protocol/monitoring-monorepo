"use client";

import type { Pool } from "@/lib/types";
import { parseWei, formatWei, formatUSD } from "@/lib/format";
import { tokenSymbol, poolTvlUSD, USDM_SYMBOLS } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

interface ReservesPanelProps {
  pool: Pool;
}

export function ReservesPanel({ pool }: ReservesPanelProps) {
  const { network } = useNetwork();
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);

  // null/undefined → null (not yet indexed); "0" → 0 (valid empty reserve)
  const r0 =
    pool.reserves0 != null
      ? parseWei(pool.reserves0, pool.token0Decimals ?? 18)
      : null;
  const r1 =
    pool.reserves1 != null
      ? parseWei(pool.reserves1, pool.token1Decimals ?? 18)
      : null;

  const hasReserves = r0 !== null && r1 !== null;

  // Per-token USD values — mirrors poolTvlUSD() logic for which side is the price leg.
  const feedVal =
    pool.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 1e24
      : null;
  const usdm0 = USDM_SYMBOLS.has(sym0);
  const usdm1 = USDM_SYMBOLS.has(sym1);
  const usd0 =
    feedVal !== null && r0 !== null
      ? usdm0
        ? r0
        : usdm1
          ? r0 * feedVal
          : null
      : null;
  const usd1 =
    feedVal !== null && r1 !== null
      ? usdm1
        ? r1
        : usdm0
          ? r1 * feedVal
          : null
      : null;

  // Prefer USD-normalized fill percentages to avoid unit mismatch on non-parity pairs.
  // Example: a balanced KESm/USDm pool has ~130:1 raw count ratio but 50/50 USD value.
  // Falls back to raw token count when oracle price is unavailable.
  const usdTotal = usd0 !== null && usd1 !== null ? usd0 + usd1 : null;
  const rawTotal = hasReserves ? r0! + r1! : 0;
  const pct0 =
    usdTotal !== null && usdTotal > 0
      ? (usd0! / usdTotal) * 100
      : rawTotal > 0
        ? (r0! / rawTotal) * 100
        : 0; // both reserves are zero — empty tanks show 0%
  const pct1 = 100 - pct0;

  // Dominant side (≥50%) gets indigo, recessive gets emerald — consistent visual signal.
  const color0 = pct0 >= 50 ? "bg-indigo-500" : "bg-emerald-500";
  const color1 = pct1 > 50 ? "bg-indigo-500" : "bg-emerald-500";

  // Reuse the shared TVL helper — it has tests and handles all edge cases.
  const totalUsdRaw = poolTvlUSD(pool, network);
  const totalUsd = totalUsdRaw > 0 ? totalUsdRaw : null;

  // Critical threshold lines.
  //
  // When using USD-normalized pct, the equilibrium is always 50/50 (each side has
  // equal USD value in a balanced pool). The critical fill% at priceDifference =
  // rebalanceThreshold simplifies to:
  //   x = (1 ± T) / (2 ± T)   where T = rebalanceThreshold / 10000
  //
  // Derivation: at critical (FPMM constant product), r0/r1 deviates by T from oracle.
  //   usd0/usd1 = (r0 * priceInUSD) / (r1 * priceInUSD) = r0/r1 / P_pool = 1 ± T
  //   → x_usd = (1 ± T) / (2 ± T). Oracle price cancels out entirely.
  //
  // Lines are only shown when using USD-normalized pct (usdTotal != null).
  const T =
    pool.rebalanceThreshold && pool.rebalanceThreshold > 0
      ? pool.rebalanceThreshold / 10000
      : null;

  let threshold0Lower: number | null = null;
  let threshold0Upper: number | null = null;
  if (T !== null && usdTotal !== null && T < 1) {
    threshold0Upper = ((1 + T) / (2 + T)) * 100;
    threshold0Lower = ((1 - T) / (2 - T)) * 100;
  }
  // Tank1 thresholds are the complements of tank0's (pct1 = 100 − pct0).
  const threshold1Lower =
    threshold0Upper !== null ? 100 - threshold0Upper : null;
  const threshold1Upper =
    threshold0Lower !== null ? 100 - threshold0Lower : null;

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
        <div className="flex gap-4 flex-1 min-h-[200px]">
          <Tank
            symbol={sym0}
            amount={formatWei(pool.reserves0!, pool.token0Decimals ?? 18, 2)}
            pct={pct0}
            usd={usd0}
            colorClass={color0}
            thresholdLower={threshold0Lower ?? undefined}
            thresholdUpper={threshold0Upper ?? undefined}
          />
          <Tank
            symbol={sym1}
            amount={formatWei(pool.reserves1!, pool.token1Decimals ?? 18, 2)}
            pct={pct1}
            usd={usd1}
            colorClass={color1}
            thresholdLower={threshold1Lower ?? undefined}
            thresholdUpper={threshold1Upper ?? undefined}
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
  thresholdLower?: number;
  thresholdUpper?: number;
}

function Tank({
  symbol,
  amount,
  pct,
  usd,
  colorClass,
  thresholdLower,
  thresholdUpper,
}: TankProps) {
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
        {/* Safe-zone band between the two critical threshold lines */}
        {thresholdLower !== undefined && thresholdUpper !== undefined && (
          <div
            className="absolute w-full bg-amber-400/5 pointer-events-none"
            style={{
              bottom: `${thresholdLower}%`,
              height: `${thresholdUpper - thresholdLower}%`,
            }}
          />
        )}
        {/* Lower critical threshold line */}
        {thresholdLower !== undefined && (
          <div
            className="absolute w-full border-t-2 border-dashed border-amber-400/60 pointer-events-none"
            style={{ bottom: `${thresholdLower}%` }}
            title={`Rebalance threshold lower (${thresholdLower.toFixed(1)}%)`}
          />
        )}
        {/* Upper critical threshold line */}
        {thresholdUpper !== undefined && (
          <div
            className="absolute w-full border-t-2 border-dashed border-amber-400/60 pointer-events-none"
            style={{ bottom: `${thresholdUpper}%` }}
            title={`Rebalance threshold upper (${thresholdUpper.toFixed(1)}%)`}
          />
        )}
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
