import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPoolReserveHistory } from "../pool-reserve-history";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/graphql-fetch", () => ({
  GraphQLClient: class {
    request = request;
  },
}));

function row(block: number, log = 0) {
  return {
    id: `42220_${block}_${log}`,
    chainId: 42220,
    blockNumber: String(block),
    blockTimestamp: String(block),
    reserve0: "1",
    reserve1: "2",
    txHash: "0xtx",
  };
}

afterEach(() => {
  vi.useRealTimers();
  request.mockReset();
});

describe("reserve history pagination", () => {
  it("refreshes only the mutable last block and merges new logs without duplicates", async () => {
    request.mockResolvedValueOnce({ ReserveUpdate: [row(1), row(2, 9)] });
    const previous = await fetchPoolReserveHistory("endpoint", "pool", "All");
    request.mockResolvedValueOnce({
      ReserveUpdate: [row(2, 10), row(2, 9), row(3)],
    });
    const refreshed = await fetchPoolReserveHistory("endpoint", "pool", "All", {
      previous,
    });
    expect(request.mock.calls[1]![0].variables.afterBlock).toBe("1");
    expect(refreshed.rows.map((r) => r.id)).toEqual([
      "42220_1_0",
      "42220_2_9",
      "42220_2_10",
      "42220_3_0",
    ]);
    expect(previous.rows).toHaveLength(2);
  });

  it("drops expired rows when a rolling range refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4000 * 1000);
    request.mockResolvedValueOnce({ ReserveUpdate: [row(500), row(3900)] });
    const previous = await fetchPoolReserveHistory("endpoint", "pool", "1h");
    vi.setSystemTime(5000 * 1000);
    request.mockResolvedValueOnce({ ReserveUpdate: [row(3900), row(4900)] });
    const refreshed = await fetchPoolReserveHistory("endpoint", "pool", "1h", {
      previous,
    });
    expect(refreshed.from).toBe(1400);
    expect(refreshed.rows.map((r) => r.blockNumber)).toEqual(["3900", "4900"]);
  });

  it("stops pagination after cancellation, even if the current page still resolves", async () => {
    const controller = new AbortController();
    request.mockImplementationOnce(async ({ signal }) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      return { ReserveUpdate: Array.from({ length: 1000 }, (_, i) => row(i)) };
    });
    await expect(
      fetchPoolReserveHistory("endpoint", "pool", "All", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("loads beyond 1,000 events with a stable block/id cursor and fixed time bounds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const first = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    request
      .mockResolvedValueOnce({ ReserveUpdate: first })
      .mockResolvedValueOnce({ ReserveUpdate: [row(1001)] });
    const result = await fetchPoolReserveHistory(
      "https://example.com/graphql",
      "pool",
      "All",
    );
    expect(result.rows).toHaveLength(1001);
    expect(result.truncated).toBe(false);
    expect(request.mock.calls[1]![0].variables).toMatchObject({
      from: 0,
      to: result.to,
      afterBlock: "1000",
      afterId: "42220_1000_0",
      limit: 1000,
    });
  });

  it.each([
    ["1h", 3600],
    ["6h", 21600],
    ["1d", 86400],
    ["7d", 604800],
  ] as const)("fetches only the selected %s window", async (range, seconds) => {
    request.mockResolvedValue({ ReserveUpdate: [] });
    const result = await fetchPoolReserveHistory(
      "https://example.com/graphql",
      "pool",
      range,
    );
    expect(result.to - result.from).toBe(seconds);
    expect(request.mock.calls[0]![0].variables).toMatchObject({
      from: result.from,
      to: result.to,
    });
    expect(result.rows).toEqual([]);
  });

  it("plots same-block events in numeric log order after lexical cursor pagination", async () => {
    request.mockResolvedValue({ ReserveUpdate: [row(1, 10), row(1, 2)] });
    const result = await fetchPoolReserveHistory(
      "https://example.com/graphql",
      "pool",
      "All",
    );
    expect(result.rows.map((r) => r.id)).toEqual(["42220_1_2", "42220_1_10"]);
  });

  it("rejects partial page failures instead of presenting incomplete history as complete", async () => {
    request
      .mockResolvedValueOnce({
        ReserveUpdate: Array.from({ length: 1000 }, (_, i) => row(i)),
      })
      .mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(
      fetchPoolReserveHistory("https://example.com/graphql", "pool", "All"),
    ).rejects.toThrow("upstream unavailable");
  });

  it("reports the 100,000-event cap explicitly", async () => {
    request.mockImplementation(async ({ variables }) => ({
      ReserveUpdate: Array.from({ length: 1000 }, (_, i) =>
        row(Number(variables.afterBlock) + i + 1),
      ),
    }));
    const result = await fetchPoolReserveHistory(
      "https://example.com/graphql",
      "pool",
      "All",
    );
    expect(result.rows).toHaveLength(100000);
    expect(result.truncated).toBe(true);
    expect(request).toHaveBeenCalledTimes(100);
  });
});
