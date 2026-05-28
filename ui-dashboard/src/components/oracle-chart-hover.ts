import { escapePlotText } from "@/lib/plot";
import type { OracleSnapshot } from "@/lib/types";

export function formatBaseline(b: number): string {
  if (b >= 100) return b.toFixed(2);
  if (b >= 1) return b.toFixed(4);
  return b.toFixed(6);
}

export function formatOracleChartHoverText({
  snapshot,
  price,
  baseline,
  thresholdRatio,
  token0Symbol,
  token1Symbol,
  // True when `baseline`/`thresholdRatio` come from the per-snapshot
  // persisted fields (so the verdict is the actual at-the-time evaluation),
  // false when they come from the current breaker config fallback.
  // Defaults to false to preserve old callers' wording.
  isHistoricalBand = false,
}: {
  snapshot: OracleSnapshot;
  price: number;
  baseline?: number | null;
  thresholdRatio?: number | null;
  token0Symbol: string;
  token1Symbol: string;
  isHistoricalBand?: boolean;
}): string {
  const d = new Date(Number(snapshot.timestamp) * 1000);
  const ts =
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }) +
    " " +
    d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const priceText = Number.isFinite(price) ? price.toFixed(8) : "N/A";
  // Distance from baseline as both an absolute price difference (8dp) and
  // a basis-point delta, which is the unit operators tend to read in.
  const deltaLine =
    baseline && Number.isFinite(price)
      ? (() => {
          const delta = price - baseline;
          const bps = (delta / baseline) * 10_000;
          const sign = delta >= 0 ? "+" : "";
          const thresholdBps =
            thresholdRatio != null ? thresholdRatio * 10_000 : null;
          // Wording flips on `isHistoricalBand`: when the baseline comes
          // from the per-snapshot persisted fields (the comparator the
          // contract actually evaluated against), drop "current" because
          // the verdict isn't current-lens — it's the at-the-time call.
          // Pre-deploy snapshots + null-source rows still resolve to the
          // current band and keep the "current" framing.
          const breachLabel = isHistoricalBand
            ? " · would have tripped at the time"
            : " · would trip current band";
          const okLabel = isHistoricalBand
            ? " · within band at the time"
            : " · within current band";
          const verdict =
            thresholdBps != null
              ? Math.abs(bps) > thresholdBps
                ? breachLabel
                : okLabel
              : "";
          return `<br>Δ vs baseline: ${sign}${delta.toFixed(8)} (${sign}${bps.toFixed(1)} bps)${verdict}`;
        })()
      : "";
  // Don't label the price as `token0/token1` — for USD-stable-base pools
  // `parseOraclePriceToNumber` inverts the rate for display, so the table
  // shows the inverse direction under that same label. The chart uses the
  // raw feed value (so it's directly comparable to the breaker config),
  // which would be the WRONG direction under `token0/token1`. Use the
  // pair tokens for context but make the orientation explicit.
  return (
    `<b>${ts}</b><br>` +
    `Oracle feed: ${priceText} (raw ${token0Symbol}/${token1Symbol} pair)` +
    deltaLine +
    // Source field distinguishes oracle_reported vs oracle_median_updated.
    // Escape because Plotly's `text` field renders a permissive HTML subset
    // and `source` is a DB-sourced string — even though the chart's GQL
    // query currently restricts it to a fixed value, the rule is to escape
    // at the render boundary (see `escapePlotText` doc).
    (snapshot.source ? `<br>Source: ${escapePlotText(snapshot.source)}` : "")
  );
}
