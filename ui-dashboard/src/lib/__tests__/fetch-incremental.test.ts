import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphQLClient } from "graphql-request";
import {
  fetchAllDailySnapshotPages,
  fetchAllFeeSnapshotPages,
  incrementalRowCache,
  partialPageLastCapturedAt,
  seedIncrementalRowCacheFromNetworkData,
  type NetworkData,
  warnedCapKeys,
} from "@/lib/fetch-all-networks";
import { NETWORKS } from "@/lib/networks";
import type { PoolDailyFeeSnapshot, PoolSnapshotWindow } from "@/lib/types";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const REQUEST_DAY_MS = Date.UTC(2026, 5, 16, 12, 0, 0);
const TODAY_MIDNIGHT_SECONDS = Date.UTC(2026, 5, 16, 0, 0, 0) / 1000;
const YESTERDAY_MIDNIGHT_SECONDS = TODAY_MIDNIGHT_SECONDS - 86_400;

const requestMock = vi.fn();

function makeClient(): GraphQLClient {
  return { request: requestMock } as unknown as GraphQLClient;
}

function variablesAt(index: number): Record<string, unknown> {
  return requestMock.mock.calls[index]![0].variables as Record<string, unknown>;
}

function feeRow(
  id: string,
  timestamp: number,
  feesUsdWei = "1000000000000000000",
): PoolDailyFeeSnapshot {
  return {
    id,
    chainId: 42220,
    poolAddress: `0x${id.padStart(40, "0").slice(0, 40)}`,
    timestamp: String(timestamp),
    tokens: ["0xtoken"],
    tokenSymbols: ["USDm"],
    tokenDecimals: [18],
    amounts: ["1000000000000000000"],
    feesUsdWei,
  };
}

function poolSnapshotRow(
  poolId: string,
  timestamp: number,
  swapVolume0 = "1000000000000000000",
): PoolSnapshotWindow {
  return {
    poolId,
    timestamp: String(timestamp),
    reserves0: "1000000000000000000",
    reserves1: "1000000000000000000",
    swapCount: 1,
    swapVolume0,
    swapVolume1: "0",
  };
}

describe("incremental fee snapshot pagination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(REQUEST_DAY_MS));
    requestMock.mockReset();
    incrementalRowCache.clear();
    warnedCapKeys.clear();
    partialPageLastCapturedAt.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first call paginates with afterTimestamp 0 and seeds the cache", async () => {
    requestMock.mockResolvedValueOnce({
      PoolDailyFeeSnapshot: [feeRow("today", TODAY_MIDNIGHT_SECONDS)],
    });

    const result = await fetchAllFeeSnapshotPages(
      makeClient(),
      42220,
      "celo-mainnet",
    );

    expect(result.error).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(variablesAt(0)).toMatchObject({
      chainId: 42220,
      afterTimestamp: 0,
      limit: 1000,
      offset: 0,
    });
    expect(
      incrementalRowCache.get("celo-mainnet:PoolDailyFeeSnapshot"),
    ).toBeDefined();
  });

  it("second call fetches the mutable tail and merges newest-first", async () => {
    const cachedToday = feeRow("today", TODAY_MIDNIGHT_SECONDS, "1");
    const old = feeRow("old", TODAY_MIDNIGHT_SECONDS - 10 * 86_400, "2");
    const freshToday = feeRow("today", TODAY_MIDNIGHT_SECONDS, "9");
    const yesterday = feeRow("yesterday", YESTERDAY_MIDNIGHT_SECONDS, "3");
    requestMock
      .mockResolvedValueOnce({ PoolDailyFeeSnapshot: [cachedToday, old] })
      .mockResolvedValueOnce({
        PoolDailyFeeSnapshot: [freshToday, yesterday],
      });

    await fetchAllFeeSnapshotPages(makeClient(), 42220, "celo-mainnet");
    const result = await fetchAllFeeSnapshotPages(
      makeClient(),
      42220,
      "celo-mainnet",
    );

    expect(variablesAt(1)).toMatchObject({
      chainId: 42220,
      afterTimestamp: YESTERDAY_MIDNIGHT_SECONDS,
      limit: 1000,
      offset: 0,
    });
    expect(result.truncated).toBe(false);
    expect(result.error).toBeNull();
    expect(result.rows.map((row) => row.id)).toEqual([
      "today",
      "yesterday",
      "old",
    ]);
    expect(result.rows[0]!.feesUsdWei).toBe("9");
  });

  it("incremental first-page rejection returns cached rows plus an error", async () => {
    const cached = feeRow("today", TODAY_MIDNIGHT_SECONDS);
    const upstreamError = new Error("tail timeout");
    requestMock
      .mockResolvedValueOnce({ PoolDailyFeeSnapshot: [cached] })
      .mockRejectedValueOnce(upstreamError);

    await fetchAllFeeSnapshotPages(makeClient(), 42220, "celo-mainnet");
    const result = await fetchAllFeeSnapshotPages(
      makeClient(),
      42220,
      "celo-mainnet",
    );

    expect(result.rows).toEqual([cached]);
    expect(result.truncated).toBe(true);
    expect(result.error).toBe(upstreamError);
  });

  it("full fetch that fails mid-loop does not seed the cache", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, index) =>
      feeRow(`row-${index}`, TODAY_MIDNIGHT_SECONDS - index),
    );
    requestMock
      .mockResolvedValueOnce({ PoolDailyFeeSnapshot: fullPage })
      .mockRejectedValueOnce(new Error("page 2 timeout"))
      .mockResolvedValueOnce({ PoolDailyFeeSnapshot: [] });

    const partial = await fetchAllFeeSnapshotPages(
      makeClient(),
      42220,
      "celo-mainnet",
    );
    expect(partial.truncated).toBe(true);
    expect(partial.error).not.toBeNull();
    expect(incrementalRowCache.size).toBe(0);

    await fetchAllFeeSnapshotPages(makeClient(), 42220, "celo-mainnet");

    expect(variablesAt(2)).toMatchObject({
      chainId: 42220,
      afterTimestamp: 0,
      limit: 1000,
      offset: 0,
    });
  });

  it("changing non-timestamp variables forces a full re-fetch", async () => {
    requestMock
      .mockResolvedValueOnce({
        PoolDailyFeeSnapshot: [feeRow("celo", TODAY_MIDNIGHT_SECONDS)],
      })
      .mockResolvedValueOnce({
        PoolDailyFeeSnapshot: [feeRow("other-chain", TODAY_MIDNIGHT_SECONDS)],
      });

    await fetchAllFeeSnapshotPages(makeClient(), 42220, "shared-network");
    await fetchAllFeeSnapshotPages(makeClient(), 143, "shared-network");

    expect(variablesAt(1)).toMatchObject({
      chainId: 143,
      afterTimestamp: 0,
      limit: 1000,
      offset: 0,
    });
  });
});

describe("incremental pool daily snapshot pagination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(REQUEST_DAY_MS));
    requestMock.mockReset();
    incrementalRowCache.clear();
    warnedCapKeys.clear();
    partialPageLastCapturedAt.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first call paginates with afterTimestamp 0 and seeds the cache", async () => {
    requestMock.mockResolvedValueOnce({
      PoolDailySnapshot: [poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS)],
    });

    const result = await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-a"],
      "celo-mainnet",
    );

    expect(result.error).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(variablesAt(0)).toMatchObject({
      poolIds: ["pool-a"],
      afterTimestamp: 0,
      limit: 1000,
      offset: 0,
    });
    expect(
      incrementalRowCache.get("celo-mainnet:PoolDailySnapshot"),
    ).toBeDefined();
  });

  it("second call fetches the mutable tail and merges by pool-day newest-first", async () => {
    const cachedToday = poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS, "1");
    const old = poolSnapshotRow(
      "pool-a",
      TODAY_MIDNIGHT_SECONDS - 10 * 86_400,
      "2",
    );
    const freshToday = poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS, "9");
    const yesterday = poolSnapshotRow(
      "pool-b",
      YESTERDAY_MIDNIGHT_SECONDS,
      "3",
    );
    requestMock
      .mockResolvedValueOnce({
        PoolDailySnapshot: [cachedToday, old],
      })
      .mockResolvedValueOnce({
        PoolDailySnapshot: [freshToday, yesterday],
      });

    await fetchAllDailySnapshotPages(makeClient(), ["pool-a"], "celo-mainnet");
    const result = await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-a"],
      "celo-mainnet",
    );

    expect(variablesAt(1)).toMatchObject({
      poolIds: ["pool-a"],
      afterTimestamp: YESTERDAY_MIDNIGHT_SECONDS,
      limit: 1000,
      offset: 0,
    });
    expect(result.truncated).toBe(false);
    expect(result.error).toBeNull();
    expect(result.rows.map((row) => `${row.poolId}:${row.timestamp}`)).toEqual([
      `pool-a:${TODAY_MIDNIGHT_SECONDS}`,
      `pool-b:${YESTERDAY_MIDNIGHT_SECONDS}`,
      `pool-a:${TODAY_MIDNIGHT_SECONDS - 10 * 86_400}`,
    ]);
    expect(result.rows[0]!.swapVolume0).toBe("9");
  });

  it("changing poolIds forces a full re-fetch", async () => {
    requestMock
      .mockResolvedValueOnce({
        PoolDailySnapshot: [poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS)],
      })
      .mockResolvedValueOnce({
        PoolDailySnapshot: [poolSnapshotRow("pool-b", TODAY_MIDNIGHT_SECONDS)],
      });

    await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-a"],
      "shared-network",
    );
    await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-b"],
      "shared-network",
    );

    expect(variablesAt(1)).toMatchObject({
      poolIds: ["pool-b"],
      afterTimestamp: 0,
      limit: 1000,
      offset: 0,
    });
  });

  it("keeps the cache when the same poolIds arrive in a different order", async () => {
    requestMock
      .mockResolvedValueOnce({
        PoolDailySnapshot: [
          poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS),
          poolSnapshotRow("pool-b", TODAY_MIDNIGHT_SECONDS),
        ],
      })
      .mockResolvedValueOnce({
        PoolDailySnapshot: [poolSnapshotRow("pool-b", TODAY_MIDNIGHT_SECONDS)],
      });

    await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-a", "pool-b"],
      "shared-network",
    );
    await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-b", "pool-a"],
      "shared-network",
    );

    expect(variablesAt(1)).toMatchObject({
      poolIds: ["pool-b", "pool-a"],
      afterTimestamp: YESTERDAY_MIDNIGHT_SECONDS,
      limit: 1000,
      offset: 0,
    });
  });

  it("seeds from SSR network data so the first client poll is incremental", async () => {
    const cachedToday = poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS, "1");
    const freshToday = poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS, "9");
    seedIncrementalRowCacheFromNetworkData([
      {
        network: NETWORKS["celo-mainnet"],
        pools: [{ id: "pool-a" }],
        snapshotsAllDaily: [cachedToday],
        snapshotsAllDailyError: null,
        snapshotsAllDailyTruncated: false,
        feeSnapshots: [],
        feeSnapshotsError: null,
        feeSnapshotsTruncated: false,
      } as unknown as NetworkData,
    ]);
    requestMock.mockResolvedValueOnce({
      PoolDailySnapshot: [freshToday],
    });

    const result = await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-a"],
      "celo-mainnet",
    );

    expect(variablesAt(0)).toMatchObject({
      poolIds: ["pool-a"],
      afterTimestamp: YESTERDAY_MIDNIGHT_SECONDS,
      limit: 1000,
      offset: 0,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.swapVolume0).toBe("9");
  });

  it("does not overwrite a warm cache with older SSR fallback rows", async () => {
    const polledToday = poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS, "9");
    const ssrToday = poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS, "1");

    incrementalRowCache.set("celo-mainnet:PoolDailySnapshot", {
      variablesKey: "pool-a",
      rows: [polledToday],
    });
    seedIncrementalRowCacheFromNetworkData([
      {
        network: NETWORKS["celo-mainnet"],
        pools: [{ id: "pool-a" }],
        snapshotsAllDaily: [ssrToday],
        snapshotsAllDailyError: null,
        snapshotsAllDailyTruncated: false,
        feeSnapshots: [],
        feeSnapshotsError: null,
        feeSnapshotsTruncated: false,
      } as unknown as NetworkData,
    ]);
    requestMock.mockRejectedValueOnce(new Error("tail failed"));

    const result = await fetchAllDailySnapshotPages(
      makeClient(),
      ["pool-a"],
      "celo-mainnet",
    );

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.swapVolume0).toBe("9");
  });

  it("does not seed the cache from degraded or empty SSR slices", () => {
    seedIncrementalRowCacheFromNetworkData([
      {
        network: NETWORKS["celo-mainnet"],
        pools: [{ id: "pool-a" }],
        snapshotsAllDaily: [poolSnapshotRow("pool-a", TODAY_MIDNIGHT_SECONDS)],
        snapshotsAllDailyError: null,
        snapshotsAllDailyTruncated: true,
        feeSnapshots: [],
        feeSnapshotsError: null,
        feeSnapshotsTruncated: false,
      } as unknown as NetworkData,
      {
        network: NETWORKS["monad-mainnet"],
        pools: [{ id: "pool-b" }],
        snapshotsAllDaily: [poolSnapshotRow("pool-b", TODAY_MIDNIGHT_SECONDS)],
        snapshotsAllDailyError: new Error("snapshot failed"),
        snapshotsAllDailyTruncated: false,
        feeSnapshots: [feeRow("fee-b", TODAY_MIDNIGHT_SECONDS)],
        feeSnapshotsError: new Error("fees failed"),
        feeSnapshotsTruncated: false,
      } as unknown as NetworkData,
    ]);

    expect(
      incrementalRowCache.get("celo-mainnet:PoolDailySnapshot"),
    ).toBeUndefined();
    expect(
      incrementalRowCache.get("celo-mainnet:PoolDailyFeeSnapshot"),
    ).toBeUndefined();
    expect(
      incrementalRowCache.get("monad-mainnet:PoolDailySnapshot"),
    ).toBeUndefined();
    expect(
      incrementalRowCache.get("monad-mainnet:PoolDailyFeeSnapshot"),
    ).toBeUndefined();
  });
});
