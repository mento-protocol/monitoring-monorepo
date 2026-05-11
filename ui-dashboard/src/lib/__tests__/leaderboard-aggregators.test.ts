import { describe, expect, it } from "vitest";
import {
  aggregateAggregatorsByWindow,
  buildAggregatorDailyVolumeBreakdown,
  selectAggregatorRowsForSystemToggle,
  type AggregatorDailyRow,
} from "../leaderboard-aggregators";
import {
  AGGREGATOR_DAILY_TOP,
  AGGREGATOR_DAILY_TOP_INCLUDING_SYSTEM,
  aggregatorDailyTopQuery,
} from "../queries/leaderboard";

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
    swapCountIncludingSystem: 1,
    uniqueTraders: 1,
    uniqueTradersIncludingSystem: 1,
    volumeUsdWei: USD(1),
    volumeUsdWeiIncludingSystem: USD(1),
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

describe("selectAggregatorRowsForSystemToggle", () => {
  it("drops hidden-system rows whose primary fields were zeroed", () => {
    const selected = selectAggregatorRowsForSystemToggle(
      [
        row({ id: "visible", aggregator: "squid", volumeUsdWei: USD(5) }),
        row({
          id: "system-bucket",
          aggregator: "system",
          volumeUsdWei: USD(10),
        }),
        row({
          id: "system-via-router",
          aggregator: "squid",
          swapCount: 0,
          uniqueTraders: 0,
          volumeUsdWei: "0",
          swapCountIncludingSystem: 3,
          uniqueTradersIncludingSystem: 2,
          volumeUsdWeiIncludingSystem: USD(99),
        }),
      ],
      false,
    );

    expect(selected.map((r) => r.volumeUsdWei)).toEqual([USD(5)]);
  });

  it("maps including-system fields when system addresses are shown", () => {
    const selected = selectAggregatorRowsForSystemToggle(
      [
        row({
          swapCount: 0,
          uniqueTraders: 0,
          volumeUsdWei: "0",
          swapCountIncludingSystem: 3,
          uniqueTradersIncludingSystem: 2,
          volumeUsdWeiIncludingSystem: USD(99),
        }),
      ],
      true,
    );

    expect(selected[0]).toMatchObject({
      swapCount: 3,
      uniqueTraders: 2,
      volumeUsdWei: USD(99),
    });
  });
});

describe("aggregatorDailyTopQuery", () => {
  it("orders by the displayed volume for the active system toggle", () => {
    expect(aggregatorDailyTopQuery(false)).toBe(AGGREGATOR_DAILY_TOP);
    expect(aggregatorDailyTopQuery(false)).toContain(
      "order_by: [{ volumeUsdWei: desc }, { id: asc }]",
    );
    expect(aggregatorDailyTopQuery(true)).toBe(
      AGGREGATOR_DAILY_TOP_INCLUDING_SYSTEM,
    );
    expect(aggregatorDailyTopQuery(true)).toContain(
      "order_by: [{ volumeUsdWeiIncludingSystem: desc }, { id: asc }]",
    );
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
    expect(out.breakdown[0]!.id).toBe(out.breakdown[0]!.key);
    expect(out.breakdown[0]!.name).toBe("agg-0 (Celo)");
    expect(out.breakdown.at(-1)!.name).toBe("Other (2)");
  });
});
