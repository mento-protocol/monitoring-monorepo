export type TroveLedgerProbeState =
  | "unresolved"
  | "check-failed"
  | "stale"
  | "checked";

/** Classifies the schema probe without changing its fail-closed gate.
 *  Cached data remains the last confirmed answer after a refresh error. */
export function classifyTroveLedgerProbe(
  data: unknown,
  error: unknown,
): TroveLedgerProbeState {
  if (data == null) return error == null ? "unresolved" : "check-failed";
  return error == null ? "checked" : "stale";
}

/** Copy for the interim operations view while the schema gate is closed. */
export function troveLedgerInterimProbeMessage(
  state: TroveLedgerProbeState,
  hasLifetimeTotals: boolean,
): string {
  switch (state) {
    case "unresolved":
      return "Checking complete-history availability — showing the interim view while the check completes. Per-redemption detail cannot be confirmed yet.";
    case "check-failed":
      return "The complete-history availability check failed — showing the interim view while it retries automatically. Per-redemption detail may exist but cannot be confirmed right now.";
    case "stale":
      return "The complete-history availability check could not refresh — showing the interim view from the last confirmed schema answer while it retries automatically. Per-redemption detail may now exist but cannot be confirmed.";
    case "checked":
      return `Per-redemption detail pending indexer rollout — this list shows only this trove's own borrow/repay/adjust operations. Redemptions and liquidations that touched this trove are not yet attributable here${hasLifetimeTotals ? "; see the redemption impact totals above." : "."}`;
  }
}

/** Copy for a stale cached-supported answer. Fresh supported answers need no
 *  availability notice. */
export function troveLedgerSupportedProbeMessage(
  state: TroveLedgerProbeState,
): string | null {
  if (state !== "stale") return null;
  return "The complete-history availability check could not refresh — using the last confirmed available result while it retries automatically.";
}

/** Copy appended to the impact card's cumulative-only description. */
export function troveLedgerImpactPartialMessage(
  state: TroveLedgerProbeState,
): string {
  switch (state) {
    case "unresolved":
      return "Checking complete-history availability before per-hit detail can be enabled.";
    case "check-failed":
      return "The complete-history availability check failed, so per-hit detail cannot be confirmed right now.";
    case "stale":
      return "The complete-history availability check could not refresh, so per-hit detail remains off under the last confirmed schema answer while it retries automatically.";
    case "checked":
      return "Per-hit detail — the user vs rebalance split and the oracle-price valuation — is pending indexer rollout.";
  }
}
