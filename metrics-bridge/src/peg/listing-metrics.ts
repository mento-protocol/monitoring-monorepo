import { Gauge } from "prom-client";
import { register } from "../metrics.js";
import { PEG_POLICY_MAX_LISTING_ABSENT_CONSECUTIVE_CHECKS } from "./policy.js";
import { MARKET_STATES, type MarketState } from "./types.js";

const sourceLabels = ["asset", "source", "policy_version"] as const;
const listingStateLabels = [...sourceLabels, "state"] as const;

type SourceLabels = {
  asset: string;
  source: string;
  policy_version: string;
};

type ListingEvidence = {
  listingState: MarketState | null;
  listingCheckedAt: number | null;
  listingAbsentConsecutiveChecks: number;
};

export const pegListingGauges = {
  listingState: new Gauge({
    name: "mento_peg_listing_state",
    help: "One-hot last authoritative exact-pair provider listing state.",
    labelNames: listingStateLabels,
    registers: [register],
  }),
  listingCheckedAt: new Gauge({
    name: "mento_peg_listing_checked_at",
    help: "Unix timestamp of the last successful authoritative exact-pair listing response; transport and schema failures do not advance it.",
    labelNames: sourceLabels,
    registers: [register],
  }),
  listingAbsentConsecutiveChecks: new Gauge({
    name: "mento_peg_listing_absent_consecutive_checks",
    help: "Consecutive accepted authoritative exact-pair absent listing checks, reset by listed or halted evidence and saturated at the approved policy threshold.",
    labelNames: sourceLabels,
    registers: [register],
  }),
} as const;

function assertFiniteNonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
}

export function validateListingEvidence(source: ListingEvidence): void {
  if ((source.listingState == null) !== (source.listingCheckedAt == null)) {
    throw new Error(
      "listingState and listingCheckedAt must both be present or null",
    );
  }
  if (source.listingCheckedAt !== null) {
    assertFiniteNonnegative(source.listingCheckedAt, "listingCheckedAt");
  }
  validateListingAbsenceStreak(source);
}

function validateListingAbsenceStreak(source: ListingEvidence): void {
  assertFiniteNonnegative(
    source.listingAbsentConsecutiveChecks,
    "listingAbsentConsecutiveChecks",
  );
  if (
    !Number.isInteger(source.listingAbsentConsecutiveChecks) ||
    source.listingAbsentConsecutiveChecks >
      PEG_POLICY_MAX_LISTING_ABSENT_CONSECUTIVE_CHECKS
  ) {
    throw new Error(
      `listingAbsentConsecutiveChecks must be an integer no greater than ${PEG_POLICY_MAX_LISTING_ABSENT_CONSECUTIVE_CHECKS}`,
    );
  }
  if (
    (source.listingState === null &&
      source.listingAbsentConsecutiveChecks !== 0) ||
    ((source.listingState === "listed" || source.listingState === "halted") &&
      source.listingAbsentConsecutiveChecks !== 0) ||
    (source.listingState === "absent" &&
      source.listingAbsentConsecutiveChecks < 1)
  ) {
    throw new Error(
      "listingAbsentConsecutiveChecks must match the paired listing state",
    );
  }
}

export function publishListingGauges(
  labels: SourceLabels,
  source: ListingEvidence,
): void {
  if (source.listingState === null || source.listingCheckedAt === null) return;
  for (const state of MARKET_STATES) {
    pegListingGauges.listingState.set(
      { ...labels, state },
      state === source.listingState ? 1 : 0,
    );
  }
  pegListingGauges.listingCheckedAt.set(
    labels,
    source.listingCheckedAt / 1_000,
  );
  pegListingGauges.listingAbsentConsecutiveChecks.set(
    labels,
    source.listingAbsentConsecutiveChecks,
  );
}
