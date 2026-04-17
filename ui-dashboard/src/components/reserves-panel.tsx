"use client";

import type { Pool } from "@/lib/types";
import { parseWei, formatWei, formatUSD } from "@/lib/format";
import { computeReservePcts, computeThresholdLines } from "@/lib/reserves";
import {
  canPricePool,
  tokenSymbol,
  tokenToUSD,
  USDM_SYMBOLS,
  type OracleRateMap,
} from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

interface ReservesPanelProps {
  pool: Pool;
  rates?: OracleRateMap;
}

export function ReservesPanel({ pool, rates }: ReservesPanelProps) {
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
  // Both reserves indexed as "0" — pool exists but has no liquidity yet.
  // Prevents token1 tank from rendering as 100% full on a fully empty pool.
  const isEmptyPool = hasReserves && r0 === 0 && r1 === 0;

  const feedVal =
    pool.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 1e24
      : null;
  const usdm0 = USDM_SYMBOLS.has(sym0);
  const usdm1 = USDM_SYMBOLS.has(sym1);
  const fxRate0 = rates ? tokenToUSD(sym0, 1, rates) : null;
  const fxRate1 = rates ? tokenToUSD(sym1, 1, rates) : null;
  const usd0 =
    feedVal !== null && r0 !== null
      ? usdm0
        ? r0
        : usdm1
          ? r0 * feedVal
          : fxRate0 !== null
            ? r0 * fxRate0
            : fxRate1 !== null
              ? r0 * feedVal * fxRate1
              : null
      : null;
  const usd1 =
    feedVal !== null && r1 !== null
      ? usdm1
        ? r1
        : usdm0
          ? r1 * feedVal
          : fxRate1 !== null
            ? r1 * fxRate1
            : fxRate0 !== null
              ? r1 * feedVal * fxRate0
              : null
      : null;

  const usdTotal = usd0 !== null && usd1 !== null ? usd0 + usd1 : null;
  const { pct0, pct1 } = computeReservePcts(r0, r1, usd0, usd1);

  const color0 = pct0 >= 50 ? "bg-indigo-500" : "bg-emerald-500";
  const color1 = pct1 > 50 ? "bg-indigo-500" : "bg-emerald-500";

  const thresholds = computeThresholdLines(pool.rebalanceThreshold, usdTotal);
  // For non-USDm pairs without a loaded rate map, computeReservePcts would
  // fall back to a raw-token split (economically wrong for FX/FX pools
  // where a balanced USD value implies an unbalanced raw-unit ratio). Gate
  // tank rendering on USD-priceable so we never show a confident-looking
  // percentage that's silently wrong.
  const priceable = canPricePool(pool, network, rates ?? new Map());
  const showTanks = hasReserves && !isEmptyPool && priceable;
  const showThresholdLegend = showTanks && thresholds !== null;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6 h-full flex flex-col">
      <div className="mb-4 flex-shrink-0 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-400">Reserves</p>
        {showThresholdLegend && (
          <div className="flex items-center gap-1.5">
            <span
              className="w-5 border-t-2 border-dashed border-amber-400/60 flex-shrink-0"
              aria-hidden="true"
            />
            <span
              id="reserves-threshold-legend"
              className="text-xs text-slate-500"
            >
              Rebalance threshold
            </span>
          </div>
        )}
      </div>

      {!hasReserves ? (
        <p className="text-sm text-slate-400">No reserve data available yet.</p>
      ) : isEmptyPool ? (
        <p className="text-sm text-slate-400">Pool has no reserves yet.</p>
      ) : !priceable ? (
        <p className="text-sm text-slate-400">
          Reserves pricing unavailable for this pair.
        </p>
      ) : (
        <div className="flex gap-4 flex-1 min-h-[200px]">
          <Tank
            symbol={sym0}
            amount={formatWei(pool.reserves0!, pool.token0Decimals ?? 18, 2)}
            pct={pct0}
            usd={usd0}
            colorClass={color0}
            thresholdLower={thresholds?.threshold0Lower}
            thresholdUpper={thresholds?.threshold0Upper}
            thresholdLegendId={
              thresholds ? "reserves-threshold-legend" : undefined
            }
          />
          <Tank
            symbol={sym1}
            amount={formatWei(pool.reserves1!, pool.token1Decimals ?? 18, 2)}
            pct={pct1}
            usd={usd1}
            colorClass={color1}
            thresholdLower={thresholds?.threshold1Lower}
            thresholdUpper={thresholds?.threshold1Upper}
            thresholdLegendId={
              thresholds ? "reserves-threshold-legend" : undefined
            }
          />
        </div>
      )}
    </section>
  );
}

interface TankProps {
  symbol: string;
  amount: string;
  pct: number;
  usd: number | null;
  colorClass: string;
  thresholdLower?: number;
  thresholdUpper?: number;
  thresholdLegendId?: string;
}

function gradientFor(colorClass: string): string {
  if (colorClass === "bg-indigo-500") return "from-indigo-600 to-indigo-400";
  if (colorClass === "bg-emerald-500") return "from-emerald-600 to-emerald-400";
  return "from-slate-600 to-slate-500";
}

function Tank({
  symbol,
  amount,
  pct,
  usd,
  colorClass,
  thresholdLower,
  thresholdUpper,
  thresholdLegendId,
}: TankProps) {
  return (
    <div className="flex flex-col items-center gap-2 flex-1 min-w-0 min-h-0">
      <div
        className="relative w-full flex-1 min-h-0 rounded-xl border border-slate-700/60 bg-slate-800/80 overflow-hidden flex flex-col-reverse shadow-md shadow-black/40"
        role="meter"
        aria-valuemin={0}
        aria-valuenow={pct}
        aria-valuemax={100}
        aria-label={`${symbol} reserve: ${pct.toFixed(1)}%`}
        aria-describedby={thresholdLegendId}
      >
        <div className="absolute inset-0 rounded-xl pointer-events-none ring-1 ring-inset ring-white/5" />

        <div
          className={`w-full relative transition-all duration-500 bg-gradient-to-t ${gradientFor(colorClass)} opacity-90`}
          style={{ height: `${pct}%` }}
        >
          <div className="absolute inset-x-0 top-0 h-px bg-white/40" />
          <div className="absolute inset-x-0 top-px h-2 bg-gradient-to-b from-white/15 to-transparent" />
        </div>

        {thresholdLower !== undefined && thresholdUpper !== undefined && (
          <div
            className="absolute w-full bg-amber-400/5 pointer-events-none"
            style={{
              bottom: `${thresholdLower}%`,
              height: `${thresholdUpper - thresholdLower}%`,
            }}
          />
        )}
        {thresholdLower !== undefined && (
          <div
            className="absolute w-full border-t border-dashed border-amber-400/70 pointer-events-none"
            style={{ bottom: `${thresholdLower}%` }}
            title={`Rebalance threshold lower (${thresholdLower.toFixed(1)}%)`}
          />
        )}
        {thresholdUpper !== undefined && (
          <div
            className="absolute w-full border-t border-dashed border-amber-400/70 pointer-events-none"
            style={{ bottom: `${thresholdUpper}%` }}
            title={`Rebalance threshold upper (${thresholdUpper.toFixed(1)}%)`}
          />
        )}
        <span className="absolute inset-0 flex items-center justify-center text-xl font-semibold text-white [text-shadow:0_2px_4px_rgba(0,0,0,0.85)]">
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="text-center flex-shrink-0">
        <div className="text-sm font-medium text-slate-200">{symbol}</div>
        <div className="text-xs font-mono text-slate-400 mt-0.5">
          {amount}
          {usd !== null && (
            <span className="text-slate-500"> ≈ {formatUSD(usd)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
