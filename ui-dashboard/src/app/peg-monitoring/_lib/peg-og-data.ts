// Server-only by convention (like lib/peg-monitoring-upstream.ts): reached
// only from this route's `opengraph-image`. Deliberately NOT using `import
// "server-only"` — that guard throws under the vitest environment.
import { unstable_cache } from "next/cache";
import { classifyPegMonitoringState } from "@/lib/peg-monitoring";
import {
  presentPegMonitoring,
  type PegAssetPresentation,
} from "@/lib/peg-monitoring-presentation";
import {
  fetchPegDecisionPackages,
  resolvePegMonitoringEndpoint,
} from "@/lib/peg-monitoring-upstream";
import type { PegMonitoringResponse } from "@/lib/peg-monitoring-schema";
import { formatAge, formatNumber, formatWholeBps } from "./peg-board-format";
import {
  boardSummary,
  boardTone,
  distanceLabel,
  headerAlertRules,
  monitorStates,
  pegPairLabel,
  railMarker,
  sortBoardRows,
  statusBadge,
  venueLabel,
  worstMonitor,
  type PegBoardTone,
  type RailMarker,
} from "./peg-board-model";

/**
 * Rows the card draws in full. Past this the row type shrinks below what
 * survives a Slack thumbnail, so extra pegs collapse into a counted line.
 * `sortBoardRows` puts the worst first, so the rows dropped are healthy ones.
 */
export const PEG_OG_MAX_ROWS = 4;

export type PegOgRow = {
  pair: string;
  price: string;
  distance: string;
  /** Position on the ±60 bps rail; null when no price could be measured. */
  marker: RailMarker | null;
  status: string;
  tone: PegBoardTone;
  /** Decision venue, e.g. `Bitvavo EUROP / EUR`; null when none is usable. */
  venue: string | null;
  spread: string | null;
  /** Worst circuit-breaker state across the peg's monitors. */
  breaker: { label: string; tone: PegBoardTone } | null;
  /**
   * This peg's own alert thresholds in bps, so the card labels the rail from
   * policy instead of asserting EUROP's numbers over every future peg.
   */
  thresholds: {
    downsideWarn: number;
    downsideCritical: number;
    premiumWarn: number;
  };
};

export type PegMonitoringOgData = {
  /** Header pill, e.g. `1 of 1 peg healthy` — the board's own wording. */
  summary: string;
  /**
   * The board's verdict qualifier ("latest data is stale") when it has one.
   * Kept out of `summary` because the pill is width-bound; the card prints it
   * in the footer instead of letting the pill run off the edge.
   */
  qualifier: string | null;
  tone: PegBoardTone;
  rows: PegOgRow[];
  /** Pegs left out of `rows` because the card ran out of room. */
  omittedCount: number;
  /** `Checks every 30s`, interpolated from the package's own poll policy. */
  cadence: string;
  /** Age of the decision package at render time, e.g. `12s`. */
  age: string;
  stale: boolean;
};

function toRow(asset: PegAssetPresentation, stale: boolean): PegOgRow {
  const source = asset.decisionSource;
  // Retained evidence keeps its confirmed structural result rather than
  // expiring against the render clock — the same rule the board table applies.
  const structuralCurrent = stale || asset.structuralEvidenceCurrent;
  const monitor = worstMonitor(monitorStates(asset, structuralCurrent, stale));
  return {
    pair: pegPairLabel(asset),
    price: formatNumber(source?.executablePrice ?? null),
    distance: distanceLabel(asset),
    marker: railMarker(asset.distanceBps, asset.direction),
    status: statusBadge(asset).label,
    tone: boardTone(asset),
    venue: source === null ? null : venueLabel(source),
    spread: source === null ? null : formatWholeBps(source.spreadBps),
    breaker:
      monitor === null
        ? null
        : { label: monitor.breaker.label, tone: monitor.breaker.tone },
    thresholds: {
      downsideWarn: asset.downsideWarningThresholdBps,
      downsideCritical: asset.downsideCriticalThresholdBps,
      premiumWarn: asset.premiumWarningThresholdBps,
    },
  };
}

/** @internal Exported for testing — skips the network and the cache wrapper. */
export function buildPegMonitoringOgData(
  data: PegMonitoringResponse,
  nowMs: number,
): PegMonitoringOgData {
  const state = classifyPegMonitoringState({
    data,
    hasError: false,
    isLoading: false,
    nowMs,
  });
  // `data` is non-null, so the classifier can only land on current | stale.
  const ageMs =
    state.kind === "current" || state.kind === "stale" ? state.ageMs : 0;
  const stale = state.kind === "stale";
  const presentation = presentPegMonitoring(data, {
    nowMs,
    packageIsStale: stale,
    usesPreviousPolicy:
      data.policySlot === "previous" ||
      data.producedPolicyVersion !== data.approvedActivePolicyVersion,
  });
  const ordered = sortBoardRows(presentation.assets);
  const summary = boardSummary(presentation);
  return {
    summary: summary.counts,
    qualifier: summary.qualifier,
    tone: summary.tone,
    rows: ordered.slice(0, PEG_OG_MAX_ROWS).map((asset) => toRow(asset, stale)),
    omittedCount: Math.max(0, ordered.length - PEG_OG_MAX_ROWS),
    cadence: headerAlertRules(presentation).cadence,
    age: formatAge(ageMs),
    stale,
  };
}

/** Upstream payload, or null for every failure the card renders the same way. */
async function fetchPegDecisionPackagesOrNull(): Promise<PegMonitoringResponse | null> {
  const result = await fetchPegDecisionPackages();
  return result.ok ? result.data : null;
}

/** @internal Exported for testing — skips the cache wrapper. */
export async function fetchPegMonitoringOgDataUncached(): Promise<PegMonitoringOgData | null> {
  const raw = await fetchPegDecisionPackagesOrNull();
  return raw === null ? null : buildPegMonitoringOgData(raw, Date.now());
}

// Caches the raw decision package, never the rendered card. `age`, `stale` and
// the classifier verdict all read a clock, so caching them would replay a
// package captured at 85s old as `stale: false` for another 60s of real age.
// The render below re-derives them from a fresh clock on every call.
//
// 60s TTL, matching the pool and homepage cards. Peg state can flip inside a
// single alert window, so an hour-long cache would keep serving "healthy"
// through a breach. This bounds the origin only — Slack caches its own unfurl
// per URL, so an old share can still show the state it was unfurled with.
//
// The resolved bridge origin is part of the key: where the deploy salt
// collapses to "dev", repointing `METRICS_BRIDGE_URL` must not keep serving
// the previous origin's packages. Keying on the resolved form stops a rejected
// value from churning the key.
const cachedFetch = unstable_cache(
  fetchPegDecisionPackagesOrNull,
  [
    "peg-monitoring-og",
    process.env.VERCEL_DEPLOYMENT_ID ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "dev",
    resolvePegMonitoringEndpoint(process.env.METRICS_BRIDGE_URL)?.origin ?? "",
  ],
  { revalidate: 60, tags: ["peg-monitoring-og"] },
);

export async function fetchPegMonitoringForMetadata(): Promise<PegMonitoringOgData | null> {
  const raw = await cachedFetch();
  return raw === null ? null : buildPegMonitoringOgData(raw, Date.now());
}
