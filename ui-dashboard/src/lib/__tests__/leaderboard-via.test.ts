import { describe, expect, it } from "vitest";

import {
  fetchBrokerTraderRouterMarkers,
  type BrokerViaMarkerPageResult,
} from "../leaderboard-via";
import type { BrokerTraderRouterMarkerRow } from "../leaderboard";
import { ENVIO_MAX_ROWS } from "../constants";

function mockClient(pages: Array<Array<BrokerTraderRouterMarkerRow>>): {
  calls: Array<Record<string, unknown>>;
  signals: Array<AbortSignal | undefined>;
  client: Parameters<typeof fetchBrokerTraderRouterMarkers>[0];
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
          BrokerTraderRouterDayMarker: pages.shift() ?? [],
        } as T;
      },
    },
  };
}

function row(
  caller: string,
  txTo: string,
  aggregator: string,
  timestamp: string,
): BrokerTraderRouterMarkerRow {
  return {
    id: `42220-${caller}-${txTo}-${timestamp}`,
    chainId: 42220,
    caller,
    txTo,
    aggregator,
    timestamp,
  };
}

describe("fetchBrokerTraderRouterMarkers", () => {
  it("chunks callers, shares one timeout signal, and merges responses", async () => {
    const { client, calls, signals } = mockClient([
      [row("0xa", "0xr1", "squid", "1778457600")],
      [row("0xb", "0xr1", "unknown", "1778457600")],
    ]);

    const result = await fetchBrokerTraderRouterMarkers(
      client,
      ["0xa", "0xb"],
      1778457600,
      { chunkSize: 1 },
    );

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(calls).toEqual([
      { callers: ["0xa"], afterTimestamp: 1778457600, limit: ENVIO_MAX_ROWS },
      { callers: ["0xb"], afterTimestamp: 1778457600, limit: ENVIO_MAX_ROWS },
    ]);
    expect(signals[0]).toBe(signals[1]);
  });

  it("lowercases + dedupes the caller list before chunking", async () => {
    const { client, calls } = mockClient([
      [row("0xa", "0xr1", "squid", "1778457600")],
    ]);

    await fetchBrokerTraderRouterMarkers(client, ["0xA", "0xa"], 1778457600);

    expect(calls).toEqual([
      { callers: ["0xa"], afterTimestamp: 1778457600, limit: ENVIO_MAX_ROWS },
    ]);
  });

  it("returns empty + truncated=false for an empty caller list or 0 cutoff", async () => {
    const { client, calls } = mockClient([]);
    const empty = await fetchBrokerTraderRouterMarkers(client, [], 1778457600);
    expect(empty satisfies BrokerViaMarkerPageResult).toEqual({
      rows: [],
      truncated: false,
    });
    expect(calls).toEqual([]);

    const noCutoff = await fetchBrokerTraderRouterMarkers(client, ["0xa"], 0);
    expect(noCutoff).toEqual({ rows: [], truncated: false });
  });

  it("flags truncated when a chunk hits the row cap", async () => {
    // Build a synthetic page exactly the size of ENVIO_MAX_ROWS so the fetcher
    // can't tell whether more rows exist server-side. The fetcher surfaces the
    // truncated flag so the UI can render an explicit "couldn't load complete"
    // banner rather than silently dropping data.
    const fullPage = Array.from({ length: ENVIO_MAX_ROWS }, (_, i) =>
      row("0xa", `0xr${i}`, "unknown", "1778457600"),
    );
    const { client } = mockClient([fullPage]);

    const result = await fetchBrokerTraderRouterMarkers(
      client,
      ["0xa"],
      1778457600,
    );
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(ENVIO_MAX_ROWS);
  });
});
