import { describe, it, expect } from "vitest";
import { computeRouteAvgDeliverTimes } from "../route-stats";
import { makeTransfer } from "./fixtures";

const CELO = 42220;
const MONAD = 143;

function delivered(
  srcChainId: number,
  dstChainId: number,
  sentTs: string,
  deliveredTs: string,
) {
  return makeTransfer({
    status: "DELIVERED",
    sourceChainId: srcChainId,
    destChainId: dstChainId,
    sentTimestamp: sentTs,
    deliveredTimestamp: deliveredTs,
  });
}

describe("computeRouteAvgDeliverTimes", () => {
  it("returns empty array for empty input", () => {
    expect(computeRouteAvgDeliverTimes([])).toEqual([]);
  });

  it("returns empty array when all transfers are non-DELIVERED", () => {
    expect(
      computeRouteAvgDeliverTimes([
        makeTransfer({ status: "SENT", sourceChainId: CELO, destChainId: MONAD, sentTimestamp: "1000" }),
        makeTransfer({ status: "ATTESTED", sourceChainId: CELO, destChainId: MONAD }),
      ]),
    ).toEqual([]);
  });

  it("excludes SENT rows even when both timestamps are set (partial-indexing guard)", () => {
    // A SENT row that somehow has deliveredTimestamp set (dest-first race or
    // indexer lag) must not pollute the average — the status guard is the
    // authoritative check, not the presence of timestamps.
    expect(
      computeRouteAvgDeliverTimes([
        makeTransfer({
          status: "SENT",
          sourceChainId: CELO,
          destChainId: MONAD,
          sentTimestamp: "1000",
          deliveredTimestamp: "1005",
        }),
      ]),
    ).toEqual([]);
  });

  it("excludes transfers with null sourceChainId or destChainId", () => {
    expect(
      computeRouteAvgDeliverTimes([
        makeTransfer({ status: "DELIVERED", sourceChainId: null, destChainId: MONAD, sentTimestamp: "1000", deliveredTimestamp: "2000" }),
        makeTransfer({ status: "DELIVERED", sourceChainId: CELO, destChainId: null, sentTimestamp: "1000", deliveredTimestamp: "2000" }),
      ]),
    ).toEqual([]);
  });

  it("returns empty array when all DELIVERED rows have null durations", () => {
    expect(
      computeRouteAvgDeliverTimes([
        makeTransfer({ status: "DELIVERED", sourceChainId: CELO, destChainId: MONAD, sentTimestamp: null }),
      ]),
    ).toEqual([]);
  });

  it("computes avg for a single route with one transfer", () => {
    const r = computeRouteAvgDeliverTimes([
      delivered(CELO, MONAD, "1000", "1100"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ srcChainId: CELO, dstChainId: MONAD, avgSec: 100, count: 1 });
  });

  it("computes mean across multiple transfers on the same route", () => {
    const r = computeRouteAvgDeliverTimes([
      delivered(CELO, MONAD, "1000", "1100"), // 100s
      delivered(CELO, MONAD, "2000", "2300"), // 300s
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].avgSec).toBe(200);
    expect(r[0].count).toBe(2);
  });

  it("groups distinct routes separately and sorts fastest-first", () => {
    const r = computeRouteAvgDeliverTimes([
      delivered(CELO, MONAD, "1000", "2800"),  // 1800s Celo→Monad
      delivered(MONAD, CELO, "1000", "1010"),   // 10s   Monad→Celo
      delivered(CELO, MONAD, "2000", "3800"),  // 1800s  Celo→Monad (second)
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ srcChainId: MONAD, dstChainId: CELO, avgSec: 10, count: 1 });
    expect(r[1]).toEqual({ srcChainId: CELO, dstChainId: MONAD, avgSec: 1800, count: 2 });
  });

  it("clamps negative duration (clock skew) to 0", () => {
    const r = computeRouteAvgDeliverTimes([
      delivered(CELO, MONAD, "2000", "1000"), // delivered < sent → clamped to 0
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].avgSec).toBe(0);
  });
});
