import { describe, it, expect } from "vitest";
import { NETWORKS } from "../networks";
import { buildPool24hVolumeMap, snapshotSince24h } from "../volume";
import type { Pool, PoolSnapshot24h } from "../types";

const network = NETWORKS["celo-sepolia-local"];

describe("snapshotSince24h", () => {
  it("aligns the lower bound to hourly snapshot buckets", () => {
    const now = Date.UTC(2026, 2, 9, 21, 26, 45, 0); // 21:26:45 UTC
    const since = snapshotSince24h(now);
    const expectedHourStart = Date.UTC(2026, 2, 9, 21, 0, 0, 0) / 1000;
    expect(since).toBe(expectedHourStart - 24 * 3600);
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
      },
    ];

    const volumeByPool = buildPool24hVolumeMap(snapshots, pools, network);
    expect(volumeByPool.get("pool-1")).toBeCloseTo(2, 8);
  });

  it("falls back to sum of both token volumes when oracle is unavailable", () => {
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
      },
    ];

    const volumeByPool = buildPool24hVolumeMap(snapshots, pools, network);
    expect(volumeByPool.get("pool-2")).toBeCloseTo(4, 8);
  });
});
