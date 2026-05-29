import { describe, expect, it } from "vitest";
import {
  amountsFor,
  badgeKindFor,
  indexSnapshotsById,
  mergeTransactionRows,
  troveSnapshotFor,
  type CdpTransactionsResponse,
} from "./transactions";
import type {
  CdpTransactionRow,
  CdpTroveOperationEventRow,
  CdpTroveOpSnapshotRow,
} from "./types";

// Minimal row factories — only the fields each function actually reads.
function liquidationRow(
  overrides: Partial<CdpTransactionRow> = {},
): CdpTransactionRow {
  return {
    kind: "liquidation",
    id: "liq-1",
    timestamp: "1000",
    debtOffsetBySP: "100",
    debtRedistributed: "0",
    boldGasCompensation: "5",
    collSentToSP: "200",
    collRedistributed: "0",
    collGasCompensation: "10",
    collSurplus: "0",
    ...overrides,
  } as unknown as CdpTransactionRow;
}

function redemptionRow(isRebalance = false): CdpTransactionRow {
  return {
    kind: "redemption",
    id: "red-1",
    timestamp: "900",
    isRebalance,
    actualBoldAmount: "300",
    ETHSent: "150",
  } as unknown as CdpTransactionRow;
}

function spRebalanceRow(): CdpTransactionRow {
  return {
    kind: "spRebalance",
    id: "sp-1",
    timestamp: "800",
    amountStableOut: "50",
    amountCollIn: "25",
  } as unknown as CdpTransactionRow;
}

function troveOpBadgeRow(operation: number): CdpTransactionRow {
  return {
    kind: "troveOp",
    id: "op-1",
    timestamp: "700",
    operation,
    debtChange: "100",
    collChange: "-50",
  } as unknown as CdpTransactionRow;
}

describe("badgeKindFor", () => {
  it("returns 'liquidation' for liquidation rows", () => {
    expect(badgeKindFor(liquidationRow())).toBe("liquidation");
  });

  it("returns 'spRebalance' for spRebalance rows", () => {
    expect(badgeKindFor(spRebalanceRow())).toBe("spRebalance");
  });

  it("returns 'userRedemption' for non-rebalance redemptions", () => {
    expect(badgeKindFor(redemptionRow(false))).toBe("userRedemption");
  });

  it("returns 'rebalanceRedemption' for rebalance redemptions", () => {
    expect(badgeKindFor(redemptionRow(true))).toBe("rebalanceRedemption");
  });

  it("maps trove operation numbers to badge kinds", () => {
    expect(badgeKindFor(troveOpBadgeRow(0))).toBe("troveOpen");
    expect(badgeKindFor(troveOpBadgeRow(1))).toBe("troveClose");
    expect(badgeKindFor(troveOpBadgeRow(2))).toBe("troveAdjust");
    expect(badgeKindFor(troveOpBadgeRow(3))).toBe("troveInterestRateChange");
    expect(badgeKindFor(troveOpBadgeRow(8))).toBe("troveBatch");
    // Unknown op → fallback
    expect(badgeKindFor(troveOpBadgeRow(99))).toBe("troveAdjust");
  });
});

describe("amountsFor", () => {
  it("sums all debt/coll fields for liquidations", () => {
    const row = liquidationRow();
    const { debt, coll } = amountsFor(row);
    expect(debt).toBe("105"); // 100 + 0 + 5
    expect(coll).toBe("210"); // 200 + 0 + 10
  });

  it("returns actualBoldAmount / ETHSent for redemptions", () => {
    const { debt, coll } = amountsFor(redemptionRow());
    expect(debt).toBe("300");
    expect(coll).toBe("150");
  });

  it("returns amountStableOut / amountCollIn for spRebalance", () => {
    const { debt, coll } = amountsFor(spRebalanceRow());
    expect(debt).toBe("50");
    expect(coll).toBe("25");
  });

  it("returns debtChange / collChange for troveOp", () => {
    const { debt, coll } = amountsFor(troveOpBadgeRow(0));
    expect(debt).toBe("100");
    expect(coll).toBe("-50");
  });
});

describe("mergeTransactionRows", () => {
  it("returns empty rows when data is undefined", () => {
    expect(mergeTransactionRows(undefined)).toEqual({
      rows: [],
      capped: false,
    });
  });

  it("merges all event arrays sorted by timestamp desc", () => {
    const data: CdpTransactionsResponse = {
      LiquidationEvent: [liquidationRow({ timestamp: "1000" }) as never],
      RedemptionEvent: [redemptionRow() as never], // timestamp 900
      SpRebalanceEvent: [spRebalanceRow() as never], // timestamp 800
      TroveOperationEvent: [troveOpBadgeRow(0) as never], // timestamp 700
    };
    const { rows, capped } = mergeTransactionRows(data);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.timestamp).toBe("1000");
    expect(rows[3]!.timestamp).toBe("700");
    expect(capped).toBe(false);
  });

  it("sets capped=true when any array length meets the limit", () => {
    const data: CdpTransactionsResponse = {
      LiquidationEvent: [
        liquidationRow() as never,
        liquidationRow({ id: "liq-2" }) as never,
      ],
      RedemptionEvent: [],
      SpRebalanceEvent: [],
      TroveOperationEvent: [],
    };
    const { capped } = mergeTransactionRows(data, 2);
    expect(capped).toBe(true);
  });
});

// --- troveSnapshotFor / indexSnapshotsById tests (from PR #489) ---

const baseTroveOp: CdpTroveOperationEventRow = {
  id: "evt-1",
  instanceId: "inst-1",
  troveId: "trove-1",
  operation: 2,
  collChange: "0",
  debtChange: "0",
  annualInterestRate: "0",
  debtIncreaseFromUpfrontFee: "0",
  timestamp: "1000",
  blockNumber: "1",
  txHash: "0xabc",
};

const baseSnapshot: CdpTroveOpSnapshotRow = {
  id: "evt-1",
  owner: "0xowner",
  debtBefore: "5000",
  debtAfter: "4000",
  collBefore: "2000",
  collAfter: "1800",
};

function fullTroveOpRow(): CdpTransactionRow {
  return { kind: "troveOp", ...baseTroveOp };
}

describe("troveSnapshotFor", () => {
  it("returns null for non-troveOp rows (no per-trove dimension)", () => {
    const fullLiquidationRow: CdpTransactionRow = {
      kind: "liquidation",
      id: "liq-1",
      debtOffsetBySP: "0",
      debtRedistributed: "0",
      boldGasCompensation: "0",
      collGasCompensation: "0",
      collSentToSP: "0",
      collRedistributed: "0",
      collSurplus: "0",
      priceAtLiquidation: "0",
      timestamp: "1000",
      blockNumber: "1",
      txHash: "0xabc",
    };
    expect(troveSnapshotFor(fullLiquidationRow, baseSnapshot)).toBeNull();
  });

  it("returns null when the snapshot is undefined (isolated query not resolved)", () => {
    expect(troveSnapshotFor(fullTroveOpRow(), undefined)).toBeNull();
  });

  it("returns null when any snapshot field is null (partial backfill window)", () => {
    const fields: (keyof CdpTroveOpSnapshotRow)[] = [
      "debtBefore",
      "debtAfter",
      "collBefore",
      "collAfter",
    ];
    for (const f of fields) {
      const partial = { ...baseSnapshot, [f]: null as unknown as string };
      expect(troveSnapshotFor(fullTroveOpRow(), partial)).toBeNull();
    }
  });

  it("computes the signed delta as after - before for both legs", () => {
    const snap = troveSnapshotFor(fullTroveOpRow(), baseSnapshot);
    if (snap == null) throw new Error("expected resolved snapshot");
    expect(snap.debt.before).toBe("5000");
    expect(snap.debt.after).toBe("4000");
    expect(snap.debt.delta).toBe("-1000");
    expect(snap.coll.before).toBe("2000");
    expect(snap.coll.after).toBe("1800");
    expect(snap.coll.delta).toBe("-200");
  });

  it("renders a positive delta when after > before (deposit / borrow)", () => {
    const snap = troveSnapshotFor(fullTroveOpRow(), {
      ...baseSnapshot,
      debtBefore: "1000",
      debtAfter: "2500",
      collBefore: "500",
      collAfter: "800",
    });
    if (snap == null) throw new Error("expected resolved snapshot");
    expect(snap.debt.delta).toBe("1500");
    expect(snap.coll.delta).toBe("300");
  });

  it("returns a zero delta when before equals after (no-op interest-rate change)", () => {
    const snap = troveSnapshotFor(fullTroveOpRow(), {
      ...baseSnapshot,
      debtBefore: "1000",
      debtAfter: "1000",
      collBefore: "500",
      collAfter: "500",
    });
    if (snap == null) throw new Error("expected resolved snapshot");
    expect(snap.debt.delta).toBe("0");
    expect(snap.coll.delta).toBe("0");
  });
});

describe("indexSnapshotsById", () => {
  it("returns an empty map for undefined data (loading / errored isolated query)", () => {
    expect(indexSnapshotsById(undefined).size).toBe(0);
  });

  it("returns an empty map when the array is empty", () => {
    expect(indexSnapshotsById({ TroveOperationEvent: [] }).size).toBe(0);
  });

  it("indexes by event id so the table can do O(1) lookups", () => {
    const a = { ...baseSnapshot, id: "a" };
    const b = { ...baseSnapshot, id: "b" };
    const map = indexSnapshotsById({ TroveOperationEvent: [a, b] });
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(a);
    expect(map.get("b")).toBe(b);
    expect(map.get("c")).toBeUndefined();
  });
});
