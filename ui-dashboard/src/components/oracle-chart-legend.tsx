import { formatBaseline } from "./oracle-chart-hover";
import type {
  BreakerConfigForChart,
  BreakerConfigStatus,
} from "./oracle-chart";

// Legend for the oracle chart. Extracted from oracle-chart.tsx for the 1000-line
// cap. Takes the resolved `baseline` / `thresholdRatio` (floats) + `baselineLabel`
// as props — computed by OracleChart, which owns the breaker config — so this
// component needs no fixidity helpers (avoids a value-import cycle with
// oracle-chart.tsx; the BreakerConfig types are type-only imports).
export function OracleChartLegend({
  breachStartedAt,
  breakerConfig,
  breakerConfigStatus,
  hasPersistedBands,
  baseline,
  thresholdRatio,
  baselineLabel,
}: {
  breachStartedAt: string | null | undefined;
  breakerConfig: BreakerConfigForChart | null | undefined;
  breakerConfigStatus: BreakerConfigStatus;
  hasPersistedBands: boolean;
  baseline: number | null;
  thresholdRatio: number | null;
  baselineLabel: string;
}) {
  // When the current breaker isn't ready, the markers can be one of two
  // things: persisted per-snapshot verdicts (if any snapshot carries an
  // at-the-time band) OR genuinely-neutral (no current AND no persisted).
  // The legend copy must match what the markers actually display so an
  // operator never sees red/green markers next to "band check unavailable."
  if (breakerConfigStatus !== "ready" || !breakerConfig) {
    const loading = breakerConfigStatus === "loading";
    const msg = hasPersistedBands
      ? loading
        ? "Verdicts use each snapshot's at-the-time band; current breaker still loading"
        : "No active current breaker — verdicts use each snapshot's at-the-time persisted band only"
      : loading
        ? "Loading current breaker config…"
        : "No active breaker for this rate feed — band check unavailable";
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[10px] sm:text-xs text-slate-500">
        {hasPersistedBands && (
          <>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
              Within band when evaluated
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
              Outside band — breaker would trip
            </span>
          </>
        )}
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />
          {msg}
        </span>
        {breachStartedAt && Number(breachStartedAt) > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-dotted border-red-500" />
            Rebalance breach start
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[10px] sm:text-xs text-slate-500">
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
        {/* Marker verdicts use each snapshot's at-the-time band when
            persisted (oracle_median_updated rows from PR #631 onward),
            falling back to the current band for older rows. The drawn
            band shape (dashed lines / shaded zones) below always reflects
            the CURRENT breaker config — historical bands aren't drawn
            because they'd produce a noisy stack of rectangles. */}
        Within band when evaluated
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        Outside band — breaker would trip
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 border-t-2 border-dashed border-red-500" />
        Current threshold
        {thresholdRatio != null
          ? ` (±${(thresholdRatio * 100).toFixed(2)}%)`
          : ""}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 border-t-2 border-dotted border-slate-400" />
        Current baseline ({baselineLabel}
        {baseline != null ? ` = ${formatBaseline(baseline)}` : ""})
      </span>
      {breachStartedAt && Number(breachStartedAt) > 0 && (
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dotted border-red-500" />
          Rebalance breach start
        </span>
      )}
    </div>
  );
}
