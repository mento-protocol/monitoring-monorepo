import { describe, expect, it } from "vitest";
import {
  classifyTroveRedemptionImpact,
  reconcileTroveRedemptions,
  sumTroveRedemptionRows,
  troveRedemptionCumulatives,
} from "../impact";
import {
  ledgerWatermarkMatchesNewestRow,
  type CdpTroveLedgerEventRow,
  type TroveLedgerAnchorRow,
  type TroveRedemptionCumulatives,
} from "../ledger";

const D18 = BigInt(10) ** BigInt(18);

/** Whole-or-2dp token amounts to wei strings. */
function wei(amount: number): string {
  return ((BigInt(Math.round(amount * 100)) * D18) / BigInt(100)).toString();
}

function row(
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

/** An op-6 hit with self-consistent raw deltas. `price` is the D18
 *  debt-per-collateral rate (the same orientation the indexer's ICR math
 *  uses). */
function hit(
  overrides: Partial<CdpTroveLedgerEventRow> = {},
): CdpTroveLedgerEventRow {
  return row({
    operation: 6,
    isRebalance: true,
    debtChange: `-${wei(400)}`,
    collChange: `-${wei(500)}`,
    redemptionFeeCredited: wei(2),
    // 0.8 debt per collateral: 400 debt is worth 500 collateral.
    redemptionPrice: ((BigInt(8) * D18) / BigInt(10)).toString(),
    ...overrides,
  });
}

function cumulatives(
  overrides: Partial<TroveRedemptionCumulatives> = {},
): TroveRedemptionCumulatives {
  return {
    redemptionCount: 1,
    redeemedDebt: wei(400),
    redeemedColl: wei(500),
    redemptionFeePaidCum: wei(2),
    ...overrides,
  };
}

function anchor(
  overrides: Partial<TroveLedgerAnchorRow> = {},
): TroveLedgerAnchorRow {
  return {
    lastLedgerBlock: "100",
    lastLedgerLogIndex: 1,
    ...cumulatives(),
    ...overrides,
  };
}

function classifyArgs(
  overrides: Partial<Parameters<typeof classifyTroveRedemptionImpact>[0]> = {},
) {
  const watermark = anchor();
  return {
    supported: true,
    hasLoadedOnce: true,
    truncated: false,
    debtSnapshotsComplete: true,
    rows: [hit()],
    watermark,
    cumulatives: watermark,
    ...overrides,
  };
}

describe("sumTroveRedemptionRows", () => {
  it("sums the RAW op-6 deltas — the terms the cumulative counters accumulate — and ignores every other op", () => {
    const sums = sumTroveRedemptionRows([
      row({ operation: 0, debtChange: wei(1_000) }),
      hit(),
      hit({
        id: "42220_101_1",
        isRebalance: false,
        debtChange: `-${wei(100)}`,
        collChange: `-${wei(125)}`,
        redemptionFeeCredited: wei(1),
      }),
      row({ operation: 2, debtChange: `-${wei(50)}` }),
    ]);
    expect(sums.count).toBe(2);
    expect(sums.debt).toBe(wei(500));
    expect(sums.coll).toBe(wei(625));
    expect(sums.fees).toBe(wei(3));
    expect(sums.rebalanceCount).toBe(1);
    expect(sums.rebalanceDebt).toBe(wei(400));
    expect(sums.rebalanceColl).toBe(wei(500));
    expect(sums.undiscriminatedCount).toBe(0);
  });

  it("computes net equity per hit at that hit's own redemptionPrice", () => {
    // Hit 1: 400 debt at 0.8 → worth 500 coll; 500 coll taken → Δ 0.
    // Hit 2: 100 debt at 0.5 → worth 200 coll; 125 coll taken → Δ +75.
    const sums = sumTroveRedemptionRows([
      hit(),
      hit({
        id: "42220_101_1",
        debtChange: `-${wei(100)}`,
        collChange: `-${wei(125)}`,
        redemptionPrice: ((BigInt(5) * D18) / BigInt(10)).toString(),
      }),
    ]);
    expect(sums.netEquity).toBe(wei(75));
  });

  it("suppresses net equity when ANY hit lacks its oracle price — never a partial or current-rate valuation", () => {
    const sums = sumTroveRedemptionRows([
      hit(),
      hit({ id: "42220_101_1", redemptionPrice: null }),
    ]);
    expect(sums.missingPriceCount).toBe(1);
    expect(sums.netEquity).toBeNull();
  });

  it("counts undiscriminated hits (isRebalance null) — the split must not guess", () => {
    const sums = sumTroveRedemptionRows([hit({ isRebalance: null })]);
    expect(sums.undiscriminatedCount).toBe(1);
    expect(sums.rebalanceCount).toBe(0);
  });

  it("treats a null credited fee as 0 so a drifted row fails reconciliation loudly instead of guessing", () => {
    const sums = sumTroveRedemptionRows([hit({ redemptionFeeCredited: null })]);
    expect(sums.fees).toBe("0");
  });

  it("returns null net equity for zero hits", () => {
    expect(sumTroveRedemptionRows([]).netEquity).toBeNull();
  });
});

describe("reconcileTroveRedemptions", () => {
  it("passes only on exact, to-the-wei agreement of all four figures", () => {
    const sums = sumTroveRedemptionRows([hit()]);
    expect(reconcileTroveRedemptions(sums, cumulatives())).toBe(true);
    expect(
      reconcileTroveRedemptions(sums, cumulatives({ redemptionCount: 2 })),
    ).toBe(false);
    expect(
      reconcileTroveRedemptions(
        sums,
        cumulatives({
          redeemedDebt: (BigInt(wei(400)) + BigInt(1)).toString(),
        }),
      ),
    ).toBe(false);
    expect(
      reconcileTroveRedemptions(sums, cumulatives({ redeemedColl: wei(501) })),
    ).toBe(false);
    expect(
      reconcileTroveRedemptions(
        sums,
        cumulatives({ redemptionFeePaidCum: wei(3) }),
      ),
    ).toBe(false);
  });
});

describe("ledgerWatermarkMatchesNewestRow", () => {
  it("distinguishes two same-block transactions by logIndex — block number alone is not enough", () => {
    const ascending = [
      row({ blockNumber: "100", logIndex: 5 }),
      row({ blockNumber: "100", logIndex: 9 }),
    ];
    expect(
      ledgerWatermarkMatchesNewestRow(
        anchor({ lastLedgerBlock: "100", lastLedgerLogIndex: 9 }),
        ascending,
      ),
    ).toBe(true);
    expect(
      ledgerWatermarkMatchesNewestRow(
        anchor({ lastLedgerBlock: "100", lastLedgerLogIndex: 5 }),
        ascending,
      ),
    ).toBe(false);
  });

  it("never matches without a watermark or without rows", () => {
    expect(ledgerWatermarkMatchesNewestRow(null, [row()])).toBe(false);
    expect(ledgerWatermarkMatchesNewestRow(anchor(), [])).toBe(false);
  });

  it("compares block numbers as BigInt, not string equality", () => {
    expect(
      ledgerWatermarkMatchesNewestRow(
        anchor({ lastLedgerBlock: "0100", lastLedgerLogIndex: 1 }),
        [row({ blockNumber: "100", logIndex: 1 })],
      ),
    ).toBe(true);
  });
});

describe("classifyTroveRedemptionImpact", () => {
  it("returns totals/partial for the interim view — the check never runs", () => {
    expect(
      classifyTroveRedemptionImpact(classifyArgs({ supported: false })),
    ).toEqual({ kind: "totals", reason: "partial" });
  });

  it("returns totals/pending before the ledger has loaded once", () => {
    expect(
      classifyTroveRedemptionImpact(classifyArgs({ hasLoadedOnce: false })),
    ).toEqual({ kind: "totals", reason: "pending" });
  });

  it("skips the check for a truncated history — truncation counts as partial for every derivation", () => {
    expect(
      classifyTroveRedemptionImpact(classifyArgs({ truncated: true })),
    ).toEqual({ kind: "totals", reason: "truncated" });
  });

  it("switches to the batch notice when any row's debt snapshot is null", () => {
    expect(
      classifyTroveRedemptionImpact(
        classifyArgs({ debtSnapshotsComplete: false }),
      ),
    ).toEqual({ kind: "totals", reason: "batch" });
  });

  it("skips the check — no mismatch claim — when the watermark does not equal the newest row's pair", () => {
    // Same block, older logIndex: without the logIndex comparison this
    // would wrongly run the check against a skewed read.
    const result = classifyTroveRedemptionImpact(
      classifyArgs({
        watermark: anchor({ lastLedgerBlock: "100", lastLedgerLogIndex: 0 }),
      }),
    );
    expect(result).toEqual({ kind: "totals", reason: "unverified" });
  });

  it("reconciles when the anchored sums equal the cumulatives", () => {
    const result = classifyTroveRedemptionImpact(classifyArgs());
    expect(result.kind).toBe("reconciled");
  });

  it("reports a mismatch only at a matched watermark", () => {
    const skewed = anchor({ redemptionCount: 2 });
    const result = classifyTroveRedemptionImpact(
      classifyArgs({ watermark: skewed, cumulatives: skewed }),
    );
    expect(result).toEqual({ kind: "mismatch" });
  });

  it("verifies a fresh trove trivially: zero rows, (0, 0) watermark, all-zero cumulatives", () => {
    const zero = anchor({
      lastLedgerBlock: "0",
      lastLedgerLogIndex: 0,
      redemptionCount: 0,
      redeemedDebt: "0",
      redeemedColl: "0",
      redemptionFeePaidCum: "0",
    });
    const result = classifyTroveRedemptionImpact(
      classifyArgs({ rows: [], watermark: zero, cumulatives: zero }),
    );
    expect(result.kind).toBe("reconciled");
  });

  it("stays unverified with zero rows but non-zero cumulatives — a ledger not yet backfilled is not a bug claim", () => {
    const zeroWatermark = anchor({
      lastLedgerBlock: "0",
      lastLedgerLogIndex: 0,
    });
    expect(
      classifyTroveRedemptionImpact(
        classifyArgs({ rows: [], watermark: zeroWatermark }),
      ),
    ).toEqual({ kind: "totals", reason: "unverified" });
  });
});

describe("troveRedemptionCumulatives", () => {
  it("extracts exactly the four reconciled fields from a trove row", () => {
    expect(
      troveRedemptionCumulatives({
        redemptionCount: 3,
        redeemedDebt: "1",
        redeemedColl: "2",
        redemptionFeePaidCum: "3",
      }),
    ).toEqual({
      redemptionCount: 3,
      redeemedDebt: "1",
      redeemedColl: "2",
      redemptionFeePaidCum: "3",
    });
  });
});
