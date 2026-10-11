import { afterEach, describe, expect, it, vi } from "vitest";
import { createReserveHistoryResource } from "../reserve-history-resource";

const fetchHistory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pool-reserve-history", () => ({
  fetchPoolReserveHistory: fetchHistory,
}));
afterEach(() => fetchHistory.mockReset());

describe("reserve history resource", () => {
  it("retains last-good history across a failed refresh for the next incremental fetch", async () => {
    const previous = { rows: [], from: 0, to: 100, truncated: false };
    fetchHistory
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(previous);
    const resource = createReserveHistoryResource("endpoint", "pool", "All");
    await resource.fetch();
    await expect(resource.fetch()).rejects.toThrow("offline");
    await resource.fetch();
    expect(fetchHistory.mock.calls[1]![3].previous).toBe(previous);
    expect(fetchHistory.mock.calls[2]![3].previous).toBe(previous);
  });

  it("does not cancel an active request during Strict Mode effect reattachment", async () => {
    fetchHistory.mockResolvedValue({
      rows: [],
      from: 0,
      to: 100,
      truncated: false,
    });
    const resource = createReserveHistoryResource("endpoint", "pool", "All");
    const release = resource.retain();
    const pending = resource.fetch();
    release();
    const releaseAgain = resource.retain();
    await pending;
    expect(fetchHistory.mock.calls[0]![3].signal.aborted).toBe(false);
    releaseAgain();
    await Promise.resolve();
    expect(fetchHistory.mock.calls[0]![3].signal.aborted).toBe(true);
  });
});
