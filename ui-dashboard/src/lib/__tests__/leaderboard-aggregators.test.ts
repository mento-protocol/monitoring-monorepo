import { describe, expect, it } from "vitest";
import {
  aggregateAggregatorsByWindow,
  buildAggregatorDailyVolumeBreakdown,
  type AggregatorDailyRow,
} from "../leaderboard-aggregators";

const USD = (n: number) =>
  (BigInt(Math.floor(n * 1_000_000)) * BigInt(10) ** BigInt(12)).toString();

function row(overrides: Partial<AggregatorDailyRow>): AggregatorDailyRow {
  return {
    id: "row",
    chainId: 42220,
    aggregator: "squid",
    lastSeenAggregatorAddress: "0xrouter",
    timestamp: "1000",
    swapCount: 1,
    uniqueTraders: 1,
    volumeUsdWei: USD(1),
    ...overrides,
  };
}

describe("aggregateAggregatorsByWindow", () => {
  it("sums rows by chain and aggregator while keeping latest router address", () => {
    const out = aggregateAggregatorsByWindow([
      row({
        aggregator: "cluster-deadbeefdeadbeef",
        timestamp: "2000",
        lastSeenAggregatorAddress: "0xnew",
        volumeUsdWei: USD(2),
        swapCount: 2,
        uniqueTraders: 3,
      }),
      row({
        aggregator: "cluster-deadbeefdeadbeef",
        timestamp: "1000",
        lastSeenAggregatorAddress: "0xold",
        volumeUsdWei: USD(5),
        swapCount: 1,
        uniqueTraders: 4,
      }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.lastSeenAggregatorAddress).toBe("0xnew");
    expect(out[0]!.swapCount).toBe(3);
    expect(out[0]!.uniqueTradersApprox).toBe(4);
    expect(out[0]!.volumeUsdWei).toBe(BigInt(USD(7)));
  });
});

describe("buildAggregatorDailyVolumeBreakdown", () => {
  it("zero-fills days and buckets long-tail aggregators into Other", () => {
    const day0 = 1_779_000_000;
    const day1 = day0 + 86_400;
    const day2 = day1 + 86_400;
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({
        chainId: 42220,
        aggregator: `agg-${i}`,
        timestamp: i === 0 ? String(day0) : String(day2),
        volumeUsdWei: USD(10 - i),
      }),
    );

    const out = buildAggregatorDailyVolumeBreakdown(rows, {
      fromSec: day0,
      toSec: day2,
    });

    expect(out.totalSeries.map((p) => p.timestamp)).toEqual([day0, day1, day2]);
    expect(out.totalSeries[1]!.value).toBe(0);
    expect(out.breakdown).toHaveLength(8);
    expect(out.breakdown.at(-1)!.name).toBe("Other (2)");
  });
});
