// Pure computation + formatting helpers backing `<BreakerPanel />`
// (breaker-panel.tsx): Fixidity math, cooldown/trip-count derivations, and
// the `BreakerPresentation` view model its metric components render from.
// Split out to keep breaker-panel.tsx under the repo's file-size soft cap
// (docs/pr-checklists/recurring-review-patterns.md, "File-size budget") —
// verbatim move, no behavior change.

import type { BreakerConfig, BreakerTripEvent } from "@/lib/types";
import { POOL_BREAKER_CONFIG } from "@/lib/queries";
import { formatDurationShort } from "@/lib/bridge-status";
import { effectiveBreakerThreshold } from "@/lib/breaker";

const FIXED_1 = BigInt(10) ** BigInt(24);
// Breaker thresholds are stored as Fixidity (1e24 = 100%). Keep one decimal
// pair throughout the panel: 4.00% / 0.150% etc. We render two decimals for
// FX (4.00%) and three for stablecoin (0.150%) to match the precision of
// the on-chain config without trailing-zero clutter.
const PRECISION_BY_KIND: Record<string, number> = {
  MEDIAN_DELTA: 2,
  VALUE_DELTA: 3,
};

function formatFixidityPct(
  raw: string | null | undefined,
  precision: number,
): string | null {
  if (raw === null || raw === undefined) return null;
  // Convert Fixidity (1e24=100%) to percent. Avoid Number for big values —
  // do it in BigInt with a /1e22 trick to preserve precision. Treats 0 as a
  // legitimate value (median exactly equals reference) — renders "0.00%",
  // not the missing-data dash.
  const value = BigInt(raw);
  if (value < BigInt(0)) return null;
  const scale = BigInt(10) ** BigInt(22 - precision);
  const scaled = value / scale;
  const whole = scaled / BigInt(10) ** BigInt(precision);
  const frac = scaled % BigInt(10) ** BigInt(precision);
  return `${whole}.${frac.toString().padStart(precision, "0")}%`;
}

/** Format a Fixidity-scaled number with 6 decimals (e.g. EMA = 1.171560). */
function formatFixidityValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = BigInt(raw);
  if (value === BigInt(0)) return null;
  const whole = value / FIXED_1;
  const frac = value % FIXED_1;
  // Render 6 decimals: scale frac by 10^6 / FIXED_1 = 10^6 / 10^24 = 10^-18.
  const fracScaled = frac / BigInt(10) ** BigInt(18);
  return `${whole}.${fracScaled.toString().padStart(6, "0")}`;
}

function fixidityOrNull(raw: string | null | undefined): bigint | null {
  if (raw == null) return null;
  const value = BigInt(raw);
  return value === BigInt(0) ? null : value;
}

export function breakerConfigQuery(
  isVirtual: boolean,
  rateFeedID: string,
): string | null {
  return !isVirtual && rateFeedID ? POOL_BREAKER_CONFIG : null;
}

// When the SSR prefetch supplies `fallbackData` (issue #1237), `data` is
// populated on first paint and this is false — the panel renders its resolved
// shape immediately (full strip or null, no shimmer). This stays true only on
// the degraded path (prefetch missed / partial) while the client query is
// genuinely in flight, so BreakerPanel renders a matching-shape shimmer instead
// of the null→content jump (issue #1222's measured +119px header jump).
export function isBreakerConfigQueryPending(
  isVirtual: boolean,
  rateFeedID: string,
  data: unknown,
  isLoading: boolean,
): boolean {
  return !isVirtual && !!rateFeedID && data === undefined && isLoading;
}

/** True when a feed that WOULD query for breaker config (non-virtual + a
 *  rateFeedID) errored with NO data to show — neither a live response nor an SSR
 *  fallback. Drives BreakerPanel's / MarketHoursPill's explicit "unavailable"
 *  state so a failed (e.g. timed-out) fetch doesn't silently vanish like a feed
 *  with genuinely no breaker (issue #1257). Gated on `error` so a resolved feed
 *  with no trip-able breaker / non-FX config still renders null. Shared by both
 *  subscribers (they compute the identical discriminator). */
export function isBreakerFetchUnavailable(
  isVirtual: boolean,
  rateFeedID: string,
  data: unknown,
  error: unknown,
): boolean {
  return !isVirtual && !!rateFeedID && data === undefined && error != null;
}

/** Effective cooldown in seconds. Per-feed override else breaker default. */
function effectiveCooldown(cfg: BreakerConfig): bigint {
  const override = BigInt(cfg.cooldownTime);
  if (override > BigInt(0)) return override;
  return BigInt(cfg.breaker.defaultCooldownTime);
}

/** Seconds until `cooldownEndsAt`, or `null` while the SSR-safe ticker
 *  hasn't read a real wall clock yet (`now === null` pre-mount — see
 *  BreakerPanel's `now` state). Reading `Date.now()` directly at render time
 *  would diverge between the server pass and the client's hydration pass now
 *  that fallbackData paints a TRIPPED breaker's real content on first paint
 *  (issue #1237 round 2); `null` doesn't tell us whether the on-chain
 *  cooldown has actually elapsed, so ThresholdMetric/ResetPathBanner render a
 *  state-neutral "—" placeholder (never "active" or "elapsed") until the
 *  ticker's first tick lands and resolves the real state. */
function cooldownRemainingSecFrom(
  cooldownEndsAt: number,
  now: number | null,
): number | null {
  return now === null ? null : Math.max(0, cooldownEndsAt - now);
}

/** |median - reference| / reference, returned as a Fixidity ratio (1e24 = 100%).
 * Returns null if either input is missing OR is the on-chain `0` sentinel:
 * SortedOracles returns rate `0` when all oracle reports have expired,
 * `medianRatesEMA = 0` is the contract's "uninitialized" marker (until the
 * first MedianUpdated seeds it), and a `referenceValue` of `0` would be a
 * mis-set peg (also produces a divide-by-zero). In all three cases the live
 * Δ is meaningless, so render the missing-data dash. */
function computeLiveDelta(cfg: BreakerConfig): bigint | null {
  const median = fixidityOrNull(cfg.lastMedianRate);
  const reference =
    cfg.breaker.kind === "MEDIAN_DELTA"
      ? fixidityOrNull(cfg.medianRatesEMA)
      : fixidityOrNull(cfg.referenceValue);
  if (median == null || reference == null) return null;
  const diff = median > reference ? median - reference : reference - median;
  return (diff * FIXED_1) / reference;
}

function referenceValue(cfg: BreakerConfig): bigint | null {
  const raw =
    cfg.breaker.kind === "MEDIAN_DELTA"
      ? cfg.medianRatesEMA
      : cfg.referenceValue;
  return fixidityOrNull(raw);
}

function actualValue(cfg: BreakerConfig): bigint | null {
  return fixidityOrNull(cfg.lastMedianRate);
}

function valueDeltaDirection(cfg: BreakerConfig): "above" | "below" | null {
  const reference = referenceValue(cfg);
  const actual = actualValue(cfg);
  if (reference == null || actual == null || actual === reference) return null;
  return actual > reference ? "above" : "below";
}

export type BreakerPresentation = {
  referenceLabel: string;
  liveDeltaLabel: string;
  thresholdCaption: string;
  formattedThreshold: string;
  formattedCooldown: string;
  formattedReference: string | null;
  formattedActual: string | null;
  formattedLiveDelta: string;
  breachedValueClass: string;
  referenceCaption: string;
  isOverTolerance: boolean;
};

function isMedianDelta(cfg: BreakerConfig): boolean {
  return cfg.breaker.kind === "MEDIAN_DELTA";
}

function referenceCaptionFor(
  cfg: BreakerConfig,
  tripped: boolean,
  isOverTolerance: boolean,
  formattedLiveDelta: string,
): string {
  if (isMedianDelta(cfg)) {
    return `smoothing ${formatFixidityPct(cfg.smoothingFactor, 1) ?? "—"}`;
  }
  const pegDirection = valueDeltaDirection(cfg);
  if (tripped && isOverTolerance && pegDirection) {
    // `isOverTolerance` implies a non-null live delta, so this is never "—".
    return `${formattedLiveDelta} ${pegDirection} peg`;
  }
  return "fixed peg";
}

function breakerPresentation(
  cfg: BreakerConfig,
  threshold: bigint,
  cooldown: bigint,
  liveDelta: bigint | null,
  tripped: boolean,
): BreakerPresentation {
  const kind = cfg.breaker.kind;
  const precision = PRECISION_BY_KIND[kind] ?? 2;
  const formattedThreshold =
    formatFixidityPct(threshold.toString(), precision) ?? "—";
  const formattedLiveDelta =
    liveDelta != null
      ? (formatFixidityPct(liveDelta.toString(), precision) ?? "—")
      : "—";
  const isOverTolerance =
    threshold > BigInt(0) && liveDelta != null && liveDelta >= threshold;

  return {
    referenceLabel:
      kind === "MEDIAN_DELTA"
        ? "EMA Reference vs Actual"
        : "Reference vs Actual",
    liveDeltaLabel:
      kind === "MEDIAN_DELTA"
        ? "Δ Oracle Price vs EMA"
        : "Δ Oracle Price vs Peg",
    thresholdCaption:
      kind === "MEDIAN_DELTA"
        ? `trips at >${formattedThreshold} from EMA`
        : `trips at >${formattedThreshold} from peg`,
    formattedThreshold,
    formattedCooldown: formatDurationShort(Number(cooldown)),
    formattedReference: formatFixidityValue(
      kind === "MEDIAN_DELTA" ? cfg.medianRatesEMA : cfg.referenceValue,
    ),
    formattedActual: formatFixidityValue(cfg.lastMedianRate),
    formattedLiveDelta,
    breachedValueClass:
      tripped && isOverTolerance ? "text-red-300" : "text-white",
    referenceCaption: referenceCaptionFor(
      cfg,
      tripped,
      isOverTolerance,
      formattedLiveDelta,
    ),
    isOverTolerance,
  };
}

/** Returns the bar fill (0-100) and color class for the live-Δ bar. Mirrors
 * the deviation-bar conventions in components/pool-header/deviation-cell.tsx. */
function deltaBarStyle(
  deltaFixidity: bigint,
  thresholdFixidity: bigint,
): {
  pct: number;
  color: string;
} {
  if (thresholdFixidity <= BigInt(0)) {
    return { pct: 0, color: "bg-slate-600" };
  }
  // ratio = delta / threshold, capped at 1.5 for visual purposes.
  const ratioBP = (deltaFixidity * BigInt(10000)) / thresholdFixidity;
  const ratio = Number(ratioBP) / 10000;
  const pct = Math.min(ratio * 100, 100);
  const color =
    ratio >= 1
      ? "bg-red-500"
      : ratio >= 0.8
        ? "bg-yellow-500"
        : "bg-emerald-500";
  return { pct, color };
}

/** Display state for the "· N today" trip suffix in LastTripMetric.
 *  - `pending`: clock not yet resolved but this breaker has trip history, so
 *    reserve a neutral placeholder slot (see below).
 *  - `hidden`: no today-suffix (no trips today, or no trip history at all).
 *  - `count`: resolved, `count` trips since UTC midnight (> 0). */
export type TripsTodayDisplay =
  | { kind: "pending" }
  | { kind: "hidden" }
  | { kind: "count"; count: number };

/** Trips for `breakerAddress` since UTC midnight, as a display state.
 *  `todayNowSeconds === null` (server + hydration render, see useNowSeconds)
 *  can't compute the UTC-midnight boundary without risking a bake-time vs
 *  viewer-clock mismatch, so instead of forcing zero it returns `pending`
 *  whenever this breaker has any recent trip history. LastTripMetric renders a
 *  neutral "· — today" placeholder for `pending` so the real "· N today"
 *  suffix can't pop in post-mount and grow/wrap the header row now that the
 *  panel paints real fallback content on first paint (issue #1257) — the same
 *  reserve-the-slot treatment used for the cooldown countdown. Feeds with no
 *  trip history reserve nothing (`hidden`). Once the clock resolves it returns
 *  the real `count` (or `hidden` when zero trips landed today). Filters by
 *  breaker address — the query is feed-scoped, but a single feed could surface
 *  multiple breakers' trips (only one trip-able breaker today, but
 *  MarketHours-style additions later would drift the count from
 *  cfg.tripCountLifetime if we didn't scope it). */
export function tripsTodayDisplay(
  todayNowSeconds: number | null,
  trips: BreakerTripEvent[],
  breakerAddress: string,
): TripsTodayDisplay {
  const own = trips.filter((t) => t.breaker.address === breakerAddress);
  if (todayNowSeconds === null) {
    return own.length > 0 ? { kind: "pending" } : { kind: "hidden" };
  }
  const todayMidnightSec = Math.floor(todayNowSeconds / 86400) * 86400;
  const count = own.filter(
    (t) => Number(t.blockTimestamp) >= todayMidnightSec,
  ).length;
  return count > 0 ? { kind: "count", count } : { kind: "hidden" };
}

/** The full derived view model a resolved BreakerPanel strip renders from —
 *  effective threshold + cooldown remaining, live Δ and its bar, the
 *  presentation copy, and the reset-path rate-in-band flag. Pulled out of the
 *  component so BreakerPanel stays a thin fetch-then-render shell (and under
 *  the ESLint per-function line budget). `now` is the SSR-safe cooldown ticker
 *  value (`null` pre-mount — see cooldownRemainingSecFrom). */
type BreakerView = {
  cooldownRemainingSec: number | null;
  liveDelta: bigint | null;
  presentation: BreakerPresentation;
  liveBar: { pct: number; color: string };
  rateInBand: boolean;
};

export function deriveBreakerView(
  cfg: BreakerConfig,
  now: number | null,
  tripped: boolean,
): BreakerView {
  const threshold = effectiveBreakerThreshold(cfg);
  const cooldown = effectiveCooldown(cfg);
  const cooldownRemainingSec = cooldownRemainingSecFrom(
    Number(cfg.cooldownEndsAt),
    now,
  );
  const liveDelta = computeLiveDelta(cfg);
  const presentation = breakerPresentation(
    cfg,
    threshold,
    cooldown,
    liveDelta,
    tripped,
  );
  const liveBar =
    liveDelta != null
      ? deltaBarStyle(liveDelta, threshold)
      : { pct: 0, color: "bg-slate-600" };
  // Reset-path condition (mirror BreakerBox.tryResetBreaker). Cooldown's own
  // elapsed/pending state is derived inside ResetPathBanner from
  // cooldownRemainingSec directly (see its comment).
  const rateInBand = liveDelta != null && liveDelta < threshold;
  return { cooldownRemainingSec, liveDelta, presentation, liveBar, rateInBand };
}
