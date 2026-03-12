import { describe, it, expect } from "vitest";
import { NETWORKS } from "../networks";
import {
  buildPool24hVolumeMap,
  poolTotalVolumeUSD,
  shouldQueryPoolSnapshots24h,
  snapshotWindow24h,
  sumFpmmSwaps24h,
} from "../volume";
import type { Pool, PoolSnapshot24h } from "../types";

const network = NETWORKS["celo-sepolia-local"];

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

describe("shouldQueryPoolSnapshots24h", () => {
  it("returns false when there are no pool ids", () => {
    expect(shouldQueryPoolSnapshots24h([])).toBe(false);
  });

  it("returns true when at least one pool id is present", () => {
    expect(shouldQueryPoolSnapshots24h(["pool-1"])).toBe(true);
  });
});

describe("sumFpmmSwaps24h", () => {
  it("sums swapCount across all hourly snapshots for FPMM pools", () => {
    const snapshots: PoolSnapshot24h[] = [
      { poolId: "fpmm-1", swapCount: 3, swapVolume0: "0", swapVolume1: "0" },
      { poolId: "fpmm-1", swapCount: 5, swapVolume0: "0", swapVolume1: "0" },
      { poolId: "fpmm-2", swapCount: 2, swapVolume0: "0", swapVolume1: "0" },
    ];
    const fpmmIds = new Set(["fpmm-1", "fpmm-2"]);
    expect(sumFpmmSwaps24h(snapshots, fpmmIds)).toBe(10);
  });

  it("excludes snapshots from non-FPMM pools", () => {
    const snapshots: PoolSnapshot24h[] = [
      { poolId: "fpmm-1", swapCount: 4, swapVolume0: "0", swapVolume1: "0" },
      {
        poolId: "virtual-1",
        swapCount: 99,
        swapVolume0: "0",
        swapVolume1: "0",
      },
    ];
    const fpmmIds = new Set(["fpmm-1"]);
    expect(sumFpmmSwaps24h(snapshots, fpmmIds)).toBe(4);
  });

  it("returns 0 when there are no snapshots", () => {
    expect(sumFpmmSwaps24h([], new Set(["fpmm-1"]))).toBe(0);
  });

  it("returns 0 when fpmmPoolIds is empty", () => {
    const snapshots: PoolSnapshot24h[] = [
      { poolId: "fpmm-1", swapCount: 7, swapVolume0: "0", swapVolume1: "0" },
    ];
    expect(sumFpmmSwaps24h(snapshots, new Set())).toBe(0);
  });
});

describe("buildPool24hVolumeMap", () => {
  it("uses USDm side for USD volume when oracle price is present", () => {
    const pools: Pool[] = [
      {
        id: "pool-1",
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

    const snapshots: PoolSnapshot24h[] = [
      {
        poolId: "pool-1",
        swapVolume0: "2000000000000000000", // 2 USDm
        swapVolume1: "900000000000000000000", // should be ignored when oracle exists
        swapCount: 1,
      },
    ];

    const volumeByPool = buildPool24hVolumeMap(snapshots, pools, network);
    expect(volumeByPool.get("pool-1")).toBeCloseTo(2, 8);
  });

  it("uses USDm leg volume even when oracle is unavailable", () => {
    const pools: Pool[] = [
      {
        id: "pool-2",
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

    const snapshots: PoolSnapshot24h[] = [
      {
        poolId: "pool-2",
        swapVolume0: "1000000000000000000", // 1
        swapVolume1: "3000000000000000000", // 3
        swapCount: 1,
      },
    ];

    const volumeByPool = buildPool24hVolumeMap(snapshots, pools, network);
    expect(volumeByPool.get("pool-2")).toBeCloseTo(1, 8);
  });

  it("marks volume as non-convertible when pool has no USDm leg", () => {
    const pools: Pool[] = [
      {
        id: "pool-3",
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

    const snapshots: PoolSnapshot24h[] = [
      {
        poolId: "pool-3",
        swapVolume0: "1000000000000000000",
        swapVolume1: "3000000000000000000",
        swapCount: 1,
      },
    ];

    const volumeByPool = buildPool24hVolumeMap(snapshots, pools, network);
    expect(volumeByPool.get("pool-3")).toBeNull();
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
      token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
      token0Decimals: 18,
      token1Decimals: 18,
      notionalVolume0: "5000000000000000000", // 5e18 = 5 USDm
      notionalVolume1: "900000000000000000000",
    };
    expect(poolTotalVolumeUSD(pool, network)).toBeCloseTo(5, 8);
  });

  it("returns volume in USD when token1 is USDm", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-2",
      token0: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
      token1: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token0Decimals: 18,
      token1Decimals: 18,
      notionalVolume0: "900000000000000000000",
      notionalVolume1: "10000000000000000000", // 10e18 = 10 USDm
    };
    expect(poolTotalVolumeUSD(pool, network)).toBeCloseTo(10, 8);
  });

  it("returns null when pool has no USDm leg", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-3",
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      token0Decimals: 18,
      token1Decimals: 18,
      notionalVolume0: "1000000000000000000",
      notionalVolume1: "2000000000000000000",
    };
    expect(poolTotalVolumeUSD(pool, network)).toBeNull();
  });

  it("returns 0 when pool is USD-convertible but has no recorded volume", () => {
    const pool: Pool = {
      ...BASE_POOL_FIELDS,
      id: "pool-4",
      token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
      token0Decimals: 18,
      token1Decimals: 18,
      // notionalVolume0 intentionally absent
    };
    expect(poolTotalVolumeUSD(pool, network)).toBe(0);
  });
});
