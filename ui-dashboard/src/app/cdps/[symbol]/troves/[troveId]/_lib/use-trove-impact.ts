"use client";

// The impact panel's refetch-once state machine
// (docs/PLAN-trove-history-page.md, invariant 2: "Refetch instead of
// flagging on a mismatch"): a reconciliation mismatch at a matched watermark
// triggers ONE ledger revalidation — most mismatches are a transient read
// against an indexer mid-catch-up — and only a mismatch that survives that
// refetch renders the warning state. Everything else is a pass-through of
// the pure classification in `impact.ts`.

import { useEffect, useRef, useState } from "react";
import {
  classifyTroveRedemptionImpact,
  troveRedemptionCumulatives,
  type TroveRedemptionLedgerSums,
  type TroveRedemptionTotalsReason,
} from "./impact";
import type { TroveRedemptionCumulatives } from "./ledger";
import type { TroveLedgerState } from "./use-trove-ledger";

export type TroveRedemptionImpactModel =
  | {
      kind: "totals";
      reason: TroveRedemptionTotalsReason;
      cumulatives: TroveRedemptionCumulatives;
    }
  | {
      kind: "reconciled";
      sums: TroveRedemptionLedgerSums;
      cumulatives: TroveRedemptionCumulatives;
    }
  /** The doc-specified warning state: the mismatch survived one refetch.
   *  Cumulative totals still render (labeled as totals); every per-hit
   *  figure is withheld. */
  | { kind: "mismatch"; cumulatives: TroveRedemptionCumulatives };

/** One mismatch "episode" is keyed by the watermark pair that mismatched:
 *  a refetch that lands NEW data (different watermark) starts a fresh
 *  episode with its own single refetch, while a refetch that returns the
 *  same still-mismatching snapshot settles into the warning state. */
function mismatchEpisodeKey(ledger: TroveLedgerState): string | null {
  return ledger.watermark == null
    ? null
    : `${ledger.watermark.lastLedgerBlock}_${ledger.watermark.lastLedgerLogIndex}`;
}

export function useTroveRedemptionImpact(
  /** Header-query cumulatives — the display fallback while the ledger
   *  response (which carries its own same-snapshot copy) is unavailable. */
  trove: {
    redemptionCount: number;
    redeemedDebt: string;
    redeemedColl: string;
    redemptionFeePaidCum: string;
  },
  ledger: TroveLedgerState,
): TroveRedemptionImpactModel {
  const status = classifyTroveRedemptionImpact(ledger);
  const rawMismatch = status.kind === "mismatch";
  const episodeKey = mismatchEpisodeKey(ledger);
  // Synchronous in-flight guard (AGENTS.md async-mutation rule): the effect
  // below can re-run (poll re-renders, StrictMode double-invoke) while the
  // refetch promise is still pending, and only ONE refetch per episode may
  // fire. `settledEpisode` is state, not a ref, because settling must
  // re-render: the refetch can resolve to the identical (still mismatching)
  // response, which changes nothing else.
  // Keyed PER EPISODE, not one replaceable slot: an out-of-order stale
  // response can flip the cache back to an earlier watermark, and a single
  // shared key would then re-fire that episode's refetch (violating
  // once-per-episode) or let one episode's settle mask another's. Bounded:
  // one entry per distinct mismatching watermark seen this mount.
  const attemptedEpisodes = useRef<Set<string>>(new Set());
  const [settledEpisodes, setSettledEpisodes] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const refetch = ledger.refetch;

  useEffect(() => {
    if (!rawMismatch || episodeKey == null) return;
    if (attemptedEpisodes.current.has(episodeKey)) return;
    attemptedEpisodes.current.add(episodeKey);
    void refetch()
      // Defensive: SWR's bound mutate routes fetcher errors to the error
      // channel and resolves, but a rejection would otherwise hang this
      // episode in "unverified" forever — it still consumed the one
      // attempt, so settle either way.
      .catch(() => {})
      .then(() => {
        setSettledEpisodes((previous) => {
          const next = new Set(previous);
          next.add(episodeKey);
          return next;
        });
      });
  }, [rawMismatch, episodeKey, refetch]);

  // Display cumulatives: prefer the ledger response's same-snapshot copy;
  // fall back to the header trove's (partial view, ledger not loaded).
  const cumulatives = ledger.cumulatives ?? troveRedemptionCumulatives(trove);

  if (status.kind === "reconciled") {
    return { kind: "reconciled", sums: status.sums, cumulatives };
  }
  if (status.kind === "mismatch") {
    // While the one refetch is still in flight the mismatch is not yet
    // "persistent" — render the neutral unverified totals, not the warning.
    return episodeKey != null && settledEpisodes.has(episodeKey)
      ? { kind: "mismatch", cumulatives }
      : { kind: "totals", reason: "unverified", cumulatives };
  }
  return { kind: "totals", reason: status.reason, cumulatives };
}
