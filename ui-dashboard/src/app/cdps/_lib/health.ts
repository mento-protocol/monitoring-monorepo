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
  totalDebt: bigint;
  totalColl: bigint;
  /** true when the upstream trove query hit its row cap — totals/count are
   * floors, not the real population. Renders refuse to compute SP coverage
   * (health → "unknown") and tiles show `≥` prefixes. */
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

export function aggregateTroves(
  troves: readonly Pick<CdpTroveListRow, "status" | "debt" | "coll">[],
  options: { truncated?: boolean } = {},
): CdpAggregates {
  let openTroveCount = 0;
  let totalDebt = BigInt(0);
  let totalColl = BigInt(0);
  for (const trove of troves) {
    if (!isOpenTroveStatus(trove.status)) continue;
    openTroveCount += 1;
    totalDebt += BigInt(trove.debt);
    totalColl += BigInt(trove.coll);
  }
  return {
    openTroveCount,
    totalDebt,
    totalColl,
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
 */
export function deriveCdpHealth(
  collateral: CdpCollateral,
  instance: CdpInstance | undefined,
  aggregates: CdpAggregates,
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
  if (aggregates.truncated) {
    // We don't know real total debt → can't reason about SP coverage
    // without misclassifying borderline-healthy markets as critical.
    return {
      state: "unknown",
      label: "Unknown",
      reasons: ["Trove list truncated at row cap — totals are floors"],
    };
  }

  const reasons: string[] = [];
  let worst: CdpHealthState = "healthy";
  const escalate = (next: CdpHealthState, reason: string) => {
    if (rank(next) > rank(worst)) worst = next;
    reasons.push(reason);
  };

  const debt = aggregates.totalDebt;
  const spDeposits = BigInt(instance.spDeposits);

  if (debt > BigInt(0)) {
    if (spDeposits === BigInt(0)) {
      escalate("critical", "Stability Pool is empty — no liquidation buffer");
    } else {
      const pctBps = Number((spDeposits * BigInt(10_000)) / debt);
      const coveragePct = `${(pctBps / 100).toFixed(1)}% of debt`;
      if (pctBps < 500) {
        escalate("critical", `Stability Pool covers ${coveragePct}`);
      } else if (pctBps < 5_000) {
        escalate("warning", `Stability Pool covers ${coveragePct}`);
      }
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
