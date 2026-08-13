import { sortedCopy } from "@/lib/immutable-sort";
import type {
  PegAssetPackage,
  PegMonitor,
  PegSource,
} from "@/lib/peg-monitoring";
import type {
  PegAssetPresentation,
  PegMonitoringPresentation,
} from "@/lib/peg-monitoring-presentation";
import {
  formatDuration,
  formatFraction,
  formatWholeBps,
} from "./peg-board-format";

/**
 * Literal mockup colours. The board itself prefers `@mento-protocol/ui` token
 * utilities (`bg-background`, `bg-card`, `border-border`,
 * `text-muted-foreground`, `--success`, `--destructive`, `--primary-border`),
 * whose `.dark` values are exactly these. Literals are still needed in two
 * places tokens cannot reach: SVG fills that composite their own alpha, and
 * tooltip content, which Radix portals to `document.body` — outside the `.dark`
 * scope where the token variables are defined.
 */
export const PEG_COLOR = {
  background: "oklch(10.1% 0.0517 307)",
  surface: "oklch(18.7% 0.0209 303)",
  hairline: "oklch(26.13% 0.0288 302.75)",
  borderStrong: "oklch(52.6% 0.0327 306)",
  text: "oklch(98% 0.0054 297.73)",
  text2: "oklch(85% 0.01 300)",
  muted: "oklch(64.1% 0.0105 299)",
  dim: "oklch(52% 0.02 302)",
  green: "oklch(73.5% 0.245 142)",
  amber: "oklch(76.9% 0.188 70)",
  red: "oklch(54.7% 0.193 26.4)",
  redText: "oklch(66% 0.19 26)",
  offScale: "oklch(58% 0.13 26.4)",
  purple: "oklch(51.16% 0.2893 289.05)",
} as const;

/** Custom properties the board root publishes for colours with no DS token. */
export const PEG_BOARD_VARS = {
  "--peg-amber": PEG_COLOR.amber,
  "--peg-red": PEG_COLOR.red,
  "--peg-red-text": PEG_COLOR.redText,
  "--peg-offscale": PEG_COLOR.offScale,
  "--peg-dim": PEG_COLOR.dim,
  "--peg-text-2": PEG_COLOR.text2,
} as const;

export type PegBoardTone = "healthy" | "warning" | "critical" | "uncertain";

/** Tone → literal colour, for SVG and portalled tooltip content. */
export const PEG_TONE_COLOR: Record<PegBoardTone, string> = {
  healthy: PEG_COLOR.green,
  warning: PEG_COLOR.amber,
  critical: PEG_COLOR.red,
  uncertain: PEG_COLOR.amber,
};

/** Board grid: Peg · Status · Price · Distance · Primary · Spread · Limit · Breaker · chevron. */
export const PEG_BOARD_GRID =
  "grid-cols-[118px_92px_94px_1fr_160px_118px_132px_96px_28px] gap-4";
/** Sum of the fixed tracks plus gaps, so the 1fr distance column keeps its rail. */
// Fixed columns + gaps + row padding total 1,002px, so anything at or below
// that starves the 1fr distance column; 1,220px leaves it the ~215px the rail
// plus an un-truncated "31.2 bps below" label need. Below this the wrapper's
// overflow-x-auto scrolls instead of crushing cells.
export const PEG_BOARD_MIN_WIDTH = "min-w-[1220px]";

/** The row rail spans ±60 bps around target, with the target tick at 50%. */
export const PEG_RAIL_SCALE_BPS = 60;

/**
 * Hard-edged four-zone gradient: red below −60%..−30 bps, amber to −18 bps,
 * green through the middle, amber out to the premium edge. Percentages are
 * fixed because the rail is a constant ±60 bps window, not a policy-derived one.
 */
export const PEG_RAIL_GRADIENT = [
  "linear-gradient(to right",
  "oklch(54.7% 0.193 26.4/0.4) 0%",
  "oklch(54.7% 0.193 26.4/0.4) 10%",
  "oklch(76.9% 0.188 70/0.35) 10%",
  "oklch(76.9% 0.188 70/0.35) 30%",
  "oklch(73.5% 0.245 142/0.25) 30%",
  "oklch(73.5% 0.245 142/0.25) 70%",
  "oklch(76.9% 0.188 70/0.35) 70%",
  "oklch(76.9% 0.188 70/0.35) 100%)",
].join(", ");

export type RailMarker = {
  /** Left offset in percent of the rail width. */
  percent: number;
  /** True when the real deviation sits outside the ±scale window. */
  offScale: boolean;
};

/**
 * Maps a signed distance onto the rail. `direction` carries the sign because
 * the presentation layer reports magnitude only.
 */
export function railMarker(
  distanceBps: number | null,
  direction: PegAssetPresentation["direction"],
  scaleBps: number = PEG_RAIL_SCALE_BPS,
): RailMarker | null {
  if (distanceBps === null || direction === null) return null;
  const sign = direction === "below" ? -1 : direction === "above" ? 1 : 0;
  const signed = sign * distanceBps;
  const raw = 50 + (signed / scaleBps) * 50;
  return {
    percent: Math.min(100, Math.max(0, raw)),
    offScale: raw < 0 || raw > 100,
  };
}

const TONE_RANK: Record<PegBoardTone, number> = {
  critical: 3,
  warning: 2,
  uncertain: 1,
  healthy: 0,
};

export function boardTone(asset: PegAssetPresentation): PegBoardTone {
  if (asset.currentCritical || asset.tone === "critical") return "critical";
  if (asset.uncertain) return "uncertain";
  return asset.tone;
}

/** Warning and critical rows first, then alphabetical by pair (handoff rule). */
export function sortBoardRows(
  assets: readonly PegAssetPresentation[],
): PegAssetPresentation[] {
  return sortedCopy(
    assets,
    (left, right) =>
      TONE_RANK[boardTone(right)] - TONE_RANK[boardTone(left)] ||
      pegPairLabel(left).localeCompare(pegPairLabel(right)),
  );
}

export function pegPairLabel(asset: PegAssetPresentation): string {
  return `${asset.assetName} / ${asset.asset.peg}`;
}

/**
 * Header pill: "2 of 3 pegs healthy · 1 warning". The tone and the trailing
 * qualifier come from `presentPegMonitoring`'s aggregate so the board keeps the
 * existing verdict semantics (stale package, pending policy, blind checks)
 * rather than re-deriving them from row counts.
 */
export function boardSummary(presentation: PegMonitoringPresentation): {
  text: string;
  tone: PegBoardTone;
  ariaLabel: string;
} {
  const tones = presentation.assets.map(boardTone);
  const count = (tone: PegBoardTone) =>
    tones.filter((candidate) => candidate === tone).length;
  const total = tones.length;
  const parts = [
    `${count("healthy")} of ${total} ${total === 1 ? "peg" : "pegs"} healthy`,
  ];
  if (count("critical") > 0) parts.push(`${count("critical")} critical`);
  if (count("warning") > 0) parts.push(`${count("warning")} warning`);
  if (count("uncertain") > 0) parts.push(`${count("uncertain")} unconfirmed`);
  if (presentation.aggregate.tone === "uncertain")
    parts.push(presentation.aggregate.label.toLowerCase());
  return {
    text: parts.join(" · "),
    tone:
      presentation.aggregate.tone === "uncertain"
        ? "uncertain"
        : presentation.aggregate.tone,
    ariaLabel:
      presentation.aggregate.detail === null
        ? presentation.aggregate.label
        : `${presentation.aggregate.label}. ${presentation.aggregate.detail}`,
  };
}

export function statusBadge(asset: PegAssetPresentation): {
  label: string;
  tone: PegBoardTone;
} {
  const tone = boardTone(asset);
  if (tone === "critical") return { label: "Critical", tone };
  if (tone === "uncertain") return { label: "Unconfirmed", tone };
  return { label: tone === "warning" ? "Warning" : "Healthy", tone };
}

/** "3.1 bps below" / "At target" / "Price unavailable". */
export function distanceLabelFor(
  distanceBps: number | null,
  direction: PegAssetPresentation["direction"],
): string {
  if (distanceBps === null || direction === null) return "Price unavailable";
  if (direction === "at target") return "At target";
  return `${formatDeviationBps(distanceBps)} ${direction}`;
}

export function distanceLabel(asset: PegAssetPresentation): string {
  return distanceLabelFor(asset.distanceBps, asset.direction);
}

const deviationFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

export function formatDeviationBps(value: number): string {
  return value > 0 && value < 0.05
    ? "<0.1 bps"
    : `${deviationFormat.format(value)} bps`;
}

export type SourceDistance = {
  bps: number | null;
  direction: PegAssetPresentation["direction"];
};

/**
 * Supporting venues carry no presentation record of their own, so the board
 * derives their signed distance the same way `presentPegMonitoring` does for
 * the primary market.
 */
export function sourceDistance(
  source: PegSource,
  target: number,
): SourceDistance {
  if (source.executablePrice === null || target === 0)
    return { bps: null, direction: null };
  const signed = (source.executablePrice / target - 1) * 10_000;
  if (signed === 0) return { bps: 0, direction: "at target" };
  return {
    bps: Math.abs(signed),
    direction: signed < 0 ? "below" : "above",
  };
}

/** Title-cased venue with a spaced pair, e.g. `Bitvavo EUROP / EUR`. */
export function venueLabel(source: PegSource): string {
  const provider =
    source.provider.length === 0
      ? source.provider
      : `${source.provider[0]!.toUpperCase()}${source.provider.slice(1)}`;
  return `${provider} ${source.baseCurrency} / ${source.quoteCurrency}`;
}

/**
 * Venue trade-page URLs are not part of the monitoring payload, so the board
 * keeps a small provider map. An unknown provider renders unlinked rather than
 * guessing a URL shape.
 */
const VENUE_TRADE_URL: Record<string, (source: PegSource) => string> = {
  bitvavo: (source) =>
    `https://account.bitvavo.com/markets/${source.baseCurrency.toUpperCase()}-${source.quoteCurrency.toUpperCase()}`,
  kraken: (source) =>
    `https://pro.kraken.com/app/trade/${source.baseCurrency.toLowerCase()}-${source.quoteCurrency.toLowerCase()}`,
};

export function venueTradeUrl(source: PegSource): string | null {
  return VENUE_TRADE_URL[source.provider.toLowerCase()]?.(source) ?? null;
}

export type BreakerState = {
  label: string;
  tone: PegBoardTone;
  detail: string;
};

/**
 * Preserved from the pre-redesign evidence panel: the same conditions in the
 * same order, relabelled to the board's terminology ("breaker", not "trade
 * safeguard") per the handoff's binding glossary.
 */
export function safeguardState(
  monitor: PegMonitor,
  current: boolean,
  stale: boolean,
): BreakerState {
  if (!current)
    return {
      label: "Check expired",
      tone: "warning",
      detail: "The last breaker result is too old to use.",
    };
  if (!monitor.indexedPoolReachable)
    return {
      label: "Unavailable",
      tone: "warning",
      detail: stale
        ? "At the last confirmed check, pool data was unavailable."
        : "Pool data is unavailable, so the breaker cannot confirm current conditions.",
    };
  if (monitor.breaker === null)
    return {
      label: "Unavailable",
      tone: "warning",
      detail: stale
        ? "The breaker was unavailable at the last confirmed check."
        : "The breaker could not be checked.",
    };
  if (!monitor.breaker.enabled)
    return {
      label: "Disabled",
      tone: "warning",
      detail: stale
        ? "The breaker was disabled at the last confirmed check."
        : "The breaker is disabled.",
    };
  if (monitor.breaker.status === "TRIPPED")
    return {
      label: "Tripped",
      tone: "critical",
      detail: stale
        ? "The breaker was tripped at the last confirmed check."
        : "The breaker has tripped.",
    };
  if (monitor.structuralQuerySaturated)
    return {
      label: "Check expired",
      tone: "warning",
      detail: stale
        ? "At the last confirmed check, the pool query reached its result limit."
        : "The pool query reached its result limit, so this check is incomplete.",
    };
  return {
    label: "Ready",
    tone: "healthy",
    detail: stale
      ? "At the last confirmed check, the breaker was enabled and had not tripped."
      : "The breaker is enabled and has not tripped.",
  };
}

export type MonitorState = {
  monitor: PegMonitor;
  poolId: string;
  breaker: BreakerState;
  saturation: number | null;
};

export function monitorStates(
  asset: PegAssetPresentation,
  current: boolean,
  stale: boolean,
): MonitorState[] {
  return asset.asset.monitors.map((monitor) => ({
    monitor,
    poolId: `${monitor.chainId}-${monitor.poolAddress}`,
    breaker: safeguardState(monitor, current, stale),
    saturation: monitor.structuralSaturation,
  }));
}

/** The row shows the worst breaker; the panel lists every monitor. */
export function worstMonitor(
  states: readonly MonitorState[],
): MonitorState | null {
  return states.reduce<MonitorState | null>(
    (worst, candidate) =>
      worst === null ||
      TONE_RANK[candidate.breaker.tone] > TONE_RANK[worst.breaker.tone]
        ? candidate
        : worst,
    null,
  );
}

/** The pool whose trading limit is closest to saturation backs the row link. */
export function mostSaturatedMonitor(
  states: readonly MonitorState[],
): MonitorState | null {
  return states.reduce<MonitorState | null>(
    (highest, candidate) =>
      highest === null ||
      (candidate.saturation ?? -1) > (highest.saturation ?? -1)
        ? candidate
        : highest,
    null,
  );
}

/**
 * Header ⓘ copy. Thresholds, windows, coverage and the poll interval come from
 * the package's own policy rather than the mockup's EUROP-specific numbers.
 */
export function alertRulesText(
  policy: PegAssetPackage["policy"],
  pollIntervalSeconds: number | null,
): string {
  const coverage = formatFraction(1 - policy.durationQuantile);
  const cadence =
    pollIntervalSeconds === null
      ? "Checks run on the monitor's configured schedule."
      : `Checks run every ${formatDuration(pollIntervalSeconds)}.`;
  return [
    cadence,
    `Warning: price ≥ ${formatWholeBps(policy.warnDeviationBps)} below target (or ≥ ${formatWholeBps(policy.premiumWarnBps)} above) for ${coverage} of checks over ${formatDuration(policy.warnSustainSeconds)} — alerts the team in Slack.`,
    `Critical page: ≥ ${formatWholeBps(policy.criticalDeviationBps)} below for ${formatDuration(policy.criticalSustainSeconds)} — pages the on-call engineer.`,
  ].join(" ");
}

/**
 * The payload exposes one saturation figure — the maximum across the pool's
 * 5-minute and 24-hour windows — so the header stays "Trading limit" and the
 * window identity moves into this tooltip.
 */
export function tradingLimitTooltip(warnFraction: number): string {
  return `Net inflow of the stablecoin into the pool as a fraction of its on-chain trading limit — the maximum across the pool's 5-minute and 24-hour windows. During a depeg, arbitrageurs buy the token cheaply off-chain and sell it into the pool at par — sustained one-way inflow means the pool is absorbing that flow and losing reserves. Warns at ${formatFraction(warnFraction)} of the limit.`;
}

export const SUPPORTING_MARKETS_TOOLTIP =
  "Supporting markets corroborate the primary market but carry no alert authority — peg status and alerts are computed only from the primary market's price. Hover each row's tag for why (thin depth, feed conversion).";

export function offScaleRailTooltip(
  distanceBps: number,
  direction: "below" | "above",
): string {
  return `This venue's price is ${formatDeviationBps(distanceBps)} ${direction} target — beyond the rail's alert scale, so the marker pins at the edge («). Red = off the peg range on that venue. Dashed = it still cannot trigger alerts.`;
}

export type SupportingRole = {
  tag: "DEPTH ONLY" | "DISPLAY ONLY";
  tooltip: string;
};

function displayOnlyTooltip(source: PegSource): string {
  const conversion = source.convertVia;
  if (conversion === null)
    return "Shown purely for context — it influences neither peg status nor alerts.";
  return `Quoted in ${conversion.fromCurrency} and converted to ${conversion.toCurrency} via the ${conversion.toCurrency}/${conversion.fromCurrency} feed. Shown purely for context — it influences neither peg status nor alerts.`;
}

const plainNumber = new Intl.NumberFormat("en-US");

function depthOnlyTooltip(source: PegSource): string {
  const venue = venueLabel(source).split(" ")[0] ?? source.provider;
  const thin =
    source.capped === true ||
    (source.filledFraction !== null && source.filledFraction < 1);
  if (thin && source.referenceSize !== null && source.filledFraction !== null)
    return `${venue}'s order book is too thin to absorb the ${plainNumber.format(source.referenceSize)} ${source.baseCurrency} test sale (only ~${formatFraction(source.filledFraction)} fills), so its price reflects missing liquidity rather than the peg. The monitor uses it only as evidence of market depth — it can never set peg status.`;
  return `${venue} is not the policy-selected venue for this peg, so its price reflects its own book rather than the peg. The monitor uses it only as evidence of market depth — it can never set peg status.`;
}

/** Supporting venues carry no alert authority; the tag says which kind. */
/**
 * Why a supporting venue's numbers cannot be shown, or null when they can.
 * Mirrors `sourceHasUnavailableEvidence` (the deleted evidence view's rule)
 * minus three conditions that are healthy-by-design for supporting venues:
 * `capped === true` and the null `deviationBps`/`premiumBps` that follow from
 * it — a DEPTH ONLY venue fills partially on purpose, carries its meaning in
 * the role tag, and still quotes a real executable price the rail can place.
 * When the package itself is stale, callers pass the confirmed time instead
 * of the browser clock so retained evidence does not expire mid-display.
 */
export function supportingSourceUnusableReason(
  source: PegSource,
  evidenceAtMs: number,
): string | null {
  if (!source.healthy) return "no healthy observation";
  if (source.listingState === "halted") return "listing halted";
  if (source.listingState === "absent") return "not listed on this venue";
  if (source.venueState === "halted") return "venue halted";
  if (source.observationAt === null || source.executablePrice === null)
    return "no current observation";
  if (
    evidenceAtMs - source.observationAt * 1_000 >
    source.policy.staleAfterSeconds * 1_000
  )
    return "check expired";
  return null;
}

export function supportingRole(source: PegSource): SupportingRole {
  return source.authority === "display" || source.convertVia !== null
    ? { tag: "DISPLAY ONLY", tooltip: displayOnlyTooltip(source) }
    : { tag: "DEPTH ONLY", tooltip: depthOnlyTooltip(source) };
}
