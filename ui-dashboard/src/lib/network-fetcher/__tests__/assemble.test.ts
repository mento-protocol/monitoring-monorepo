import { describe, expect, it } from "vitest";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import { assembleNetworkData, resolveWindowErrors } from "../assemble";

// An arbitrary but realistic epoch anchor — large enough that every
// window's `from` bound (up to 30 days back) stays comfortably positive.
const NOW = 1_700_000_000;
const WINDOWS = {
  w24h: { from: NOW - 86_400, to: NOW },
  w7d: { from: NOW - 7 * 86_400, to: NOW },
  w30d: { from: NOW - 30 * 86_400, to: NOW },
};

describe("resolveWindowErrors — precedence matrix", () => {
  it("no issues at all: every window is clean", () => {
    const result = resolveWindowErrors({
      windows: WINDOWS,
      oldestFetchedTs: 0,
      paginationIssue: null,
      mutableTailIssue: null,
      mutableTailFrom: 0,
    });

    expect(result).toEqual({
      snapshotsError: null,
      snapshots7dError: null,
      snapshots30dError: null,
    });
  });

  it("pagination issue present but every window is fully covered: no errors", () => {
    const paginationIssue = new Error("truncated");
    const result = resolveWindowErrors({
      windows: WINDOWS,
      oldestFetchedTs: 0, // covers every window's `from` bound
      paginationIssue,
      mutableTailIssue: null,
      mutableTailFrom: 0,
    });

    expect(result).toEqual({
      snapshotsError: null,
      snapshots7dError: null,
      snapshots30dError: null,
    });
  });

  it("truncated-but-not-errored: pagination issue degrades only windows it falls short of", () => {
    const paginationIssue = new Error("truncated");
    // oldestFetchedTs sits between the 24h and 7d bounds — 24h is covered,
    // 7d/30d are not.
    const oldestFetchedTs = WINDOWS.w24h.from - 1;
    const result = resolveWindowErrors({
      windows: WINDOWS,
      oldestFetchedTs,
      paginationIssue,
      mutableTailIssue: null,
      mutableTailFrom: 0,
    });

    expect(result.snapshotsError).toBeNull();
    expect(result.snapshots7dError).toBe(paginationIssue);
    expect(result.snapshots30dError).toBe(paginationIssue);
  });

  it("mutable-tail issue present but no window reaches the mutable range: no errors", () => {
    const mutableTailIssue = new Error("tail refresh failed");
    const result = resolveWindowErrors({
      windows: WINDOWS,
      oldestFetchedTs: 0,
      paginationIssue: null,
      mutableTailIssue,
      // Every window's `to` bound sits at or before mutableTailFrom, so
      // `windowTo > mutableTailFrom` is false for all three.
      mutableTailFrom: WINDOWS.w30d.to,
    });

    expect(result).toEqual({
      snapshotsError: null,
      snapshots7dError: null,
      snapshots30dError: null,
    });
  });

  it("errored-tail: mutable-tail issue degrades every window that extends into the mutable range", () => {
    const mutableTailIssue = new Error("tail refresh failed");
    const result = resolveWindowErrors({
      windows: WINDOWS,
      oldestFetchedTs: 0,
      paginationIssue: null,
      mutableTailIssue,
      // Every window's `to` bound is the same "now" anchor, so all three
      // extend past a cutoff set well before it.
      mutableTailFrom: WINDOWS.w24h.from - 1,
    });

    expect(result.snapshotsError).toBe(mutableTailIssue);
    expect(result.snapshots7dError).toBe(mutableTailIssue);
    expect(result.snapshots30dError).toBe(mutableTailIssue);
  });

  it("precedence: mutable-tail issue wins over a pagination issue on the same window", () => {
    const paginationIssue = new Error("truncated");
    const mutableTailIssue = new Error("tail refresh failed");
    // A synthetic window set (independent `to` bounds per window — unlike
    // the real caller, which shares one "now" `to` across all three) lets
    // this test isolate a single window where BOTH conditions hold from a
    // window where only pagination applies.
    const customWindows = {
      w24h: { from: 50, to: 1000 },
      w7d: { from: 50, to: 500 },
      w30d: { from: 50, to: 500 },
    };
    const result = resolveWindowErrors({
      windows: customWindows,
      // > every window's `from` (50), so pagination alone would flag all three.
      oldestFetchedTs: 200,
      paginationIssue,
      mutableTailIssue,
      // Only w24h's `to` (1000) exceeds this.
      mutableTailFrom: 600,
    });

    // w24h: both conditions hold — mutable-tail wins.
    expect(result.snapshotsError).toBe(mutableTailIssue);
    // w7d/w30d: mutable-tail doesn't apply (`to` <= mutableTailFrom), so the
    // pagination issue applies instead.
    expect(result.snapshots7dError).toBe(paginationIssue);
    expect(result.snapshots30dError).toBe(paginationIssue);
  });
});

describe("assembleNetworkData — pure composition", () => {
  const network: Network = {
    id: "celo-mainnet",
    label: "Celo",
    chainId: 42220,
    contractsNamespace: null,
    hasuraUrl: "https://hasura.example.com/v1/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://celoscan.io",
    tokenSymbols: {},
    addressLabels: {},
    local: false,
    hasVirtualPools: false,
    testnet: false,
  };

  const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({
    status: "fulfilled",
    value,
  });
  const rejected = (reason: unknown): PromiseSettledResult<never> => ({
    status: "rejected",
    reason,
  });

  const baseArgs = {
    network,
    windows: WINDOWS,
    pools: [] as Pool[],
    snapshotTailNowMs: WINDOWS.w24h.to * 1000,
    feeSnapshotsResult: fulfilled({
      rows: [],
      truncated: false,
      error: null,
    }),
    snapshotsAllDailyResult: fulfilled({
      rows: [],
      truncated: false,
      error: null,
    }),
    brokerSnapshotsAllDailyResult: fulfilled({
      rows: [],
      truncated: false,
      error: null,
    }),
    lpResult: fulfilled({ rows: [], truncated: false, error: null }),
    olsPoolIds: new Set<string>(),
    cdpPoolIds: new Set<string>(),
    reservePoolIds: new Set<string>(),
    strategyError: null,
  };

  it("assembles a fully-healthy NetworkData with no I/O", () => {
    const result = assembleNetworkData(baseArgs);

    expect(result.network).toBe(network);
    expect(result.snapshotWindows).toBe(WINDOWS);
    expect(result.pools).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.feeSnapshotsError).toBeNull();
    expect(result.snapshotsAllDailyError).toBeNull();
    expect(result.brokerSnapshotsAllDailyError).toBeNull();
    expect(result.brokerSnapshotsAllDailyCapped).toBe(false);
    expect(result.lpError).toBeNull();
    expect(result.strategyError).toBeNull();
    expect(result.olsPoolIds).toEqual(new Set());
    expect(result.uniqueLpAddresses).toEqual([]);
    expect(result.rates).toBeInstanceOf(Map);
  });

  it("propagates a rejected source straight through to its error channel", () => {
    const lpErr = new Error("LP query down");
    const result = assembleNetworkData({
      ...baseArgs,
      lpResult: rejected(lpErr),
    });

    expect(result.lpError).toBe(lpErr);
    expect(result.uniqueLpAddresses).toBeNull();
    // Unrelated slices are unaffected.
    expect(result.feeSnapshotsError).toBeNull();
  });

  it("mutable-tail error in a fulfilled snapshot result degrades every current window", () => {
    const tailErr = new Error("tail refresh failed");
    const result = assembleNetworkData({
      ...baseArgs,
      snapshotsAllDailyResult: fulfilled({
        rows: [],
        truncated: false,
        error: null,
        mutableTailError: tailErr,
      }),
      // mutableTailFrom sits just below every window's `to` bound, so all
      // three windows extend into the mutable range and inherit the error.
      snapshotTailNowMs: WINDOWS.w24h.to * 1000 - 1,
    });

    expect(result.snapshotsError).toBe(tailErr);
    expect(result.snapshots7dError).toBe(tailErr);
    expect(result.snapshots30dError).toBe(tailErr);
  });

  it("keeps Broker history capped when pagination returns partial rows", () => {
    const result = assembleNetworkData({
      ...baseArgs,
      brokerSnapshotsAllDailyResult: fulfilled({
        rows: [
          {
            id: "broker-partial",
            timestamp: String(NOW),
            volumeUsdWei: "1",
            swapCount: 1,
          },
        ],
        truncated: true,
        error: new Error("page 2 failed"),
      }),
    });

    expect(result.brokerSnapshotsAllDaily).toHaveLength(1);
    expect(result.brokerSnapshotsAllDailyTruncated).toBe(true);
    expect(result.brokerSnapshotsAllDailyCapped).toBe(true);
    expect(result.brokerSnapshotsAllDailyError?.message).toBe("page 2 failed");
  });

  it("marks Broker history capped when its first page rejects", () => {
    const result = assembleNetworkData({
      ...baseArgs,
      brokerSnapshotsAllDailyResult: rejected(new Error("Broker unavailable")),
    });

    expect(result.brokerSnapshotsAllDaily).toEqual([]);
    expect(result.brokerSnapshotsAllDailyTruncated).toBe(false);
    expect(result.brokerSnapshotsAllDailyCapped).toBe(true);
    expect(result.brokerSnapshotsAllDailyError?.message).toBe(
      "Broker unavailable",
    );
  });
});
