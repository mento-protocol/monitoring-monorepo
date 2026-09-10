import { afterEach, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import { BRIDGE_STUCK_THRESHOLD_SECONDS } from "@mento-protocol/config/bridge-status";
import { aggregateBridgeTransfers, createBridgeMetrics } from "./metrics.js";
import {
  observeBridgeTransfers,
  BRIDGE_TRANSFERS_QUERY,
  type BridgeRow,
} from "./observation.js";
import { pollBridgeTransfers } from "./runtime.js";
import { BRIDGE_FRESHNESS_SECONDS } from "./config.js";

const row = (patch: Partial<BridgeRow> = {}): BridgeRow => ({
  id: "a",
  status: "SENT",
  sourceChainId: 137,
  destChainId: 143,
  tokenAddress: "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115",
  sentTimestamp: "100",
  firstSeenAt: "100",
  lastUpdatedAt: "100",
  lastAttestedTimestamp: null,
  ...patch,
});
const response = (rows: BridgeRow[]) => ({ BridgeTransfer: rows });
const value = async (
  registry: Registry,
  name: string,
  labels?: Record<string, string>,
) => {
  const metric = (await registry.getMetricsAsJSON()).find(
    (metric) => metric.name === `mento_ntt_bridge_${name}`,
  );
  return metric?.values.find(
    (sample) =>
      !labels ||
      Object.entries(labels).every(([key, val]) => sample.labels[key] === val),
  )?.value;
};
const labels = {
  source_chain: "137",
  destination_chain: "143",
  token: "USDm",
  status: "SENT",
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("complete bridge observation", () => {
  it("queries by stable ID and retains unknown endpoints", () => {
    expect(BRIDGE_TRANSFERS_QUERY).toContain("order_by: { id: asc }");
    expect(BRIDGE_TRANSFERS_QUERY).toContain("_is_null: true");
    expect(BRIDGE_TRANSFERS_QUERY).toContain(
      'status: { _nin: ["DELIVERED", "CANCELLED", "FAILED"] }',
    );
  });
  it("reads multiple pages, deduplicates IDs and keeps later row evidence", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(response([row(), row({ id: "b" })]))
      .mockResolvedValueOnce(
        response([row({ id: "b", status: "ATTESTED" }), row({ id: "c" })]),
      )
      .mockResolvedValueOnce(response([]));
    const result = await observeBridgeTransfers({ fetchPage, pageSize: 2 });
    expect(result.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result[1]?.status).toBe("ATTESTED");
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual(["", "b", "c"]);
  });
  it("fails the whole observation when a later page fails", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(response([row()]))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      observeBridgeTransfers({ fetchPage, pageSize: 1 }),
    ).rejects.toThrow("offline");
  });
  it("does not treat a full final page as complete", async () => {
    await expect(
      observeBridgeTransfers({
        fetchPage: async () => response([row()]),
        pageSize: 1,
        maxPages: 1,
      }),
    ).rejects.toThrow("page budget");
  });
  it("bounds rows including duplicate records", async () => {
    await expect(
      observeBridgeTransfers({
        fetchPage: async () => response([row(), row({ id: "b" })]),
        pageSize: 2,
        maxRows: 1,
      }),
    ).rejects.toThrow("row budget");
  });
  it("rejects oversized and malformed responses", async () => {
    await expect(
      observeBridgeTransfers({
        fetchPage: async () => response([row(), row()]),
        pageSize: 1,
      }),
    ).rejects.toThrow("requested limit");
    await expect(
      observeBridgeTransfers({
        fetchPage: async () => ({ BridgeTransfer: [{}] }),
      }),
    ).rejects.toThrow();
  });
  it("rejects a cursor that does not advance", async () => {
    await expect(
      observeBridgeTransfers({
        fetchPage: async () => response([row()]),
        pageSize: 1,
      }),
    ).rejects.toThrow("did not advance");
  });
  it("times out even if a request ignores its abort signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = observeBridgeTransfers({
      timeoutMs: 10,
      fetchPage: async (_after, _limit, inputSignal) => {
        signal = inputSignal;
        return new Promise(() => {});
      },
    });
    const rejected = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
});

describe("bounded bridge aggregation", () => {
  it("separates healthy count from stuck count at the exact boundary", () => {
    const snapshot = aggregateBridgeTransfers(
      [
        row(),
        row({ id: "b", lastUpdatedAt: "99" }),
        row({ id: "c", lastUpdatedAt: "200" }),
      ],
      3700,
    );
    expect(
      snapshot.buckets.find(
        (bucket) =>
          bucket.labels.token === "USDm" &&
          bucket.labels.status === "SENT" &&
          bucket.labels.source_chain === "137" &&
          bucket.labels.destination_chain === "143",
      ),
    ).toMatchObject({ count: 3, stuck: 1, oldest: 3601 });
    expect(snapshot.invalidRows).toBe(0);
  });
  it("retains destination-first rows and bounded unknown labels", () => {
    const snapshot = aggregateBridgeTransfers(
      [
        row({
          sourceChainId: null,
          destChainId: 137,
          tokenAddress: "untrusted-address",
          status: "NEW_STATUS",
          sentTimestamp: null,
          firstSeenAt: null,
          lastUpdatedAt: null,
        }),
      ],
      5000,
    );
    expect(snapshot.buckets.find((bucket) => bucket.count === 1)).toMatchObject(
      {
        labels: {
          source_chain: "unknown",
          destination_chain: "137",
          token: "unknown",
          status: "unknown",
        },
        oldest: 0,
        stuck: 0,
      },
    );
    expect(snapshot.invalidRows).toBe(1);
    expect(JSON.stringify(snapshot.buckets)).not.toContain("untrusted-address");
    expect(JSON.stringify(snapshot.buckets)).not.toContain("NEW_STATUS");
  });
  it("uses attestation rather than backdated source progress", () => {
    const snapshot = aggregateBridgeTransfers(
      [
        row({
          status: "ATTESTED",
          lastAttestedTimestamp: "4999",
          lastUpdatedAt: "1",
        }),
      ],
      5000,
    );
    expect(snapshot.buckets.find((bucket) => bucket.count === 1)).toMatchObject(
      { stuck: 0, oldest: 1 },
    );
  });
  it("supports EURm and destination-first canonical token lookup", () => {
    const snapshot = aggregateBridgeTransfers(
      [
        row({
          tokenAddress: "0x4d502d735b4c574b487ed641ae87ceae884731c7",
          sourceChainId: null,
          destChainId: 137,
        }),
      ],
      100,
    );
    expect(
      snapshot.buckets.find((bucket) => bucket.count === 1)?.labels.token,
    ).toBe("EURm");
  });
  it("keeps missing and future time visible without false age", () => {
    const snapshot = aggregateBridgeTransfers(
      [
        row({ sentTimestamp: "0", firstSeenAt: "NaN", lastUpdatedAt: null }),
        row({ id: "b", lastUpdatedAt: "10000" }),
      ],
      5000,
    );
    expect(snapshot.invalidRows).toBe(2);
    expect(snapshot.buckets.find((bucket) => bucket.count === 2)).toMatchObject(
      { oldest: 0, stuck: 0 },
    );
  });
  it("excludes terminal and unrelated known routes, deduplicates rows", () => {
    const snapshot = aggregateBridgeTransfers(
      [
        row(),
        row(),
        row({ id: "b", status: "DELIVERED" }),
        row({ id: "c", sourceChainId: 42220, destChainId: 143 }),
      ],
      5000,
    );
    expect(
      snapshot.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    ).toBe(1);
  });
});

describe("snapshot lifecycle", () => {
  it("exports exactly the four thresholds used by the stuck counters", async () => {
    const registry = new Registry();
    const metrics = createBridgeMetrics(registry);
    for (const [status, seconds] of Object.entries(
      BRIDGE_STUCK_THRESHOLD_SECONDS,
    )) {
      expect(
        await value(registry, "warning_threshold_seconds", { status }),
      ).toBe(seconds);
      const transfer = row({ status, lastAttestedTimestamp: "100" });
      metrics.publish([transfer], 100 + seconds);
      expect(
        await value(registry, "stuck_transfers", { ...labels, status }),
      ).toBe(0);
      metrics.publish([transfer], 101 + seconds);
      expect(
        await value(registry, "stuck_transfers", { ...labels, status }),
      ).toBe(1);
    }
    const family = (await registry.getMetricsAsJSON()).find(
      (metric) => metric.name === "mento_ntt_bridge_warning_threshold_seconds",
    );
    expect(family?.values).toHaveLength(4);
    metrics.fail();
    expect(
      await value(registry, "warning_threshold_seconds", { status: "SENT" }),
    ).toBe(BRIDGE_STUCK_THRESHOLD_SECONDS.SENT);
  });

  it("distinguishes startup, success, failure, empty success and resumed work", async () => {
    const registry = new Registry();
    const metrics = createBridgeMetrics(registry);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await value(registry, "observation_error")).toBe(1);
    expect(await value(registry, "last_success_timestamp_seconds")).toBe(0);
    expect(await value(registry, "transfers", labels)).toBeUndefined();
    expect(await value(registry, "freshness_limit_seconds")).toBe(
      BRIDGE_FRESHNESS_SECONDS,
    );
    await pollBridgeTransfers(
      metrics,
      async () => [row()],
      () => 5_000_000,
    );
    expect(await value(registry, "transfers", labels)).toBe(1);
    expect(await value(registry, "stuck_transfers", labels)).toBe(1);
    expect(await value(registry, "oldest_state_age_seconds", labels)).toBe(
      4900,
    );
    expect(await value(registry, "last_success_timestamp_seconds")).toBe(5000);
    expect(await value(registry, "observation_error")).toBe(0);
    await pollBridgeTransfers(
      metrics,
      async () => {
        throw new Error("later page failed");
      },
      () => 6_000_000,
    );
    expect(await value(registry, "transfers", labels)).toBe(1);
    expect(await value(registry, "stuck_transfers", labels)).toBe(1);
    expect(await value(registry, "last_success_timestamp_seconds")).toBe(5000);
    expect(await value(registry, "observation_error")).toBe(1);
    await pollBridgeTransfers(
      metrics,
      async () => [],
      () => 7_000_000,
    );
    expect(await value(registry, "transfers", labels)).toBe(0);
    expect(await value(registry, "stuck_transfers", labels)).toBe(0);
    expect(await value(registry, "oldest_state_age_seconds", labels)).toBe(0);
    expect(await value(registry, "last_success_timestamp_seconds")).toBe(7000);
    expect(await value(registry, "observation_error")).toBe(0);
    await pollBridgeTransfers(
      metrics,
      async () => [row()],
      () => 8_000_000,
    );
    expect(await value(registry, "transfers", labels)).toBe(1);
    const restarted = new Registry();
    createBridgeMetrics(restarted);
    expect(await value(restarted, "last_success_timestamp_seconds")).toBe(0);
    expect(await value(restarted, "transfers", labels)).toBeUndefined();
  });
});
