import type { PegSourceMetricSnapshot } from "./metrics.js";
import type { PegPollSourceState } from "./poll-cycle.js";
import type { PegObservation } from "./types.js";
import { setPegFailure, type PegFailureEvidence } from "./failure-reasons.js";

interface PegSourceSnapshotInput {
  assetId: string;
  target: number;
  sourceId: string;
  policyVersion: string;
}

export interface PegSourceSnapshotContent {
  referenceSize: number | null;
  observation: PegObservation | null;
  newSuccess: boolean;
}

function priceMovement(
  observation: PegObservation | null,
  target: number,
): Pick<PegSourceMetricSnapshot, "deviationBps" | "premiumBps"> {
  if (
    observation === null ||
    observation.venueState === "halted" ||
    observation.capped ||
    observation.vwap === null ||
    !Number.isFinite(observation.vwap) ||
    observation.vwap <= 0
  ) {
    return { deviationBps: null, premiumBps: null };
  }
  return {
    deviationBps: Math.max(0, ((target - observation.vwap) / target) * 10_000),
    premiumBps: Math.max(0, ((observation.vwap - target) / target) * 10_000),
  };
}

function spreadBps(observation: PegObservation | null): number | null {
  if (
    observation === null ||
    observation.bid === null ||
    observation.ask === null
  ) {
    return null;
  }
  const midpoint = (observation.bid + observation.ask) / 2;
  const spread = ((observation.ask - observation.bid) / midpoint) * 10_000;
  return midpoint > 0 && Number.isFinite(spread) && spread >= 0 ? spread : null;
}

function inherentFailure(
  state: PegPollSourceState,
  observation: PegObservation | null,
): PegFailureEvidence | null {
  if (state.listingState === "absent") {
    return { reason: "market_unlisted", httpStatus: null };
  }
  if (state.listingState === "halted" || observation?.venueState === "halted") {
    return { reason: "market_halted", httpStatus: null };
  }
  if (observation?.capped || observation?.vwap === null) {
    return { reason: "insufficient_liquidity", httpStatus: null };
  }
  return null;
}

export function createPegSourceMetricSnapshot(
  input: PegSourceSnapshotInput,
  state: PegPollSourceState,
  content: PegSourceSnapshotContent,
): PegSourceMetricSnapshot {
  const { referenceSize, observation, newSuccess } = content;
  const movement = priceMovement(observation, input.target);
  const failure = inherentFailure(state, observation);
  // Preserve a failure from the current poll. Listing and liquidity state only
  // supply a cause when the poll did not already record a more direct one.
  if (failure !== null && state.failureReason === null) {
    setPegFailure(state, failure);
  }
  return {
    asset: input.assetId,
    source: input.sourceId,
    policyVersion: input.policyVersion,
    healthy:
      observation !== null &&
      observation.venueState !== "halted" &&
      observation.observationAt !== null &&
      observation.sequence !== null,
    observation,
    referenceSize,
    listingState: state.listingState,
    listingCheckedAt: state.listingCheckedAt,
    listingAbsentConsecutiveChecks: state.listingAbsentConsecutiveChecks,
    ...movement,
    spreadBps: spreadBps(observation),
    newSuccess,
    newUsableDecision:
      newSuccess &&
      movement.deviationBps !== null &&
      movement.premiumBps !== null,
    failureReason: state.failureReason,
    failureHttpStatus: state.failureHttpStatus,
  };
}
