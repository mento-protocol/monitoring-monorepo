import { describe, expect, it } from "vitest";

import { fetchBrokerViaMarkerIds } from "../leaderboard-via";

function mockClient(pages: Array<Array<{ id: string }>>): {
  calls: Array<Record<string, unknown>>;
  signals: Array<AbortSignal | undefined>;
  client: Parameters<typeof fetchBrokerViaMarkerIds>[0];
} {
  const calls: Array<Record<string, unknown>> = [];
  const signals: Array<AbortSignal | undefined> = [];
  return {
    calls,
    signals,
    client: {
      async request<T>({
        variables,
        signal,
      }: {
        variables: Record<string, unknown>;
        signal?: AbortSignal;
      }) {
        calls.push(variables);
        signals.push(signal);
        return {
          BrokerAggregatorTraderDayMarker: pages.shift() ?? [],
        } as T;
      },
    },
  };
}

describe("fetchBrokerViaMarkerIds", () => {
  it("fetches exact marker ids in bounded chunks with one shared timeout", async () => {
    const { client, calls, signals } = mockClient([
      [{ id: "42220-direct-0x1-1" }, { id: "42220-direct-0x1-2" }],
      [{ id: "42220-squid-0x1-3" }],
    ]);

    const result = await fetchBrokerViaMarkerIds(
      client,
      ["42220-direct-0x1-1", "42220-direct-0x1-2", "42220-squid-0x1-3"],
      {
        chunkSize: 2,
      },
    );

    expect(result).toEqual({
      rows: [
        { id: "42220-direct-0x1-1" },
        { id: "42220-direct-0x1-2" },
        { id: "42220-squid-0x1-3" },
      ],
      truncated: false,
    });

    expect(calls).toEqual([
      { ids: ["42220-direct-0x1-1", "42220-direct-0x1-2"], limit: 2 },
      { ids: ["42220-squid-0x1-3"], limit: 1 },
    ]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it("deduplicates ids before chunking", async () => {
    const { client, calls } = mockClient([[{ id: "42220-direct-0x1-1" }]]);

    const result = await fetchBrokerViaMarkerIds(client, [
      "42220-direct-0x1-1",
      "42220-direct-0x1-1",
    ]);

    expect(result.rows).toEqual([{ id: "42220-direct-0x1-1" }]);
    expect(calls).toEqual([{ ids: ["42220-direct-0x1-1"], limit: 1 }]);
  });

  it("marks results truncated when the generated id set exceeds the safety cap", async () => {
    const { client, calls } = mockClient([]);

    const result = await fetchBrokerViaMarkerIds(
      client,
      ["42220-direct-0x1-1", "42220-direct-0x1-2"],
      { maxIds: 1 },
    );

    expect(result).toEqual({ rows: [], truncated: true });
    expect(calls).toEqual([]);
  });
});
