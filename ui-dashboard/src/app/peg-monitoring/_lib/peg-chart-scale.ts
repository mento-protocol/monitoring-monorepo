import type { PegAssetPackage } from "@/lib/peg-monitoring";

/**
 * Chart geometry, read off the 2a mockup's SVG. The plot occupies x 0–760, the
 * right-edge mini-rail sits at x 768 (8px wide), and gutter labels start at
 * x 790. Band area is 200px tall; the remaining 24px carry the date axis.
 */
export const PEG_CHART = {
  viewBoxWidth: 900,
  viewBoxHeight: 224,
  plotWidth: 760,
  plotHeight: 200,
  railX: 768,
  railWidth: 8,
  labelX: 790,
  axisY: 216,
} as const;

/**
 * The mockup's y-domain is ±1.4× the policy's own thresholds: with EUROP's
 * +25/−50 bps policy the top edge lands at +35 bps and the bottom at −70 bps,
 * exactly reproducing the mockup's 1.905 px/bp scale. Deriving it keeps the
 * bands correct for a package whose policy is not 25/50.
 */
const DOMAIN_HEADROOM = 1.4;

export type PegChartScale = {
  topBps: number;
  bottomBps: number;
  premiumWarnBps: number;
  warnBps: number;
  criticalBps: number;
  /** Signed bps → y in viewBox units. Positive bps is above target. */
  y: (bps: number) => number;
};

export function pegChartScale(
  policy: PegAssetPackage["policy"],
): PegChartScale {
  const premiumWarnBps = Math.max(1, policy.premiumWarnBps);
  const criticalBps = Math.max(1, policy.criticalDeviationBps);
  const warnBps = Math.max(1, policy.warnDeviationBps);
  const topBps = premiumWarnBps * DOMAIN_HEADROOM;
  const bottomBps = -criticalBps * DOMAIN_HEADROOM;
  const span = topBps - bottomBps;
  return {
    topBps,
    bottomBps,
    premiumWarnBps,
    warnBps,
    criticalBps,
    y: (bps) =>
      clamp(
        ((topBps - bps) / span) * PEG_CHART.plotHeight,
        0,
        PEG_CHART.plotHeight,
      ),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export type PegChartBand = {
  key: string;
  y: number;
  height: number;
  fill: string;
  /** Higher-alpha twin used by the right-edge mini-rail. */
  railFill: string;
};

/** Top to bottom: premium-warning, healthy, downside-warning, critical. */
export function pegChartBands(scale: PegChartScale): PegChartBand[] {
  const edges: Array<{ key: string; from: number; to: number; hue: string }> = [
    {
      key: "premium",
      from: scale.topBps,
      to: scale.premiumWarnBps,
      hue: "amber",
    },
    {
      key: "healthy",
      from: scale.premiumWarnBps,
      to: -scale.warnBps,
      hue: "green",
    },
    {
      key: "warning",
      from: -scale.warnBps,
      to: -scale.criticalBps,
      hue: "amber",
    },
    {
      key: "critical",
      from: -scale.criticalBps,
      to: scale.bottomBps,
      hue: "red",
    },
  ];
  return edges.map(({ key, from, to, hue }) => {
    const top = scale.y(from);
    return {
      key,
      y: top,
      height: Math.max(0, scale.y(to) - top),
      fill: BAND_FILL[hue]!,
      railFill: RAIL_FILL[hue]!,
    };
  });
}

const BAND_FILL: Record<string, string> = {
  amber: "oklch(76.9% 0.188 70 / 0.08)",
  green: "oklch(73.5% 0.245 142 / 0.05)",
  red: "oklch(54.7% 0.193 26.4 / 0.10)",
};
const RAIL_FILL: Record<string, string> = {
  amber: "oklch(76.9% 0.188 70 / 0.35)",
  green: "oklch(73.5% 0.245 142 / 0.25)",
  red: "oklch(54.7% 0.193 26.4 / 0.4)",
};

export type PegHistoryPoint = {
  /** Unix seconds. */
  at: number;
  /** Signed deviation from target; negative is below target. */
  bps: number;
  /** Alert name when a state transition fired at this reading. */
  event?: string;
};

/** Evenly spaced x positions across the plot for a fixed-length series. */
export function pointX(index: number, count: number): number {
  if (count <= 1) return PEG_CHART.plotWidth;
  return (index / (count - 1)) * PEG_CHART.plotWidth;
}

/** Nearest series index for a pointer position expressed in viewBox units. */
export function nearestPointIndex(x: number, count: number): number {
  if (count <= 1) return 0;
  const ratio = clamp(x / PEG_CHART.plotWidth, 0, 1);
  return Math.round(ratio * (count - 1));
}

export const PEG_CHART_RANGES = ["24h", "7d", "30d"] as const;
export type PegChartRange = (typeof PEG_CHART_RANGES)[number];
export const PEG_CHART_DEFAULT_RANGE: PegChartRange = "7d";
