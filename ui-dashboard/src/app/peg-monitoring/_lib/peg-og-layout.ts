import { PEG_RAIL_SCALE_BPS } from "./peg-board-model";
import type { PegOgRow } from "./peg-og-data";

const RAIL_RED = "rgba(201,44,44,0.40)";
const RAIL_AMBER = "rgba(254,153,0,0.35)";
const RAIL_GREEN = "rgba(30,204,9,0.25)";

/**
 * Where a signed bps value sits on the fixed ±60 bps rail. Values outside the
 * window return <0 or >100 — the tick scale drops those rather than draw a
 * threshold where it is not, while `railGradient` clamps them, since a band
 * edge past the rail just means that zone fills to the end.
 */
function railPercent(bps: number): number {
  return 50 + (bps / PEG_RAIL_SCALE_BPS) * 50;
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

/**
 * Hard-edged zones over the fixed ±60 bps window, with the colour boundaries
 * derived from the same policy thresholds the tick scale labels.
 *
 * The page's `PEG_RAIL_GRADIENT` hardcodes 10/30/70 — a rounded stand-in for
 * EUROP's ±25/±50 that actually lands on ±24/−48. The page can afford that
 * because it draws no threshold ticks; the card labels them, so a fixed
 * gradient would print "warn −25" against a band that starts at −24, and for a
 * peg on different policy would put the label nowhere near its own band.
 */
export function railGradient(thresholds: PegOgRow["thresholds"]): string {
  const criticalEdge = clampPercent(railPercent(-thresholds.downsideCritical));
  const warnEdge = clampPercent(railPercent(-thresholds.downsideWarn));
  const premiumEdge = clampPercent(railPercent(thresholds.premiumWarn));
  return [
    "linear-gradient(to right",
    `${RAIL_RED} 0%`,
    `${RAIL_RED} ${criticalEdge}%`,
    `${RAIL_AMBER} ${criticalEdge}%`,
    `${RAIL_AMBER} ${warnEdge}%`,
    `${RAIL_GREEN} ${warnEdge}%`,
    `${RAIL_GREEN} ${premiumEdge}%`,
    `${RAIL_AMBER} ${premiumEdge}%`,
    `${RAIL_AMBER} 100%)`,
  ].join(", ");
}

export type RailTick = {
  at: number;
  label: string;
  tone: "critical" | "warn" | "target";
};

/**
 * Minimum gap between two tick centres, as a percentage of rail width. The
 * labels are centred boxes ~140px wide on a ~330–1000px rail; below this gap
 * neighbouring labels collide and print as one unreadable run.
 */
const MIN_TICK_GAP_PERCENT = 12;

/**
 * Threshold ticks for a peg's own policy, worst-first so that when two
 * thresholds sit too close to label separately the *less* severe one is the
 * one dropped. Ticks outside the ±60 bps window are dropped rather than
 * clamped: a tick is a claim about where a threshold is, and a clamped tick
 * would put that claim in the wrong place.
 */
export function railTicks(thresholds: PegOgRow["thresholds"]): RailTick[] {
  const candidates = (
    [
      {
        at: railPercent(-thresholds.downsideCritical),
        label: `critical −${thresholds.downsideCritical}`,
        tone: "critical",
      },
      { at: 50, label: "TARGET", tone: "target" },
      {
        at: railPercent(-thresholds.downsideWarn),
        label: `warn −${thresholds.downsideWarn}`,
        tone: "warn",
      },
      {
        at: railPercent(thresholds.premiumWarn),
        label: `warn +${thresholds.premiumWarn}`,
        tone: "warn",
      },
    ] satisfies RailTick[]
  ).filter((tick) => tick.at >= 0 && tick.at <= 100);

  const kept: RailTick[] = [];
  for (const tick of candidates) {
    const collides = kept.some(
      (placed) => Math.abs(placed.at - tick.at) < MIN_TICK_GAP_PERCENT,
    );
    if (!collides) kept.push(tick);
  }
  return kept.sort((left, right) => left.at - right.at);
}
