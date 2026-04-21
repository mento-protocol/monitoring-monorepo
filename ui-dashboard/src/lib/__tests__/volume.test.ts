import { describe, it, expect } from "vitest";
import { NETWORKS } from "../networks";
import {
  buildPoolVolumeMapInWindow,
  buildSnapshotWindows,
  buildPoolVolumeMap,
  dayBucket,
  filterSnapshotsToWindow,
  getSnapshotVolumeInUsd,
  poolTotalVolumeUSD,
  shouldQueryPoolSnapshots,
  snapshotWindowPrior7dFromCurrent,
  snapshotWindow24h,
  snapshotWindow7d,
  snapshotWindow30d,
  snapshotWindowDaily7d,
  snapshotWindowDaily30d,
  snapshotWindowPrior7d,
  sumVolumeMap,
  sumFpmmSwaps,
} from "../volume";
import type { OracleRateMap } from "../tokens";
import type { Pool, PoolSnapshotWindow } from "../types";

const network = NETWORKS["celo-sepolia-local"];
const mainnet = NETWORKS["celo-mainnet"];

const EMPTY_RATES: OracleRateMap = new Map();
const EUR_RATES: OracleRateMap = new Map([["axlEUROC", 1.1455]]);

describe("snapshotWindow24h", () => {
  it("returns a bounded 24h hourly window", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0); // 21:26:45 UTC
    const { from, to } = snapshotWindow24h(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;
    expect(from).toBe(expectedHourStart - 24 * 3600);
    expect(to).toBe(expectedHourStart);
    expect(to - from).toBe(24 * 3600);
  });
});

describe("snapshotWindow7d", () => {
  it("returns a bounded 7d hourly window", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0); // 21:26:45 UTC
    const { from, to } = snapshotWindow7d(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;
    expect(from).toBe(expectedHourStart - 7 * 24 * 3600);
    expect(to).toBe(expectedHourStart);
    expect(to - from).toBe(7 * 24 * 3600);
  });
});

describe("snapshotWindow30d", () => {
  it("returns a bounded 30d hourly window", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0); // 21:26:45 UTC
    const { from, to } = snapshotWindow30d(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;
    expect(from).toBe(expectedHourStart - 30 * 24 * 3600);
    expect(to).toBe(expectedHourStart);
    expect(to - from).toBe(30 * 24 * 3600);
  });
});

describe("dayBucket", () => {
  it("rounds any within-day timestamp down to the UTC midnight boundary", () => {
    const midnight = Date.UTC(2026, 2, 9, 0, 0, 0, 0) / 1000;
    const midday = Date.UTC(2026, 2, 9, 12, 34, 56, 0) / 1000;
    const endOfDay = Date.UTC(2026, 2, 9, 23, 59, 59, 0) / 1000;
    expect(dayBucket(midnight)).toBe(midnight);
    expect(dayBucket(midday)).toBe(midnight);
    expect(dayBucket(endOfDay)).toBe(midnight);
  });
});

describe("snapshotWindowDaily7d", () => {
  // Regression guard: when filtering PoolDailySnapshot (midnight-UTC
  // timestamps), an hour-aligned `from` bound silently drops the oldest day
  // — its midnight row falls before `from` and fails the `timestamp >= from`
  // filter. The daily variant snaps `from` down to the UTC-day boundary so
  // that row is preserved.
  it("rounds `from` down to the UTC-day boundary; `to` stays hour-aligned", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0); // 21:26:45 UTC
    const { from, to } = snapshotWindowDaily7d(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;
    const expectedDayStart =
      Date.UTC(2026, 2, 9 - 7, 0, 0, 0, 0) / 1000; // day D-7 midnight
    expect(to).toBe(expectedHourStart);
    expect(from).toBe(expectedDayStart);
  });

  it("includes the midnight rollup at the oldest day's start boundary", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0);
    const window = snapshotWindowDaily7d(now);
    // The daily rollup for day D-7 carries a timestamp exactly at the
    // window's `from` bound — must be kept (inclusive lower bound).
    expect(window.from).toBe(window.from); // sanity
    const oldestMidnight = Date.UTC(2026, 2, 9 - 7, 0, 0, 0, 0) / 1000;
    expect(oldestMidnight >= window.from).toBe(true);
    expect(oldestMidnight < window.to).toBe(true);
  });
});

describe("snapshotWindowDaily30d", () => {
  it("rounds `from` down to the UTC-day boundary; `to` stays hour-aligned", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0);
    const { from, to } = snapshotWindowDaily30d(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;
    const expectedDayStart =
      Date.UTC(2026, 2, 9 - 30, 0, 0, 0, 0) / 1000; // day D-30 midnight
    expect(to).toBe(expectedHourStart);
    expect(from).toBe(expectedDayStart);
  });
});

describe("snapshotWindowPrior7d", () => {
  it("returns the 7d window immediately before the current 7d window", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0); // 21:26:45 UTC
    const { from, to } = snapshotWindowPrior7d(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;
    expect(to).toBe(expectedHourStart - 7 * 24 * 3600);
    expect(from).toBe(expectedHourStart - 14 * 24 * 3600);
    expect(to - from).toBe(7 * 24 * 3600);
  });
});

describe("buildSnapshotWindows", () => {
  it("reuses one anchored clock for all snapshot windows", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0);
    const windows = buildSnapshotWindows(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;

    expect(windows.w24h.to).toBe(expectedHourStart);
    expect(windows.w7d.to).toBe(expectedHourStart);
    expect(windows.w30d.to).toBe(expectedHourStart);
  });
});

describe("snapshotWindowPrior7dFromCurrent", () => {
  it("derives the same prior window as snapshotWindowPrior7d", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0);

    expect(snapshotWindowPrior7dFromCurrent(snapshotWindow7d(now))).toEqual(
      snapshotWindowPrior7d(now),
    );
  });
});

describe("shouldQueryPoolSnapshots", () => {
  it("returns false when there are no pool ids", () => {
    expect(shouldQueryPoolSnapshots([])).toBe(false);
  });

  it("returns true when at least one pool id is present", () => {
    expect(shouldQueryPoolSnapshots(["pool-1"])).toBe(true);
  });
});

describe("sumFpmmSwaps", () => {
  it("sums swapCount across all hourly snapshots for FPMM pools", () => {
    const snapshots: PoolSnapshotWindow[] = [
      {
        poolId: "fpmm-1",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapCount: 3,
        swapVolume0: "0",
        swapVolume1: "0",
      },
      {
        poolId: "fpmm-1",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapCount: 5,
        swapVolume0: "0",
        swapVolume1: "0",
      },
      {
        poolId: "fpmm-2",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapCount: 2,
        swapVolume0: "0",
        swapVolume1: "0",
      },
    ];
    const fpmmIds = new Set(["fpmm-1", "fpmm-2"]);
    expect(sumFpmmSwaps(snapshots, fpmmIds)).toBe(10);
  });

  it("excludes snapshots from non-FPMM pools", () => {
    const snapshots: PoolSnapshotWindow[] = [
      {
        poolId: "fpmm-1",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapCount: 4,
        swapVolume0: "0",
        swapVolume1: "0",
      },
      {
        poolId: "virtual-1",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapCount: 99,
        swapVolume0: "0",
        swapVolume1: "0",
      },
    ];
    const fpmmIds = new Set(["fpmm-1"]);
    expect(sumFpmmSwaps(snapshots, fpmmIds)).toBe(4);
  });

  it("returns 0 when there are no snapshots", () => {
    expect(sumFpmmSwaps([], new Set(["fpmm-1"]))).toBe(0);
  });

  it("returns 0 when fpmmPoolIds is empty", () => {
    const snapshots: PoolSnapshotWindow[] = [
      {
        poolId: "fpmm-1",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapCount: 7,
        swapVolume0: "0",
        swapVolume1: "0",
      },
    ];
    expect(sumFpmmSwaps(snapshots, new Set())).toBe(0);
  });
});

describe("buildPoolVolumeMap", () => {
  it("uses USDm side for USD volume when oracle price is present", () => {
    const pools: Pool[] = [
      {
        id: "pool-1",
        chainId: 42220,
        token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
        token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
        token0Decimals: 18,
        token1Decimals: 18,
        oraclePrice: "1000000000000000000000000", // 1e24 (valid non-zero)
        source: "FPMM",
        createdAtBlock: "0",
        createdAtTimestamp: "0",
        updatedAtBlock: "0",
        updatedAtTimestamp: "0",
      },
    ];

    const snapshots: PoolSnapshotWindow[] = [
      {
        poolId: "pool-1",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapVolume0: "2000000000000000000", // 2 USDm
        swapVolume1: "900000000000000000000", // should be ignored when oracle exists
        swapCount: 1,
      },
    ];

    const volumeByPool = buildPoolVolumeMap(
      snapshots,
      pools,
      network,
      EMPTY_RATES,
    );
    expect(volumeByPool.get("pool-1")).toBeCloseTo(2, 8);
  });

  it("uses USDm leg volume even when oracle is unavailable", () => {
    const pools: Pool[] = [
      {
        id: "pool-2",
        chainId: 42220,
        token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
        token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
        token0Decimals: 18,
        token1Decimals: 18,
        oraclePrice: "0",
        source: "FPMM",
        createdAtBlock: "0",
        createdAtTimestamp: "0",
        updatedAtBlock: "0",
        updatedAtTimestamp: "0",
      },
    ];

    const snapshots: PoolSnapshotWindow[] = [
      {
        poolId: "pool-2",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapVolume0: "1000000000000000000", // 1
        swapVolume1: "3000000000000000000", // 3
        swapCount: 1,
      },
    ];

    const volumeByPool = buildPoolVolumeMap(
      snapshots,
      pools,
      network,
      EMPTY_RATES,
    );
    expect(volumeByPool.get("pool-2")).toBeCloseTo(1, 8);
  });

  it("converts snapshot volume via FX rate for non-USDm pool (e.g. axlEUROC/EURm)", () => {
    const pools: Pool[] = [
      {
        id: "pool-eur",
        chainId: 42220,
        token0: "0x061cc5a2c863e0c1cb404006d559db18a34c762d", // axlEUROC
        token1: "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73", // EURm
        token0Decimals: 6,
        token1Decimals: 18,
        oraclePrice: "0",
        source: "FPMM",
        createdAtBlock: "0",
        createdAtTimestamp: "0",
        updatedAtBlock: "0",
        updatedAtTimestamp: "0",
      },
    ];

    const snapshots: PoolSnapshotWindow[] = [
      {
        poolId: "pool-eur",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapVolume0: "50000000", // 50 axlEUROC (6 decimals)
        swapVolume1: "100000000000000000000", // 100 EURm (18 decimals)
        swapCount: 3,
      },
      {
        poolId: "pool-eur",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapVolume0: "25000000", // 25 axlEUROC
        swapVolume1: "50000000000000000000", // 50 EURm
        swapCount: 1,
      },
    ];

    // axlEUROC rate = 1.1455 USD per token
    // Snapshot volumes: 50 + 25 = 75 axlEUROC → 75 * 1.1455 = 85.9125
    const volumeByPool = buildPoolVolumeMap(
      snapshots,
      pools,
      mainnet,
      EUR_RATES,
    );
    expect(volumeByPool.get("pool-eur")).toBeCloseTo(85.9125, 2);
  });

  it("marks volume as non-convertible when neither token has a known USD rate", () => {
    const pools: Pool[] = [
      {
        id: "pool-3",
        chainId: 42220,
        token0: "0x0000000000000000000000000000000000000003",
        token1: "0x0000000000000000000000000000000000000004",
        token0Decimals: 18,
        token1Decimals: 18,
        oraclePrice: "0",
        source: "VirtualPool",
        createdAtBlock: "0",
        createdAtTimestamp: "0",
        updatedAtBlock: "0",
        updatedAtTimestamp: "0",
      },
    ];

    const snapshots: PoolSnapshotWindow[] = [
      {
        poolId: "pool-3",
        timestamp: "0",
        reserves0: "0",
        reserves1: "0",
        swapVolume0: "1000000000000000000",
        swapVolume1: "3000000000000000000",
        swapCount: 1,
      },
    ];

    const volumeByPool = buildPoolVolumeMap(
      snapshots,
      pools,
      network,
      EMPTY_RATES,
    );
    expect(volumeByPool.get("pool-3")).toBeNull();
  });
});

describe("filterSnapshotsToWindow", () => {
  it("keeps the lower bound inclusive and the upper bound exclusive", () => {
    const filtered = filterSnapshotsToWindow(
      [
        {
          poolId: "pool-1",
          timestamp: "100",
          reserves0: "0",
          reserves1: "0",
          swapCount: 0,
          swapVolume0: "0",
          swapVolume1: "0",
        },
        {
          poolId: "pool-1",
          timestamp: "150",
          reserves0: "0",
          reserves1: "0",
          swapCount: 0,
          swapVolume0: "0",
          swapVolume1: "0",
        },
        {
          poolId: "pool-1",
          timestamp: "200",
          reserves0: "0",
          reserves1: "0",
          swapCount: 0,
          swapVolume0: "0",
          swapVolume1: "0",
        },
      ],
      { from: 100, to: 200 },
    );

    expect(filtered.map((snapshot) => snapshot.timestamp)).toEqual([
      "100",
      "150",
    ]);
  });
});

describe("buildPoolVolumeMapInWindow", () => {
  it("only aggregates snapshots inside the requested window", () => {
    const pools: Pool[] = [
      {
        id: "pool-1",
        chainId: 42220,
        token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
        token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf",
        token0Decimals: 18,
        token1Decimals: 18,
        oraclePrice: "1000000000000000000000000",
        source: "FPMM",
        createdAtBlock: "0",
        createdAtTimestamp: "0",
        updatedAtBlock: "0",
        updatedAtTimestamp: "0",
      },
    ];

    const volumeByPool = buildPoolVolumeMapInWindow(
      [
        {
          poolId: "pool-1",
          timestamp: "100",
          reserves0: "0",
          reserves1: "0",
          swapCount: 0,
          swapVolume0: "1000000000000000000",
          swapVolume1: "0",
        },
        {
          poolId: "pool-1",
          timestamp: "200",
          reserves0: "0",
          reserves1: "0",
          swapCount: 0,
          swapVolume0: "3000000000000000000",
          swapVolume1: "0",
        },
      ],
      pools,
      network,
      EMPTY_RATES,
      { from: 100, to: 200 },
    );

    expect(volumeByPool.get("pool-1")).toBeCloseTo(1, 8);
    expect(sumVolumeMap(volumeByPool)).toBeCloseTo(1, 8);
  });
});

describe("getSnapshotVolumeInUsd", () => {
  it("returns null when the pool is missing", () => {
    expect(
      getSnapshotVolumeInUsd(
        {
          poolId: "pool-1",
          timestamp: "0",
          reserves0: "0",
          reserves1: "0",
          swapCount: 0,
          swapVolume0: "1000000000000000000",
          swapVolume1: "0",
        },
        undefined,
        mainnet,
        EMPTY_RATES,
      ),
    ).toBeNull();
  });
});

const BASE_POOL_FIELDS = {
  source: "fpmm_factory",
  createdAtBlock: "0",
  createdAtTimestamp: "0",
  updatedAtBlock: "0",
  updatedAtTimestamp: "0",
};

describe("poolTotalVolumeUSD", () => {
  it("returns volume in USD when token0 is USDm", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-1",
      chainId: 42220,
      token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
      token0Decimals: 18,
      token1Decimals: 18,
      notionalVolume0: "5000000000000000000", // 5e18 = 5 USDm
      notionalVolume1: "900000000000000000000",
    };
    expect(poolTotalVolumeUSD(pool, network, EMPTY_RATES)).toBeCloseTo(5, 8);
  });

  it("returns volume in USD when token1 is USDm", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-2",
      chainId: 42220,
      token0: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
      token1: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token0Decimals: 18,
      token1Decimals: 18,
      notionalVolume0: "900000000000000000000",
      notionalVolume1: "10000000000000000000", // 10e18 = 10 USDm
    };
    expect(poolTotalVolumeUSD(pool, network, EMPTY_RATES)).toBeCloseTo(10, 8);
  });

  it("returns null when neither token has a known USD rate", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-3",
      chainId: 42220,
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      token0Decimals: 18,
      token1Decimals: 18,
      notionalVolume0: "1000000000000000000",
      notionalVolume1: "2000000000000000000",
    };
    expect(poolTotalVolumeUSD(pool, network, EMPTY_RATES)).toBeNull();
  });

  it("converts volume via FX rate for non-USDm pools (e.g. axlEUROC/EURm)", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-eur",
      chainId: 42220,
      token0: "0x061cc5a2c863e0c1cb404006d559db18a34c762d", // axlEUROC
      token1: "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73", // EURm
      token0Decimals: 6,
      token1Decimals: 18,
      notionalVolume0: "100000000", // 100 axlEUROC (6 decimals)
      notionalVolume1: "200000000000000000000", // 200 EURm (18 decimals)
    };
    // axlEUROC FX rate = 1.1455 USD per EUR token
    // 100 * 1.1455 = 114.55
    expect(poolTotalVolumeUSD(pool, mainnet, EUR_RATES)).toBeCloseTo(114.55, 2);
  });

  it("converts volume via token1 FX rate when token0 is unknown", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-eur-t1",
      chainId: 42220,
      token0: "0x0000000000000000000000000000000000000099", // unknown
      token1: "0x061cc5a2c863e0c1cb404006d559db18a34c762d", // axlEUROC
      token0Decimals: 18,
      token1Decimals: 6,
      notionalVolume0: "500000000000000000000", // 500 unknown (no rate)
      notionalVolume1: "200000000", // 200 axlEUROC (6 decimals)
    };
    // token0 has no rate, so falls through to token1 (axlEUROC @ 1.1455)
    // 200 * 1.1455 = 229.10
    expect(poolTotalVolumeUSD(pool, mainnet, EUR_RATES)).toBeCloseTo(229.1, 2);
  });

  it("returns 0 when pool is USD-convertible but has no recorded volume", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-4",
      chainId: 42220,
      token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
      token0Decimals: 18,
      token1Decimals: 18,
      // notionalVolume0 intentionally absent
    };
    expect(poolTotalVolumeUSD(pool, network, EMPTY_RATES)).toBe(0);
  });
});
