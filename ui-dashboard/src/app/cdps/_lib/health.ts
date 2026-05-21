import { CDP_TROVE_OPEN_STATUSES } from "./types";
import type {
  CdpCollateral,
  CdpInstance,
  CdpTroveListRow,
  CdpTroveOpenStatus,
} from "./types";

export type CdpHealthState =
  | "healthy"
  | "warning"
  | "critical"
  | "shutdown"
  | "unknown";

export type CdpHealth = {
  state: CdpHealthState;
  label: string;
  reasons: string[];
};

export type CdpAggregates = {
  openTroveCount: number;
  /** true when the upstream trove query hit its row cap — `openTroveCount`
   * is a floor, not the real population. The borrower-count tile prefixes
   * `≥` to signal undercounting. systemDebt/systemColl come from
   * `LiquityInstance` directly so health derivation is unaffected. */
  truncated: boolean;
};

const OPEN_STATUS_SET: ReadonlySet<string> = new Set<string>(
  CDP_TROVE_OPEN_STATUSES,
);

export function isOpenTroveStatus(
  status: string,
): status is CdpTroveOpenStatus {
  return OPEN_STATUS_SET.has(status);
}

const EMPTY_AGGREGATES: CdpAggregates = {
  openTroveCount: 0,
  truncated: false,
};

/** List-page lookup: returns the per-collateral aggregate, or an empty
 * aggregate that preserves the chain-wide query's truncation flag. The
 * truncated propagation is load-bearing — without it, a collateral whose
 * troves were entirely pushed past the row cap renders as 0 open troves
 * instead of `≥ 0`. */
export function aggregatesForCollateral(
  collateralId: string,
  aggregatesByCollateral: ReadonlyMap<string, CdpAggregates>,
  queryTruncated: boolean,
): CdpAggregates {
  return (
    aggregatesByCollateral.get(collateralId) ??
    (queryTruncated
      ? { ...EMPTY_AGGREGATES, truncated: true }
      : EMPTY_AGGREGATES)
  );
}

export function aggregateTroves(
  troves: readonly Pick<CdpTroveListRow, "status">[],
  options: { truncated?: boolean } = {},
): CdpAggregates {
  let openTroveCount = 0;
  for (const trove of troves) {
    if (isOpenTroveStatus(trove.status)) openTroveCount += 1;
  }
  return {
    openTroveCount,
    truncated: options.truncated ?? false,
  };
}

/**
 * Health state machine for a CDP market.
 *
 * Signals available today (others — TCR/ICR percentiles — are stubbed to -1
 * in the indexer and intentionally ignored):
 *  • Shutdown flag                         → terminal "shutdown"
 *  • SP coverage = spDeposits / systemDebt → empty/<5% critical, <50% warning
 *
 * `systemParamsLoaded` is informational only — when it's false we just tag
 * the reasons list. SP-empty + outstanding debt is critical regardless of
 * whether MCR/CCR are loaded.
 *
 * `instance.systemDebt` is the delta-tracked sum of open-trove debts
 * maintained by `applySystemDebtDelta` in the indexer (commit 026c629), so
 * coverage ratios are computed straight from indexed state without the
 * client-side trove-list aggregation we used to do.
 */
export function deriveCdpHealth(
  collateral: CdpCollateral,
  instance: CdpInstance | undefined,
): CdpHealth {
  if (instance?.isShutDown) {
    return {
      state: "shutdown",
      label: "Shutdown",
      reasons: ["Market is shut down"],
    };
  }
  if (instance == null) {
    return {
      state: "unknown",
      label: "Unknown",
      reasons: ["No indexed state"],
    };
  }

  const debt = BigInt(instance.systemDebt);
  const spDeposits = BigInt(instance.spDeposits);

  if (debt > BigInt(0) && spDeposits === BigInt(0)) {
    const reasons = ["Stability Pool is empty — no liquidation buffer"];
    if (!collateral.systemParamsLoaded) {
      reasons.push("System params not yet loaded");
    }
    return { state: "critical", label: "Critical", reasons };
  }

  const reasons: string[] = [];
  let worst: CdpHealthState = "healthy";
  const escalate = (next: CdpHealthState, reason: string) => {
    if (rank(next) > rank(worst)) worst = next;
    reasons.push(reason);
  };

  if (debt > BigInt(0)) {
    const pctBps = Number((spDeposits * BigInt(10_000)) / debt);
    const coveragePct = `${(pctBps / 100).toFixed(1)}% of debt`;
    if (pctBps < 500) {
      escalate("critical", `Stability Pool covers ${coveragePct}`);
    } else if (pctBps < 5_000) {
      escalate("warning", `Stability Pool covers ${coveragePct}`);
    }
  } else if (spDeposits === BigInt(0)) {
    // No debt and no SP — informational, not unhealthy.
    reasons.push("No outstanding debt");
  }

  if (!collateral.systemParamsLoaded) {
    reasons.push("System params not yet loaded");
  }

  return { state: worst, label: stateLabel(worst), reasons };
}

const STATES: Record<
  CdpHealthState,
  { rank: number; label: string; classes: string }
> = {
  healthy: {
    rank: 0,
    label: "Healthy",
    classes:
      "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-700/40",
  },
  unknown: {
    rank: 1,
    label: "Unknown",
    classes:
      "bg-slate-500/15 text-slate-400 ring-1 ring-inset ring-slate-700/40",
  },
  warning: {
    rank: 2,
    label: "Warning",
    classes:
      "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-700/40",
  },
  critical: {
    rank: 3,
    label: "Critical",
    classes: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-700/40",
  },
  shutdown: {
    rank: 4,
    label: "Shutdown",
    classes:
      "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-700/40",
  },
};

function rank(state: CdpHealthState): number {
  return STATES[state].rank;
}

function stateLabel(state: CdpHealthState): string {
  return STATES[state].label;
}

export function healthBadgeClasses(state: CdpHealthState): string {
  return STATES[state].classes;
}
