import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolDailyVolumeRow } from "@/lib/volume-pool";

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
    swapCountIncludingProtocolActors: 1,
    volumeUsdWei: "1000000000000000000",
    volumeUsdWeiIncludingProtocolActors: "1000000000000000000",
  };
}

describe("fetchPoolVolumeSnapshots", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    expect(result.afterTimestamp).toBe(123);
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

  it("uses a fresh abort deadline per page", async () => {
    requestMock
      .mockResolvedValueOnce({
        PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
          row(String(i)),
        ),
      })
      .mockResolvedValueOnce({ PoolDailyVolumeSnapshot: [row("1000")] });

    await fetchPoolVolumeSnapshots("https://hasura.test", 123);

    expect(requestMock.mock.calls[0]![0].signal).not.toBe(
      requestMock.mock.calls[1]![0].signal,
    );
  });

  it("caps later page abort deadlines to the overall poll budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    requestMock
      .mockImplementationOnce(() => {
        vi.setSystemTime(new Date("2026-06-16T12:00:54Z"));
        return Promise.resolve({
          PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
            row(String(i)),
          ),
        });
      })
      .mockResolvedValueOnce({ PoolDailyVolumeSnapshot: [row("1000")] });

    const result = await fetchPoolVolumeSnapshots("https://hasura.test", 123);

    expect(result.partial).toBe(false);
    expect(timeoutSpy.mock.calls[0]?.[0]).toBe(8000);
    expect(timeoutSpy.mock.calls[1]?.[0]).toBe(1000);
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

  it("returns partial rows instead of starting another request after the overall deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
    requestMock
      .mockImplementationOnce(() => {
        vi.setSystemTime(new Date("2026-06-16T12:00:54Z"));
        return Promise.resolve({
          PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
            row(String(i)),
          ),
        });
      })
      .mockImplementationOnce(() => {
        vi.setSystemTime(new Date("2026-06-16T12:00:56Z"));
        return Promise.resolve({
          PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
            row(String(1000 + i)),
          ),
        });
      });

    const result = await fetchPoolVolumeSnapshots("https://hasura.test", 123);

    expect(result.partial).toBe(true);
    expect(result.rows).toHaveLength(2000);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("does not mark the result partial when the max page boundary is exact", async () => {
    requestMock.mockImplementation(({ variables }) => {
      const offset = variables.offset as number;
      if (offset === 100_000) {
        return Promise.resolve({ PoolDailyVolumeSnapshot: [] });
      }
      return Promise.resolve({
        PoolDailyVolumeSnapshot: Array.from({ length: 1000 }, (_, i) =>
          row(String(offset + i)),
        ),
      });
    });

    const result = await fetchPoolVolumeSnapshots("https://hasura.test", 123);

    expect(result.partial).toBe(false);
    expect(result.rows).toHaveLength(100_000);
    expect(requestMock).toHaveBeenCalledTimes(101);
    expect(requestMock.mock.calls.at(-1)![0].variables).toMatchObject({
      offset: 100_000,
    });
  });
});
