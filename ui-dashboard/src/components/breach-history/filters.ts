/**
 * Pure filter helpers and label maps for the BreachHistoryPanel. Contains
 * `whereForBucket` (translates a DurationBucket preset into a Hasura where
 * clause), `composeWhere` (composes the bucket clause with optional min/max
 * numeric-seconds filters from the free-text inputs), and the
 * `START_REASON_LABELS` / `END_REASON_LABELS` display maps used to label
 * breach rows and populate the client-side search blob. No React imports;
 * this module is pure data and can be imported from both server and client
 * components.
 */

import type { BreachEventCategory } from "@/lib/types";
import { SECONDS_PER_HOUR, SECONDS_PER_DAY } from "@/lib/time-series";
import type { DurationBucket } from "@/components/breach-history/bucket-filter";

export const END_REASON_LABELS: Record<BreachEventCategory, string> = {
  rebalance: "Rebalanced",
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  threshold_change: "Threshold changed",
  unknown: "Unknown",
};

export const START_REASON_LABELS: Record<BreachEventCategory, string> = {
  rebalance: "Rebalance (reverse)",
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  threshold_change: "Threshold change",
  unknown: "Unknown",
};

export function whereForBucket(
  bucket: DurationBucket,
): Record<string, unknown> {
  switch (bucket) {
    case "all":
      return {};
    case "in_grace":
      // Closed breaches that actually closed within the 1h grace window.
      // Filter on duration, not `criticalDurationSeconds == 0`: under the
      // tolerance refactor, `criticalDurationSeconds` is also zero for
      // multi-hour breaches whose peak never crossed 1.05x — those are
      // long WARN-only breaches and don't belong in the "≤1h" bucket.
      return {
        endedAt: { _is_null: false },
        durationSeconds: { _lte: String(SECONDS_PER_HOUR) },
      };
    case "short":
      return {
        endedAt: { _is_null: false },
        durationSeconds: {
          _gt: String(SECONDS_PER_HOUR),
          _lte: String(SECONDS_PER_DAY),
        },
      };
    case "long":
      return {
        endedAt: { _is_null: false },
        durationSeconds: { _gt: String(SECONDS_PER_DAY) },
      };
    case "ongoing":
      return { endedAt: { _is_null: true } };
  }
}

/**
 * Compose the bucket clause with optional numeric min/max filters. The
 * min/max values come from free-text inputs the user types (`1h`, `3
 * days`, etc.); they compose with the bucket via `_and` so "Over 1d +
 * min: 7d" narrows to breaches strictly over a week. Applied only when
 * non-null so an empty input doesn't pin everything to "≥0s".
 *
 * Open breaches have NULL `durationSeconds` until they close, so a naive
 * `durationSeconds >= min` predicate would drop every in-flight
 * incident. We OR the range against `durationSeconds IS NULL` so
 * ongoing rows stay visible regardless of the numeric filter — hiding
 * an active incident behind a filter is the worst-case UX here.
 */
export function composeWhere(
  bucket: DurationBucket,
  minSeconds: number | null,
  maxSeconds: number | null,
): Record<string, unknown> {
  const bucketClause = whereForBucket(bucket);
  if (minSeconds == null && maxSeconds == null) return bucketClause;

  const durationRange: Record<string, unknown> = {};
  if (minSeconds != null) durationRange._gte = String(minSeconds);
  if (maxSeconds != null) durationRange._lte = String(maxSeconds);

  const durationOr = {
    _or: [
      { durationSeconds: durationRange },
      { durationSeconds: { _is_null: true } },
    ],
  };

  // Hasura tolerates an empty object on one side of _and, so this is safe
  // even when `bucket === "all"` (bucketClause === {}).
  return { _and: [bucketClause, durationOr] };
}
