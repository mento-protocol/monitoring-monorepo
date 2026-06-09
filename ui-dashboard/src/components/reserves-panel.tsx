"use client";

import type { Pool } from "@/lib/types";
import { formatWei, formatUSD } from "@/lib/format";
import {
  computeReserveComposition,
  computeThresholdLines,
  type ReserveComposition,
} from "@/lib/reserves";
import { type OracleRateMap } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import { InfoPopover } from "@/components/info-popover";

interface ReservesPanelProps {
  pool: Pool;
  rates?: OracleRateMap;
  /**
   * True while the cross-pool rate-map query is still in flight. Lets the
   * panel show a loading state for pairs that need derived FX rates
   * instead of flashing the permanent "unavailable" copy on first render.
   */
  ratesLoading?: boolean;
  /**
   * True when the cross-pool rate-map query failed. Routes non-USDm pairs
   * through a transient "couldn't load" state instead of the permanent
   * "unavailable" copy — which would mislabel a backend hiccup as a
   * permanent pair-incompatibility.
   */
  ratesError?: boolean;
  /**
   * True while the isolated token-decimal trust query is still in flight.
   * Reserve amounts must not be parsed with fallback decimals during this
   * window, because a 6dp token scaled as 18dp is off by 1e12.
   */
  decimalsLoading?: boolean;
  /**
   * True when the isolated token-decimal trust query failed. The panel hides
   * token amounts until the query recovers instead of rendering fallback
   * decimal math.
   */
  decimalsError?: boolean;
}

type AvailableReserveComposition = Extract<
  ReserveComposition,
  { kind: "available" }
>;
type ReserveThresholds = NonNullable<ReturnType<typeof computeThresholdLines>>;

export function ReservesPanel({
  pool,
  rates,
  ratesLoading = false,
  ratesError = false,
  decimalsLoading = false,
  decimalsError = false,
}: ReservesPanelProps) {
  const { network } = useNetwork();
  const composition = computeReserveComposition(
    pool,
    network,
    rates ?? new Map(),
  );
  const availableComposition =
    composition.kind === "available" ? composition : null;
  const thresholds = availableComposition
    ? computeThresholdLines(
        pool.rebalanceThreshold,
        availableComposition.usdTotal,
      )
    : null;
  const showThresholdLegend = thresholds !== null;

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
            <InfoPopover
              label="About the rebalance threshold lines"
              content="Each tank shows the same two breach points from that token's point of view, so the dashed lines don't line up at the same height — drifting one token up moves the other token down by an unequal amount."
            />
          </div>
        )}
      </div>

      <ReservesPanelBody
        pool={pool}
        composition={composition}
        thresholds={thresholds}
        decimalsLoading={decimalsLoading}
        decimalsError={decimalsError}
        ratesLoading={ratesLoading}
        ratesError={ratesError}
      />
    </section>
  );
}

function ReservesPanelBody({
  pool,
  composition,
  thresholds,
  decimalsLoading,
  decimalsError,
  ratesLoading,
  ratesError,
}: {
  pool: Pool;
  composition: ReserveComposition;
  thresholds: ReserveThresholds | null;
  decimalsLoading: boolean;
  decimalsError: boolean;
  ratesLoading: boolean;
  ratesError: boolean;
}) {
  if (decimalsLoading) {
    return <p className="text-sm text-slate-400">Loading reserves…</p>;
  }
  if (decimalsError) {
    return (
      <p className="text-sm text-red-400">
        Couldn't load reserves — try again later.
      </p>
    );
  }
  if (composition.kind === "available") {
    return (
      <ReserveTanks
        pool={pool}
        composition={composition}
        thresholds={thresholds}
      />
    );
  }
  if (composition.kind === "untrusted-decimals") {
    return (
      <p className="text-sm text-slate-400">
        Reserves hidden until token decimals are verified.
      </p>
    );
  }
  if (composition.kind === "missing") {
    return (
      <p className="text-sm text-slate-400">No reserve data available yet.</p>
    );
  }
  if (composition.kind === "empty") {
    return <p className="text-sm text-slate-400">Pool has no reserves yet.</p>;
  }
  if (ratesLoading) {
    return <p className="text-sm text-slate-400">Loading reserves…</p>;
  }
  if (ratesError) {
    return (
      <p className="text-sm text-red-400">
        Couldn't load reserves — try again later.
      </p>
    );
  }
  return (
    <p className="text-sm text-slate-400">
      Reserves pricing unavailable for this pair.
    </p>
  );
}

function ReserveTanks({
  pool,
  composition,
  thresholds,
}: {
  pool: Pool;
  composition: AvailableReserveComposition;
  thresholds: ReserveThresholds | null;
}) {
  return (
    <div className="flex gap-4 flex-1 min-h-[200px]">
      <Tank
        symbol={composition.symbol0}
        amount={formatWei(pool.reserves0!, pool.token0Decimals ?? 18, 2)}
        pct={composition.pct0}
        usd={composition.usd0}
        colorClass={composition.pct0 >= 50 ? "bg-indigo-500" : "bg-emerald-500"}
        thresholdLower={thresholds?.threshold0Lower}
        thresholdUpper={thresholds?.threshold0Upper}
        thresholdLegendId={thresholds ? "reserves-threshold-legend" : undefined}
      />
      <Tank
        symbol={composition.symbol1}
        amount={formatWei(pool.reserves1!, pool.token1Decimals ?? 18, 2)}
        pct={composition.pct1}
        usd={composition.usd1}
        colorClass={composition.pct1 > 50 ? "bg-indigo-500" : "bg-emerald-500"}
        thresholdLower={thresholds?.threshold1Lower}
        thresholdUpper={thresholds?.threshold1Upper}
        thresholdLegendId={thresholds ? "reserves-threshold-legend" : undefined}
      />
    </div>
  );
}

interface TankProps {
  symbol: string;
  amount: string;
  pct: number;
  usd: number | null;
  colorClass: string;
  thresholdLower?: number | undefined;
  thresholdUpper?: number | undefined;
  thresholdLegendId?: string | undefined;
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
