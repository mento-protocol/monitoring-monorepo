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

/** Width of a tick's centred label box in `RailScale`, in px. */
const TICK_LABEL_WIDTH = 140;

/**
 * Rail width in px inside a tile, which is the only place ticks render: the
 * 1200px card less its 56px side padding, less the tile's own ~30px padding.
 * Both tile scales land within 4px of this, so one constant covers them.
 *
 * (The table layout's rail is roughly a third of this, but it draws no ticks —
 * an earlier version of this comment conflated the two and understated the
 * available width.)
 */
const TILE_RAIL_WIDTH = 1024;

/**
 * Minimum gap between two tick centres, as a percentage of rail width, derived
 * from the label box rather than guessed: two centred 140px boxes need at least
 * their own width between centres or they overlap and print as one run.
 */
const MIN_TICK_GAP_PERCENT = (TICK_LABEL_WIDTH / TILE_RAIL_WIDTH) * 100;

/**
 * Threshold ticks for a peg's own policy.
 *
 * `TARGET` is reserved before anything else is considered: it is the rail's
 * reference point, and a rail that labels a threshold but not the target it
 * deviates from is unreadable. A tight policy makes this reachable — with a
 * 10 bps critical the critical tick lands 8.3% from centre, and filtering it
 * in candidate order dropped `TARGET` itself.
 *
 * Policy ticks then compete for the remaining room worst-first, so when two
 * sit closer than a label width the *less* severe one is dropped. Ticks
 * outside the ±60 bps window are dropped rather than clamped: a tick is a
 * claim about where a threshold is, and a clamped tick would put that claim in
 * the wrong place. A dropped label never hides the threshold itself — the
 * gradient still changes colour at that exact point.
 */
export function railTicks(thresholds: PegOgRow["thresholds"]): RailTick[] {
  const target: RailTick = { at: 50, label: "TARGET", tone: "target" };
  const policy = (
    [
      {
        at: railPercent(-thresholds.downsideCritical),
        label: `critical −${thresholds.downsideCritical}`,
        tone: "critical",
      },
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

  const kept: RailTick[] = [target];
  for (const tick of policy) {
    const collides = kept.some(
      (placed) => Math.abs(placed.at - tick.at) < MIN_TICK_GAP_PERCENT,
    );
    if (!collides) kept.push(tick);
  }
  return kept.sort((left, right) => left.at - right.at);
}
