import type { CdpCollateral, CdpInstance, CdpTroveListRow } from "./types";

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
};

export function aggregateTroves(
  troves: readonly Pick<CdpTroveListRow, "status" | "debt" | "coll">[],
): CdpAggregates {
  let openTroveCount = 0;
  let totalDebt = BigInt(0);
  let totalColl = BigInt(0);
  for (const trove of troves) {
    if (trove.status !== "active" && trove.status !== "zombie") continue;
    openTroveCount += 1;
    totalDebt += BigInt(trove.debt);
    totalColl += BigInt(trove.coll);
  }
  return { openTroveCount, totalDebt, totalColl };
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
      // pct in basis points: (spDeposits / debt) * 10000
      const pctBps = Number((spDeposits * BigInt(10_000)) / debt);
      if (pctBps < 500) {
        escalate(
          "critical",
          `Stability Pool covers ${(pctBps / 100).toFixed(1)}% of debt`,
        );
      } else if (pctBps < 5_000) {
        escalate(
          "warning",
          `Stability Pool covers ${(pctBps / 100).toFixed(1)}% of debt`,
        );
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

const RANK: Record<CdpHealthState, number> = {
  healthy: 0,
  unknown: 1,
  warning: 2,
  critical: 3,
  shutdown: 4,
};

function rank(state: CdpHealthState): number {
  return RANK[state];
}

function stateLabel(state: CdpHealthState): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "critical":
      return "Critical";
    case "shutdown":
      return "Shutdown";
    case "unknown":
      return "Unknown";
  }
}

export function healthBadgeClasses(state: CdpHealthState): string {
  switch (state) {
    case "healthy":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-700/40";
    case "warning":
      return "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-700/40";
    case "critical":
      return "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-700/40";
    case "shutdown":
      return "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-700/40";
    case "unknown":
      return "bg-slate-500/15 text-slate-400 ring-1 ring-inset ring-slate-700/40";
  }
}
