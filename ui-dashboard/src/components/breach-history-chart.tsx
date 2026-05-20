"use client";

import dynamic from "next/dynamic";
import type { DeviationThresholdBreach } from "@/lib/types";
import {
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_BASE_LAYOUT,
  PLOTLY_CONFIG,
  PLOTLY_LEGEND,
  escapePlotText,
  makeDateXAxis,
  RANGE_SELECTOR_BUTTONS_DAILY,
} from "@/lib/plot";
import {
  DEVIATION_BREACH_GRACE_SECONDS,
  DEVIATION_CRITICAL_RATIO,
} from "@/lib/health";
import { tradingSecondsInRange } from "@/lib/weekend";
import { formatDurationShort } from "@/lib/bridge-status";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface Props {
  breaches: DeviationThresholdBreach[];
}

/**
 * One marker per breach. X = when it started, Y = its duration. Y is log-
 * scaled because breach durations span seconds (near-miss rebalanced in
 * one swap) to days (stuck pool past the 1h grace), and linear Y would
 * make the short breaches invisible next to long ones.
 *
 * Colour:
 * - 🔴 red   — breach sat past the 1h grace (counted as CRITICAL time)
 * - 🟡 amber — breach closed inside the grace (warned but not critical)
 * - 🟣 indigo — still ongoing
 *
 * Reading the chart:
 * - Frequency → marker density along X. Clusters = a rough patch.
 * - Length    → marker Y. A red dot high up = a long, costly outage.
 * - Severity  → colour. Red dots are the ones that moved the uptime SLO.
 */
export function BreachHistoryChart({ breaches }: Props) {
  if (breaches.length === 0) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const grace = Number(DEVIATION_BREACH_GRACE_SECONDS);

  // Split into three series so each gets its own colour + legend entry.
  // Note: under the tolerance refactor, `closedInGrace` covers BOTH
  // breaches that closed within 1h AND multi-hour breaches whose peak
  // never crossed 1.05x — neither accrue `criticalDurationSeconds`. The
  // amber "Within grace" colouring stays accurate ("not critical") even
  // for the long-but-low ones.
  const closedCritical: Marker[] = [];
  const closedInGrace: Marker[] = [];
  const ongoing: Marker[] = [];

  for (const b of breaches) {
    const startedAt = Number(b.startedAt);
    const isOpen = b.endedAt == null;
    // Use stored trading-seconds for closed rows; approximate live open-row
    // duration via `tradingSecondsInRange` so the chart's Y-axis is on the
    // same basis as the Uptime tile and the Past-grace column.
    const duration = isOpen
      ? tradingSecondsInRange(startedAt, nowSeconds)
      : Number(b.durationSeconds ?? "0");
    // Score peak severity against the threshold the breach OPENED against
    // (entry, not current pool threshold). Pre-PR-1.6 legacy rows have
    // `entryRebalanceThreshold=0` because the prior indexer captured raw
    // active threshold without the asymmetric-zero substitute. Reading the
    // live `pool.rebalanceThreshold` would consult the post-flip side and
    // re-score history (cursor #3214689033), so the legacy fallback
    // canonicalizes to 10000 directly — the same under-bound the predicate
    // scored against at rising edge for any pool legitimately captured at 0.
    const entryThreshold =
      (b.entryRebalanceThreshold ?? 0) > 0 ? b.entryRebalanceThreshold! : 10000;
    const peakAboveCritical =
      Number(b.peakPriceDifference) / entryThreshold > DEVIATION_CRITICAL_RATIO;
    // Open-row past-grace only counts as critical when peak crossed the
    // 1.05x line — otherwise this is a long WARN-only breach (above
    // tolerance, below critical magnitude), which the rest of the app
    // does not score as critical seconds.
    const critical = isOpen
      ? peakAboveCritical
        ? tradingSecondsPastGrace(startedAt, nowSeconds, grace)
        : 0
      : Number(b.criticalDurationSeconds ?? "0");
    const peakPct = (Number(b.peakPriceDifference) / entryThreshold) * 100;
    const marker: Marker = {
      x: new Date(startedAt * 1000).toISOString(),
      // Clamp minimum to 1s so a genuine 0-duration breach renders on the
      // log axis instead of collapsing to -Infinity.
      y: Math.max(1, duration),
      peakPct,
      duration,
      critical,
      isOpen,
    };
    if (isOpen) ongoing.push(marker);
    else if (critical > 0) closedCritical.push(marker);
    else closedInGrace.push(marker);
  }

  const trace = (markers: Marker[], name: string, color: string) => ({
    type: "scatter" as const,
    mode: "markers" as const,
    name,
    x: markers.map((m) => m.x),
    y: markers.map((m) => m.y),
    customdata: markers.map((m) => [
      formatDurationShort(m.duration),
      formatDurationShort(m.critical),
      m.peakPct.toFixed(1),
    ]),
    hovertemplate:
      "<b>%{x}</b><br>" +
      "Duration: %{customdata[0]}<br>" +
      "Past grace: %{customdata[1]}<br>" +
      "Peak: %{customdata[2]}% of threshold<extra>" +
      escapePlotText(name) +
      "</extra>",
    marker: {
      color,
      size: 8,
      opacity: 0.85,
      line: { color: "rgba(255,255,255,0.15)", width: 1 },
    },
  });

  const data = [
    trace(closedCritical, "Past grace (CRITICAL)", "#ef4444"),
    trace(closedInGrace, "Within grace", "#f59e0b"),
    trace(ongoing, "Ongoing", "#8b5cf6"),
  ].filter((t) => t.x.length > 0);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
      <Plot
        data={data}
        layout={{
          ...PLOTLY_BASE_LAYOUT,
          autosize: true,
          height: 260,
          margin: { l: 56, r: 16, t: 8, b: 40 },
          xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
          yaxis: {
            ...PLOTLY_AXIS_DEFAULTS,
            type: "log",
            title: { text: "Breach duration", standoff: 8 },
            // Nice log ticks: 1s, 10s, 1min, 10min, 1h, 6h, 1d.
            tickvals: [1, 10, 60, 600, 3600, 21600, 86400],
            ticktext: ["1s", "10s", "1m", "10m", "1h", "6h", "1d"],
          },
          legend: { ...PLOTLY_LEGEND, orientation: "h", y: -0.25 },
          hovermode: "closest",
          // Draw a thin amber reference line at the 1h grace boundary so
          // the split between amber and red markers is visually obvious.
          shapes: [
            {
              type: "line",
              xref: "paper",
              x0: 0,
              x1: 1,
              yref: "y",
              y0: grace,
              y1: grace,
              line: { color: "#f59e0b", width: 1, dash: "dot" },
            },
          ],
          annotations: [
            {
              xref: "paper",
              yref: "y",
              x: 1,
              // Plotly quirk: shapes auto-transform `y` to log coordinates
              // when the axis is type: "log", but annotations don't —
              // pass log10(value) explicitly, otherwise the label renders
              // at 10^3600 (way off-chart).
              y: Math.log10(grace),
              xanchor: "right",
              yanchor: "bottom",
              text: "1h grace",
              showarrow: false,
              font: { size: 10, color: "#f59e0b" },
            },
          ],
        }}
        config={PLOTLY_CONFIG}
        style={{ width: "100%" }}
      />
    </div>
  );
}

function tradingSecondsPastGrace(
  startedAt: number,
  nowSeconds: number,
  graceSeconds: number,
): number {
  const duration = tradingSecondsInRange(startedAt, nowSeconds);
  if (duration <= graceSeconds) return 0;

  let low = startedAt;
  let high = nowSeconds;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (tradingSecondsInRange(startedAt, mid) >= graceSeconds) high = mid;
    else low = mid + 1;
  }

  return tradingSecondsInRange(low, nowSeconds);
}

type Marker = {
  x: string;
  y: number;
  peakPct: number;
  duration: number;
  critical: number;
  isOpen: boolean;
};
