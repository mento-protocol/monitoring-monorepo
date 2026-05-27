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
}: {
  snapshot: OracleSnapshot;
  price: number;
  baseline?: number | null;
  thresholdRatio?: number | null;
  token0Symbol: string;
  token1Symbol: string;
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
          // Verdict is a CURRENT-state lens — checks the point against
          // today's baseline + threshold, not the snapshot's at-the-time
          // band. Matters most for MEDIAN_DELTA pools where the EMA
          // drifts; the legend/title clarify the "current" framing.
          const verdict =
            thresholdBps != null
              ? Math.abs(bps) > thresholdBps
                ? " · would trip current band"
                : " · within current band"
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
    (snapshot.source ? `<br>Source: ${snapshot.source}` : "")
  );
}
