import { describe, expect, it } from "vitest";
import type { CdpTrove } from "../../../_lib/types";
import { sortDisplayRows, type TroveDisplayRow } from "../trove-sort";

function makeTrove(overrides: Partial<CdpTrove>): CdpTrove {
  return {
    id: "1",
    troveId: "1",
    owner: "0xowner",
    previousOwner: "0x0000000000000000000000000000000000000000",
    status: "active",
    debt: "0",
    coll: "0",
    icrBps: 0,
    interestRate: "0",
    interestBatchId: null,
    openedAt: "0",
    openedTxHash: "0xopen",
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: "0",
    lastUpdatedTxHash: null,
    liquidatedDebt: null,
    liquidatedColl: null,
    collSurplus: null,
    priceAtLiquidation: null,
    redemptionCount: 0,
    redeemedDebt: "0",
    redeemedColl: "0",
    redemptionFeePaidCum: "0",
    ...overrides,
  };
}

function row(
  overrides: Partial<CdpTrove>,
  effectiveRate: bigint | null = BigInt(0),
): TroveDisplayRow {
  return {
    trove: makeTrove(overrides),
    effectiveRate,
    rank: null,
    tied: false,
    rateSource: "direct",
  };
}

const ids = (rows: TroveDisplayRow[]) => rows.map((r) => r.trove.id);

describe("sortDisplayRows (open tab)", () => {
  const rows = [
    row({ id: "a", debt: "300", coll: "100", icrBps: 150 }, BigInt(5)),
    row({ id: "b", debt: "100", coll: "300", icrBps: 200 }, BigInt(3)),
    row({ id: "c", debt: "200", coll: "200", icrBps: 175 }, BigInt(7)),
  ];

  it("sorts by debt ascending and descending", () => {
    expect(ids(sortDisplayRows(rows, "open", "debt", "asc"))).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(ids(sortDisplayRows(rows, "open", "debt", "desc"))).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("sorts by collateral", () => {
    expect(ids(sortDisplayRows(rows, "open", "collateral", "asc"))).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("rank/interest order by effective interest rate ascending", () => {
    expect(ids(sortDisplayRows(rows, "open", "rank", "asc"))).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(ids(sortDisplayRows(rows, "open", "interest", "asc"))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("keeps ICR-unavailable rows (sentinel < 0) last in both directions", () => {
    const withSentinel = [
      row({ id: "a", icrBps: 150 }),
      row({ id: "x", icrBps: -1 }),
      row({ id: "b", icrBps: 200 }),
    ];
    expect(
      ids(sortDisplayRows(withSentinel, "open", "icr", "asc")).at(-1),
    ).toBe("x");
    expect(
      ids(sortDisplayRows(withSentinel, "open", "icr", "desc")).at(-1),
    ).toBe("x");
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    sortDisplayRows(input, "open", "debt", "asc");
    expect(ids(input)).toEqual(["a", "b", "c"]);
  });
});

describe("sortDisplayRows (history tab)", () => {
  it("sorts by ended time using closedAt, falling back to lastUpdatedAt", () => {
    const rows = [
      row({ id: "a", closedAt: "300" }),
      row({ id: "b", closedAt: null, lastUpdatedAt: "500" }),
      row({ id: "c", closedAt: "100" }),
    ];
    expect(ids(sortDisplayRows(rows, "history", "ended", "desc"))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("keeps never-liquidated troves last regardless of direction", () => {
    const rows = [
      row({ id: "a", liquidatedDebt: "100" }),
      row({ id: "b", liquidatedDebt: null }),
      row({ id: "c", liquidatedDebt: "300" }),
    ];
    expect(
      ids(sortDisplayRows(rows, "history", "liquidated", "asc")).at(-1),
    ).toBe("b");
    expect(
      ids(sortDisplayRows(rows, "history", "liquidated", "desc")).at(-1),
    ).toBe("b");
  });
});
