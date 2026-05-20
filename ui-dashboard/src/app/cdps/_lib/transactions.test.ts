import { describe, expect, it } from "vitest";
import { indexSnapshotsById, troveSnapshotFor } from "./transactions";
import type {
  CdpTransactionRow,
  CdpTroveOpSnapshotRow,
  CdpTroveOperationEventRow,
} from "./types";

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

function troveOpRow(): CdpTransactionRow {
  return { kind: "troveOp", ...baseTroveOp };
}

describe("troveSnapshotFor", () => {
  it("returns null for non-troveOp rows (no per-trove dimension)", () => {
    const liquidationRow: CdpTransactionRow = {
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
    expect(troveSnapshotFor(liquidationRow, baseSnapshot)).toBeNull();
  });

  it("returns null when the snapshot is undefined (isolated query not resolved)", () => {
    expect(troveSnapshotFor(troveOpRow(), undefined)).toBeNull();
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
      expect(troveSnapshotFor(troveOpRow(), partial)).toBeNull();
    }
  });

  it("computes the signed delta as after - before for both legs", () => {
    const snap = troveSnapshotFor(troveOpRow(), baseSnapshot);
    if (snap == null) throw new Error("expected resolved snapshot");
    expect(snap.debt.before).toBe("5000");
    expect(snap.debt.after).toBe("4000");
    expect(snap.debt.delta).toBe("-1000");
    expect(snap.coll.before).toBe("2000");
    expect(snap.coll.after).toBe("1800");
    expect(snap.coll.delta).toBe("-200");
  });

  it("renders a positive delta when after > before (deposit / borrow)", () => {
    const snap = troveSnapshotFor(troveOpRow(), {
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
    const snap = troveSnapshotFor(troveOpRow(), {
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
