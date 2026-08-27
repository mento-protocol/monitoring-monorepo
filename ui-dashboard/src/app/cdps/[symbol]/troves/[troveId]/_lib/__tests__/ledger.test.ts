import { describe, expect, it } from "vitest";
import { BADGE_LABELS } from "../../../../../_lib/transactions";
import { paginateTroveOperations } from "../params";
import {
  buildTroveLedgerDisplayRows,
  CDP_TROVE_LEDGER_RENDER_LIMIT,
  CDP_TROVE_LEDGER_REQUEST_LIMIT,
  CdpTroveLedgerSchema,
  hasCompleteDebtSnapshots,
  ledgerBadgeKindFor,
  ledgerBadgeLabel,
  resolveLedgerWatermark,
  sortTroveLedgerRowsDesc,
  supportsTroveLedger,
  totalLedgerCollChange,
  totalLedgerDebtChange,
  troveLedgerStatusFlip,
  type CdpTroveLedgerEventRow,
} from "../ledger";

const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function ledgerRow(
  overrides: Partial<CdpTroveLedgerEventRow> = {},
): CdpTroveLedgerEventRow {
  return {
    id: "42220_100_1",
    operation: 2,
    collChange: "0",
    debtChange: "0",
    debtIncreaseFromUpfrontFee: "0",
    debtIncreaseFromRedist: "0",
    collIncreaseFromRedist: "0",
    annualInterestRate: "0",
    debtBefore: wei(1_000),
    debtAfter: wei(1_000),
    collBefore: wei(500),
    collAfter: wei(500),
    statusBefore: "active",
    statusAfter: "active",
    redemptionFeeCredited: null,
    isRebalance: null,
    redemptionPrice: null,
    priceAtEvent: null,
    icrAfterBps: null,
    timestamp: "1000",
    blockNumber: "100",
    logIndex: 1,
    txHash: "0xtx",
    ...overrides,
  };
}

describe("supportsTroveLedger (introspection gate)", () => {
  const troveFieldsWithWatermark = {
    fields: [
      { name: "id" },
      { name: "lastLedgerBlock" },
      { name: "lastLedgerLogIndex" },
    ],
  };

  it("opens only when the entity AND both Trove watermark columns are live", () => {
    expect(
      supportsTroveLedger({
        TroveType: troveFieldsWithWatermark,
        TroveLedgerEventType: { fields: [{ name: "id" }] },
      }),
    ).toBe(true);
  });

  it("fails closed while the probe has not resolved", () => {
    expect(supportsTroveLedger(undefined)).toBe(false);
  });

  it("fails closed when the entity is absent from the live schema", () => {
    expect(
      supportsTroveLedger({
        TroveType: troveFieldsWithWatermark,
        TroveLedgerEventType: null,
      }),
    ).toBe(false);
    // A pre-rollout probe response that predates the alias entirely.
    expect(supportsTroveLedger({ TroveType: troveFieldsWithWatermark })).toBe(
      false,
    );
  });

  it("fails closed when the entity exists but the Trove watermark columns lag", () => {
    // Half-promoted schema: the gated query selects the watermark columns,
    // so firing it would fail the whole request at parse time.
    expect(
      supportsTroveLedger({
        TroveType: { fields: [{ name: "id" }, { name: "lastLedgerBlock" }] },
        TroveLedgerEventType: { fields: [{ name: "id" }] },
      }),
    ).toBe(false);
    expect(
      supportsTroveLedger({
        TroveType: null,
        TroveLedgerEventType: { fields: [{ name: "id" }] },
      }),
    ).toBe(false);
  });
});

describe("sortTroveLedgerRowsDesc", () => {
  it("orders by the numeric triple, never by the unpadded string id", () => {
    // Same block, log indexes 9 and 10: as STRINGS "..._9" > "..._10", the
    // wrong chronology. The numeric triple must win.
    const rows = [
      ledgerRow({ id: "42220_100_9", timestamp: "1000", logIndex: 9 }),
      ledgerRow({ id: "42220_100_10", timestamp: "1000", logIndex: 10 }),
      ledgerRow({
        id: "42220_99_5",
        timestamp: "900",
        blockNumber: "99",
        logIndex: 5,
      }),
      ledgerRow({
        // Same timestamp as block 100 but a later block: block wins the tie.
        id: "42220_101_0",
        timestamp: "1000",
        blockNumber: "101",
        logIndex: 0,
      }),
    ];
    const sorted = sortTroveLedgerRowsDesc(rows);
    expect(sorted.map((row) => row.id)).toEqual([
      "42220_101_0",
      "42220_100_10",
      "42220_100_9",
      "42220_99_5",
    ]);
    // Immutable: the input array is untouched.
    expect(rows[0]!.id).toBe("42220_100_9");
  });
});

describe("truncation sentinel exactness (shared paginate helper)", () => {
  it("a history of exactly the render limit is complete", () => {
    const rows = Array.from({ length: CDP_TROVE_LEDGER_RENDER_LIMIT }, (_, i) =>
      ledgerRow({ id: `42220_${9_999 - i}_0`, timestamp: String(9_999 - i) }),
    );
    const page = paginateTroveOperations(rows, CDP_TROVE_LEDGER_RENDER_LIMIT);
    expect(page.truncated).toBe(false);
    expect(page.rows).toHaveLength(CDP_TROVE_LEDGER_RENDER_LIMIT);
  });

  it("the limit+1 sentinel marks truncation and drops the OLDEST row", () => {
    const rows = Array.from(
      { length: CDP_TROVE_LEDGER_REQUEST_LIMIT },
      (_, i) =>
        ledgerRow({ id: `42220_${9_999 - i}_0`, timestamp: String(9_999 - i) }),
    );
    const page = paginateTroveOperations(rows, CDP_TROVE_LEDGER_RENDER_LIMIT);
    expect(page.truncated).toBe(true);
    expect(page.rows).toHaveLength(CDP_TROVE_LEDGER_RENDER_LIMIT);
    // Oldest-first display; the dropped sentinel was the OLDEST (last of
    // the desc fetch), so the newest row survives at the end.
    expect(page.rows[page.rows.length - 1]!.timestamp).toBe("9999");
    expect(page.rows.some((row) => row.timestamp === String(9_999 - 999))).toBe(
      false,
    );
  });

  it("keeps the render limit one below the Hasura hard cap", () => {
    expect(CDP_TROVE_LEDGER_RENDER_LIMIT).toBe(999);
    expect(CDP_TROVE_LEDGER_REQUEST_LIMIT).toBe(1000);
  });
});

describe("ledger badge vocabulary — all ten operation ordinals", () => {
  it.each([
    [0, "Open Trove"],
    [1, "Close Trove"],
    [2, "Adjust Trove"],
    [3, "Change Interest Rate"],
    [4, "Apply Pending Debt"],
    [5, "Liquidation"],
    [7, "Open & Join Batch"],
    [8, "Joined Batch"],
    [9, "Left Batch"],
  ])("op %i renders as %s", (operation, label) => {
    const kind = ledgerBadgeKindFor({ operation, isRebalance: null });
    expect(ledgerBadgeLabel(kind, operation)).toBe(label);
  });

  it("op 6 discriminates rebalance vs user redemptions via isRebalance", () => {
    expect(ledgerBadgeKindFor({ operation: 6, isRebalance: true })).toBe(
      "rebalanceRedemption",
    );
    expect(ledgerBadgeKindFor({ operation: 6, isRebalance: false })).toBe(
      "userRedemption",
    );
    // Undiscriminated rows get the NEUTRAL "Redemption" label — never a
    // rebalance claim the data doesn't back.
    expect(ledgerBadgeKindFor({ operation: 6, isRebalance: null })).toBe(
      "userRedemption",
    );
    expect(BADGE_LABELS.userRedemption).toBe("Redemption");
  });

  it("op 4 styles with the interest kind (its on-chain sibling) but keeps its own label", () => {
    expect(ledgerBadgeKindFor({ operation: 4, isRebalance: null })).toBe(
      "interest",
    );
  });
});

describe("troveLedgerStatusFlip", () => {
  it("suppresses the pre-open placeholder flip on open rows (ops 0 and 7)", () => {
    for (const operation of [0, 7]) {
      expect(
        troveLedgerStatusFlip({
          operation,
          statusBefore: "closed",
          statusAfter: "active",
        }),
      ).toBeNull();
    }
  });

  it("returns null when nothing flipped", () => {
    expect(
      troveLedgerStatusFlip({
        operation: 2,
        statusBefore: "active",
        statusAfter: "active",
      }),
    ).toBeNull();
  });

  it("styles a flip into zombie with the zombie kind", () => {
    expect(
      troveLedgerStatusFlip({
        operation: 6,
        statusBefore: "active",
        statusAfter: "zombie",
      }),
    ).toEqual({ text: "active → zombie", kind: "zombie" });
  });

  it("styles zombie → active as revived", () => {
    expect(
      troveLedgerStatusFlip({
        operation: 2,
        statusBefore: "zombie",
        statusAfter: "active",
      }),
    ).toEqual({ text: "zombie → active", kind: "revived" });
  });

  it("renders other flips as plain text (the op badge tells that story)", () => {
    expect(
      troveLedgerStatusFlip({
        operation: 5,
        statusBefore: "active",
        statusAfter: "liquidated",
      }),
    ).toEqual({ text: "active → liquidated", kind: null });
  });
});

describe("row delta totals", () => {
  it("Δ debt folds the fee and redist terms so before + Δ = after exactly", () => {
    const row = ledgerRow({
      debtChange: wei(500),
      debtIncreaseFromUpfrontFee: wei(3),
      debtIncreaseFromRedist: wei(7),
      debtBefore: wei(1_000),
      debtAfter: wei(1_510),
    });
    expect(totalLedgerDebtChange(row)).toBe(wei(510));
    expect(
      (BigInt(row.debtBefore!) + BigInt(totalLedgerDebtChange(row))).toString(),
    ).toBe(row.debtAfter);
  });

  it("Δ coll folds the redist term (the credited fee is already netted by the writer)", () => {
    const row = ledgerRow({
      collChange: `-${wei(200)}`,
      collIncreaseFromRedist: wei(1),
      collBefore: wei(500),
      collAfter: wei(301),
    });
    expect(totalLedgerCollChange(row)).toBe(`-${wei(199)}`);
    expect(
      (BigInt(row.collBefore) + BigInt(totalLedgerCollChange(row))).toString(),
    ).toBe(row.collAfter);
  });
});

describe("buildTroveLedgerDisplayRows — interest residual", () => {
  it("synthesizes a labeled estimate row for non-zero elapsed interest", () => {
    const open = ledgerRow({
      id: "42220_100_1",
      operation: 0,
      debtChange: wei(1_000),
      debtIncreaseFromUpfrontFee: wei(12),
      debtBefore: "0",
      debtAfter: wei(1_012),
      timestamp: "1000",
    });
    // Days later: debtBefore folds 10 of accrued interest in (post-accrual
    // snapshots), so the residual falls BETWEEN the rows.
    const adjust = ledgerRow({
      id: "42220_200_1",
      operation: 2,
      debtChange: wei(500),
      debtBefore: wei(1_022),
      debtAfter: wei(1_522),
      timestamp: "900000",
      blockNumber: "200",
    });
    const rows = buildTroveLedgerDisplayRows([open, adjust], {
      synthesizeInterest: true,
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ kind: "event", row: open });
    expect(rows[1]).toEqual({
      kind: "interest",
      id: "interest-42220_200_1",
      timestamp: "900000",
      amount: wei(10),
    });
    expect(rows[2]).toEqual({ kind: "event", row: adjust });
  });

  it("synthesizes nothing for zero elapsed interest (same-block ops)", () => {
    const first = ledgerRow({
      id: "42220_100_1",
      debtAfter: wei(1_000),
    });
    const second = ledgerRow({
      id: "42220_100_2",
      logIndex: 2,
      debtChange: wei(100),
      debtBefore: wei(1_000),
      debtAfter: wei(1_100),
    });
    const rows = buildTroveLedgerDisplayRows([first, second], {
      synthesizeInterest: true,
    });
    expect(rows.every((row) => row.kind === "event")).toBe(true);
  });

  it("skips synthesis across null batch-row debt snapshots", () => {
    const first = ledgerRow({ id: "42220_100_1", debtAfter: wei(1_000) });
    const batch = ledgerRow({
      id: "42220_200_1",
      operation: 8,
      debtBefore: null,
      debtAfter: null,
      timestamp: "2000",
      blockNumber: "200",
    });
    const later = ledgerRow({
      id: "42220_300_1",
      debtBefore: wei(1_050),
      debtAfter: wei(1_050),
      timestamp: "3000",
      blockNumber: "300",
    });
    const rows = buildTroveLedgerDisplayRows([first, batch, later], {
      synthesizeInterest: true,
    });
    expect(rows.every((row) => row.kind === "event")).toBe(true);
  });

  it("skips a negative residual — an estimate row must not paper over inconsistent snapshots", () => {
    const first = ledgerRow({ id: "42220_100_1", debtAfter: wei(1_000) });
    const second = ledgerRow({
      id: "42220_200_1",
      debtChange: "0",
      debtBefore: wei(990),
      debtAfter: wei(990),
      timestamp: "2000",
      blockNumber: "200",
    });
    const rows = buildTroveLedgerDisplayRows([first, second], {
      synthesizeInterest: true,
    });
    expect(rows.every((row) => row.kind === "event")).toBe(true);
  });

  it("synthesizes nothing when the derivation gate is closed (partial/truncated ledger)", () => {
    const open = ledgerRow({ id: "42220_100_1", debtAfter: wei(1_000) });
    const later = ledgerRow({
      id: "42220_200_1",
      debtBefore: wei(1_010),
      debtAfter: wei(1_010),
      timestamp: "2000",
      blockNumber: "200",
    });
    const rows = buildTroveLedgerDisplayRows([open, later], {
      synthesizeInterest: false,
    });
    expect(rows.every((row) => row.kind === "event")).toBe(true);
  });
});

describe("hasCompleteDebtSnapshots", () => {
  it("is true only when every row carries both snapshots", () => {
    expect(hasCompleteDebtSnapshots([ledgerRow()])).toBe(true);
    expect(
      hasCompleteDebtSnapshots([ledgerRow(), ledgerRow({ debtBefore: null })]),
    ).toBe(false);
    expect(hasCompleteDebtSnapshots([ledgerRow({ debtAfter: null })])).toBe(
      false,
    );
    expect(hasCompleteDebtSnapshots([])).toBe(true);
  });
});

describe("resolveLedgerWatermark", () => {
  it("extracts the watermark pair from the gated response", () => {
    expect(
      resolveLedgerWatermark({
        LedgerWatermark: [{ lastLedgerBlock: "300", lastLedgerLogIndex: 2 }],
        TroveLedgerEvent: [],
      }),
    ).toEqual({ lastLedgerBlock: "300", lastLedgerLogIndex: 2 });
  });

  it("is null while unresolved or when the trove itself is not indexed", () => {
    expect(resolveLedgerWatermark(undefined)).toBeNull();
    expect(
      resolveLedgerWatermark({ LedgerWatermark: [], TroveLedgerEvent: [] }),
    ).toBeNull();
  });
});

describe("CdpTroveLedgerSchema (rollout drift guard)", () => {
  it("accepts the shape the query selects", () => {
    const result = CdpTroveLedgerSchema.safeParse({
      LedgerWatermark: [{ lastLedgerBlock: "0", lastLedgerLogIndex: 0 }],
      TroveLedgerEvent: [ledgerRow()],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a drifted response instead of feeding it to BigInt arithmetic", () => {
    const drifted = {
      LedgerWatermark: [],
      TroveLedgerEvent: [{ ...ledgerRow(), debtChange: 5 }],
    };
    expect(CdpTroveLedgerSchema.safeParse(drifted).success).toBe(false);
    expect(
      CdpTroveLedgerSchema.safeParse({ TroveLedgerEvent: [] }).success,
    ).toBe(false);
  });
});
