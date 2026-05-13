import { describe, expect, it } from "vitest";

import { fetchBrokerViaMarkerPages } from "../leaderboard-via";

function mockClient(pages: Array<Array<{ id: string }>>): {
  calls: Array<Record<string, unknown>>;
  signals: Array<AbortSignal | undefined>;
  client: Parameters<typeof fetchBrokerViaMarkerPages>[0];
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

describe("fetchBrokerViaMarkerPages", () => {
  it("paginates marker ids with an id cursor until the final short page", async () => {
    const { client, calls, signals } = mockClient([
      [{ id: "42220-direct-0x1-1" }, { id: "42220-direct-0x1-2" }],
      [{ id: "42220-squid-0x1-3" }],
    ]);

    const result = await fetchBrokerViaMarkerPages(client, "marker-regex", {
      pageSize: 2,
      maxPages: 4,
    });

    expect(result).toEqual({
      rows: [
        { id: "42220-direct-0x1-1" },
        { id: "42220-direct-0x1-2" },
        { id: "42220-squid-0x1-3" },
      ],
      truncated: false,
    });
    expect(calls).toEqual([
      { idRegex: "marker-regex", afterId: "", limit: 2 },
      { idRegex: "marker-regex", afterId: "42220-direct-0x1-2", limit: 2 },
    ]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it("marks results truncated when every allowed page is full", async () => {
    const { client } = mockClient([
      [{ id: "42220-direct-0x1-1" }],
      [{ id: "42220-direct-0x1-2" }],
    ]);

    const result = await fetchBrokerViaMarkerPages(client, "marker-regex", {
      pageSize: 1,
      maxPages: 2,
    });

    expect(result.rows).toEqual([
      { id: "42220-direct-0x1-1" },
      { id: "42220-direct-0x1-2" },
    ]);
    expect(result.truncated).toBe(true);
  });
});
