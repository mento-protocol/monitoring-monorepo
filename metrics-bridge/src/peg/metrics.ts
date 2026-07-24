import { Counter, Gauge } from "prom-client";
import { register } from "../metrics.js";
import { PEG_POLICY_MAX_BLIND_CONSECUTIVE_POLLS } from "./policy.js";
import type { PegObservation } from "./types.js";

const sourceLabels = ["asset", "source", "policy_version"] as const;
const venueStateLabels = [...sourceLabels, "state"] as const;
const assetLabels = ["asset", "policy_version"] as const;
const policyLabels = ["policy_version"] as const;
const errorLabels = ["kind"] as const;

type SourceLabels = {
  asset: string;
  source: string;
  policy_version: string;
};

export interface PegSourceMetricSnapshot {
  asset: string;
  source: string;
  policyVersion: string;
  healthy: boolean;
  observation: PegObservation | null;
  referenceSize: number;
  deviationBps: number | null;
  premiumBps: number | null;
  spreadBps: number | null;
  newSuccess: boolean;
  newUsableDecision: boolean;
}

export interface PegAssetMetricSnapshot {
  asset: string;
  policyVersion: string;
  lastPollAt: number;
  blind: boolean;
  blindConsecutivePolls: number;
  structuralSaturation: number | null;
  structuralQuerySaturated: boolean;
  indexedPoolReachable: boolean;
  counterpartyCount: number;
  sources: PegSourceMetricSnapshot[];
}

export const pegGauges = {
  deviationBps: new Gauge({
    name: "mento_peg_deviation_bps",
    help: "Downside executable-sell-price shortfall from the approved peg target, in basis points. Capped observations are absent.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  premiumBps: new Gauge({
    name: "mento_peg_premium_bps",
    help: "Executable-sell-price premium above the approved peg target, in basis points. Informational and warning-tier only.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  executablePrice: new Gauge({
    name: "mento_peg_executable_px",
    help: "Executable sell VWAP in peg-currency units at the approved reference size; partial capped VWAPs remain visible.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  referenceSize: new Gauge({
    name: "mento_peg_reference_size",
    help: "Approved executable-sell reference size after applying the positive enforced FPMM limit bound.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  filledFraction: new Gauge({
    name: "mento_peg_filled_fraction",
    help: "Fraction of the approved reference size filled by visible bids, from 0 to 1.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  capped: new Gauge({
    name: "mento_peg_capped",
    help: "1 when visible bids cannot fill the approved reference size; capped observations never feed deviation paging.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  bid: new Gauge({
    name: "mento_peg_bid",
    help: "Best visible bid in peg-currency units.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  ask: new Gauge({
    name: "mento_peg_ask",
    help: "Best visible ask in peg-currency units.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  spreadBps: new Gauge({
    name: "mento_peg_spread_bps",
    help: "Top-of-book spread in basis points relative to the midpoint.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  venueState: new Gauge({
    name: "mento_peg_venue_state",
    help: "One-hot current bounded venue state.",
    labelNames: venueStateLabels,
    registers: [register],
  }),
  sourceHealthy: new Gauge({
    name: "mento_peg_source_healthy",
    help: "1 when the source returned fresh usable venue data under the labeled policy version, 0 otherwise.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  observationAt: new Gauge({
    name: "mento_peg_observation_at",
    help: "Unix timestamp of the last authoritative venue timestamp or newly observed sequence; HTTP success alone never advances it.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  lastTradeAt: new Gauge({
    name: "mento_peg_last_trade_at",
    help: "Unix timestamp of the venue's latest reported trade when available.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  blind: new Gauge({
    name: "mento_peg_blind",
    help: "1 when the policy-designated deep venue has no usable uncapped executable price.",
    labelNames: assetLabels,
    registers: [register],
  }),
  blindConsecutivePolls: new Gauge({
    name: "mento_peg_blind_consecutive_polls",
    help: "Consecutive due policy-designated deep-venue cadence slots with no new usable uncapped executable decision, saturated at the approved policy threshold.",
    labelNames: assetLabels,
    registers: [register],
  }),
  structuralSaturation: new Gauge({
    name: "mento_peg_structural_saturation",
    help: "Maximum live positive monitored-token FPMM netflow fraction across active enforced windows.",
    labelNames: assetLabels,
    registers: [register],
  }),
  structuralQuerySaturated: new Gauge({
    name: "mento_peg_structural_query_saturated",
    help: "1 when the bounded 1000-row SwapEvent companion query filled its page and may be incomplete.",
    labelNames: assetLabels,
    registers: [register],
  }),
  indexedPoolReachable: new Gauge({
    name: "mento_peg_indexed_pool_reachable",
    help: "1 when the registry-bound pool and monitored-token trading limit resolve through Hasura.",
    labelNames: assetLabels,
    registers: [register],
  }),
  counterpartyCount: new Gauge({
    name: "mento_peg_counterparty_count",
    help: "Advisory unique SwapEvent caller count in the bounded structural page; never a paging input.",
    labelNames: assetLabels,
    registers: [register],
  }),
  lastPoll: new Gauge({
    name: "mento_peg_last_poll",
    help: "Unix timestamp when the isolated peg loop last completed this asset's poll attempt.",
    labelNames: assetLabels,
    registers: [register],
  }),
  policyVersion: new Gauge({
    name: "mento_peg_policy_version",
    help: "Producer acknowledgment of the policy version used for every version-labeled peg measurement.",
    labelNames: policyLabels,
    registers: [register],
  }),
} as const;

export const pegCounters = {
  pollSuccess: new Counter({
    name: "mento_peg_poll_success_total",
    help: "Monotonic count of source polls that advanced an authoritative venue timestamp or sequence.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  usableDecision: new Counter({
    name: "mento_peg_usable_decision_total",
    help: "Monotonic count of newly accepted uncapped executable price decisions.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  pollErrors: new Counter({
    name: "mento_peg_poll_errors_total",
    help: "Bounded peg-loop failures by stable error channel; peg failures never affect the primary bridge health signal.",
    labelNames: errorLabels,
    registers: [register],
  }),
} as const;

const activeSourceCounterLabels = new Map<string, SourceLabels>();

function assertFiniteNonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
}

function validateObservation(observation: PegObservation): void {
  assertFiniteNonnegative(observation.filledFraction, "filledFraction");
  if (observation.filledFraction > 1) {
    throw new Error("filledFraction must not exceed 1");
  }
  if (observation.vwap !== null) {
    assertFiniteNonnegative(observation.vwap, "vwap");
  }
  const hasObservationAt = observation.observationAt !== null;
  const hasSequence = observation.sequence !== null;
  if (hasObservationAt !== hasSequence) {
    throw new Error("observationAt and sequence must both be present or null");
  }
  if (!hasObservationAt && observation.venueState !== "halted") {
    throw new Error(
      "only a status-only halted observation may omit provider identity",
    );
  }
  if (observation.observationAt !== null) {
    assertFiniteNonnegative(observation.observationAt, "observationAt");
  }
  assertFiniteNonnegative(observation.fetchedAt, "fetchedAt");
}

function validateStatusOnlyHalt(source: PegSourceMetricSnapshot): void {
  const observation = source.observation;
  if (observation === null || observation.observationAt !== null) return;
  if ([source.healthy, source.newSuccess].some(Boolean)) {
    throw new Error(
      "status-only halted observations cannot be healthy or advance poll success",
    );
  }
  const carriesDecision = [
    source.deviationBps,
    source.premiumBps,
    source.spreadBps,
  ].some((value) => value !== null);
  if (carriesDecision) {
    throw new Error(
      "status-only halted observations cannot publish executable price decisions",
    );
  }
  const carriesVenueData = [
    observation.vwap,
    observation.bid,
    observation.ask,
    observation.lastTradeAt,
  ].some((value) => value !== null);
  const carriesExecutableShape = [
    carriesVenueData,
    observation.filledFraction !== 0,
    !observation.capped,
  ].some(Boolean);
  if (carriesExecutableShape) {
    throw new Error(
      "status-only halted observations cannot carry executable book or trade data",
    );
  }
}

function validateUsableDecision(source: PegSourceMetricSnapshot): void {
  const observation = source.observation;
  const vwap = observation?.vwap ?? Number.NaN;
  const acceptedUsableDecision = [
    source.newSuccess,
    source.healthy,
    source.deviationBps !== null,
    source.premiumBps !== null,
    observation !== null,
    observation?.venueState !== "halted",
    observation?.capped === false,
    Number.isFinite(vwap),
    vwap > 0,
  ].every(Boolean);
  if (source.newUsableDecision !== acceptedUsableDecision) {
    throw new Error(
      "newUsableDecision must match a newly accepted uncapped executable observation",
    );
  }
}

function validateSourceSnapshot(
  snapshot: PegAssetMetricSnapshot,
  source: PegSourceMetricSnapshot,
): void {
  if (
    source.asset !== snapshot.asset ||
    source.policyVersion !== snapshot.policyVersion
  ) {
    throw new Error("Peg source labels must match their asset snapshot");
  }
  assertFiniteNonnegative(source.referenceSize, "referenceSize");
  if (source.referenceSize === 0) {
    throw new Error("referenceSize must be positive");
  }
  if (source.deviationBps !== null) {
    assertFiniteNonnegative(source.deviationBps, "deviationBps");
  }
  if (source.premiumBps !== null) {
    assertFiniteNonnegative(source.premiumBps, "premiumBps");
  }
  if (source.spreadBps !== null) {
    assertFiniteNonnegative(source.spreadBps, "spreadBps");
  }
  if (source.observation !== null) {
    validateObservation(source.observation);
    validateStatusOnlyHalt(source);
  }
  validateUsableDecision(source);
}

function validateSnapshots(snapshots: PegAssetMetricSnapshot[]): void {
  const assets = new Set<string>();
  const sources = new Set<string>();
  for (const snapshot of snapshots) {
    const assetKey = `${snapshot.policyVersion}:${snapshot.asset}`;
    if (assets.has(assetKey))
      throw new Error(`Duplicate peg asset: ${assetKey}`);
    assets.add(assetKey);
    assertFiniteNonnegative(snapshot.lastPollAt, "lastPollAt");
    assertFiniteNonnegative(
      snapshot.blindConsecutivePolls,
      "blindConsecutivePolls",
    );
    if (
      !Number.isInteger(snapshot.blindConsecutivePolls) ||
      snapshot.blindConsecutivePolls > PEG_POLICY_MAX_BLIND_CONSECUTIVE_POLLS
    ) {
      throw new Error(
        `blindConsecutivePolls must be an integer no greater than ${PEG_POLICY_MAX_BLIND_CONSECUTIVE_POLLS}`,
      );
    }
    assertFiniteNonnegative(snapshot.counterpartyCount, "counterpartyCount");
    if (snapshot.structuralSaturation !== null) {
      assertFiniteNonnegative(
        snapshot.structuralSaturation,
        "structuralSaturation",
      );
    }
    for (const source of snapshot.sources) {
      const sourceKey = `${assetKey}:${source.source}`;
      if (sources.has(sourceKey)) {
        throw new Error(`Duplicate peg source: ${sourceKey}`);
      }
      sources.add(sourceKey);
      validateSourceSnapshot(snapshot, source);
    }
  }
}

function resetPegGauges(): void {
  for (const gauge of Object.values(pegGauges)) gauge.reset();
}

function sourceCounterKey(labels: SourceLabels): string {
  return `${labels.policy_version}\u0000${labels.asset}\u0000${labels.source}`;
}

function pruneSourceCounters(snapshots: PegAssetMetricSnapshot[]): void {
  // Empty batches are failed cycles: clear gauges below, but keep historical
  // counters. A non-empty batch retires only absent content-addressed versions;
  // source topology cannot change within a version, so source omission is
  // transient rather than label retirement.
  if (snapshots.length === 0) return;

  const publishedVersions = new Set(
    snapshots.map(({ policyVersion }) => policyVersion),
  );
  for (const [key, labels] of activeSourceCounterLabels) {
    if (publishedVersions.has(labels.policy_version)) continue;
    pegCounters.pollSuccess.remove(labels);
    pegCounters.usableDecision.remove(labels);
    activeSourceCounterLabels.delete(key);
  }

  for (const snapshot of snapshots) {
    for (const source of snapshot.sources) {
      const labels = {
        asset: source.asset,
        source: source.source,
        policy_version: source.policyVersion,
      };
      activeSourceCounterLabels.set(sourceCounterKey(labels), labels);
    }
  }
}

function unixMillisecondsToSeconds(timestamp: number): number {
  return timestamp / 1_000;
}

function publishObservation(
  labels: SourceLabels,
  observation: PegObservation,
): void {
  pegGauges.filledFraction.set(labels, observation.filledFraction);
  pegGauges.capped.set(labels, observation.capped ? 1 : 0);
  if (observation.observationAt !== null) {
    pegGauges.observationAt.set(
      labels,
      unixMillisecondsToSeconds(observation.observationAt),
    );
  }
  pegGauges.venueState.set({ ...labels, state: observation.venueState }, 1);
  if (observation.vwap !== null) {
    pegGauges.executablePrice.set(labels, observation.vwap);
  }
  if (observation.bid !== null) pegGauges.bid.set(labels, observation.bid);
  if (observation.ask !== null) pegGauges.ask.set(labels, observation.ask);
  if (observation.lastTradeAt !== null) {
    pegGauges.lastTradeAt.set(
      labels,
      unixMillisecondsToSeconds(observation.lastTradeAt),
    );
  }
}

function publishSource(source: PegSourceMetricSnapshot): void {
  const labels = {
    asset: source.asset,
    source: source.source,
    policy_version: source.policyVersion,
  };
  pegGauges.sourceHealthy.set(labels, source.healthy ? 1 : 0);
  pegGauges.referenceSize.set(labels, source.referenceSize);
  if (source.deviationBps !== null) {
    pegGauges.deviationBps.set(labels, source.deviationBps);
  }
  if (source.premiumBps !== null) {
    pegGauges.premiumBps.set(labels, source.premiumBps);
  }
  if (source.spreadBps !== null) {
    pegGauges.spreadBps.set(labels, source.spreadBps);
  }
  if (source.observation !== null)
    publishObservation(labels, source.observation);
  if (source.newSuccess) pegCounters.pollSuccess.inc(labels);
  if (source.newUsableDecision) pegCounters.usableDecision.inc(labels);
}

function publishAsset(snapshot: PegAssetMetricSnapshot): void {
  const labels = {
    asset: snapshot.asset,
    policy_version: snapshot.policyVersion,
  };
  pegGauges.blind.set(labels, snapshot.blind ? 1 : 0);
  pegGauges.blindConsecutivePolls.set(labels, snapshot.blindConsecutivePolls);
  pegGauges.structuralQuerySaturated.set(
    labels,
    snapshot.structuralQuerySaturated ? 1 : 0,
  );
  pegGauges.indexedPoolReachable.set(
    labels,
    snapshot.indexedPoolReachable ? 1 : 0,
  );
  pegGauges.counterpartyCount.set(labels, snapshot.counterpartyCount);
  pegGauges.lastPoll.set(labels, snapshot.lastPollAt);
  if (snapshot.structuralSaturation !== null) {
    pegGauges.structuralSaturation.set(labels, snapshot.structuralSaturation);
  }
  snapshot.sources.forEach(publishSource);
}

export function publishPegMetrics(snapshots: PegAssetMetricSnapshot[]): void {
  validateSnapshots(snapshots);
  pruneSourceCounters(snapshots);
  resetPegGauges();
  const versions = new Set<string>();
  for (const snapshot of snapshots) {
    versions.add(snapshot.policyVersion);
    publishAsset(snapshot);
  }
  for (const policyVersion of versions) {
    pegGauges.policyVersion.set({ policy_version: policyVersion }, 1);
  }
}

/** @internal Test-only reset. Production counters remain monotonic. */
export function _resetPegMetricsForTests(): void {
  resetPegGauges();
  pegCounters.pollSuccess.reset();
  pegCounters.usableDecision.reset();
  pegCounters.pollErrors.reset();
  activeSourceCounterLabels.clear();
}
