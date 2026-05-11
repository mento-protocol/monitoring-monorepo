import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolDailyVolumeRow } from "@/lib/leaderboard-pool";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("graphql-request", () => ({
  GraphQLClient: vi.fn(function GraphQLClient() {
    return {
      request: requestMock,
    };
  }),
}));

import { fetchPoolVolumeSnapshots } from "../use-pool-volume-snapshots";

function row(id: string): PoolDailyVolumeRow {
  return {
    id,
    chainId: 42220,
    poolId: `42220-0x${id.padStart(40, "0")}`,
    timestamp: "1778457600",
    swapCount: 1,
    swapCountIncludingSystem: 1,
    volumeUsdWei: "1000000000000000000",
    volumeUsdWeiIncludingSystem: "1000000000000000000",
  };
}

describe("fetchPoolVolumeSnapshots", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("paginates pool-day rows until the first short page", async () => {
    requestMock
      .mockResolvedValueOnce({
        PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
          row(String(i)),
        ),
      })
      .mockResolvedValueOnce({ PoolDailyVolumeSnapshot: [row("1000")] });

    const result = await fetchPoolVolumeSnapshots("https://hasura.test", 123);

    expect(result.partial).toBe(false);
    expect(result.rows).toHaveLength(1001);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]![0].variables).toMatchObject({
      afterTimestamp: 123,
      limit: 1000,
      offset: 0,
    });
    expect(requestMock.mock.calls[1]![0].variables).toMatchObject({
      offset: 1000,
    });
  });

  it("dedupes rows when offset pagination overlaps", async () => {
    requestMock
      .mockResolvedValueOnce({
        PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
          row(String(i)),
        ),
      })
      .mockResolvedValueOnce({
        PoolDailyVolumeSnapshot: [row("999"), row("1000")],
      });

    const result = await fetchPoolVolumeSnapshots("https://hasura.test", 123);

    expect(result.partial).toBe(false);
    expect(result.rows).toHaveLength(1001);
  });

  it("returns partial rows when a later page fails", async () => {
    requestMock
      .mockResolvedValueOnce({
        PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
          row(String(i)),
        ),
      })
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await fetchPoolVolumeSnapshots("https://hasura.test", 123);

    expect(result.partial).toBe(true);
    expect(result.rows).toHaveLength(1000);
  });
});
