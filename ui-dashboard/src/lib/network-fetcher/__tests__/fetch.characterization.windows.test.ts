// Characterization tests for `fetchNetworkData`'s current behavior (#1055).
// These pin the orchestrator's output BEFORE its internals are decomposed
// into per-source fetch modules + a pure `assembleNetworkData`. They must
// keep passing UNCHANGED once that refactor lands — only mechanical renames
// are allowed on this file afterward. Shared fixtures live in
// `characterization-fixtures.ts`; the per-source success/failure matrix
// lives in `fetch.characterization.sources.test.ts`.
//
// Coverage matrix (this file):
//   - the per-window pagination-truncation vs mutable-tail-error precedence,
//     both the truncated-but-not-errored case and the errored-tail case
//   - an empty network (zero pools)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDetectProbedStrategies } = vi.hoisted(() => ({
  mockDetectProbedStrategies: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/strategy-detection", () => ({
  detectProbedStrategies: mockDetectProbedStrategies,
}));

vi.mock("@/lib/graphql-fetch", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import {
  fetchNetworkData,
  incrementalRowCache,
  partialPageLastCapturedAt,
  warnedCapKeys,
} from "../fetch";
import {
  CELO_NETWORK,
  installGraphQLMock,
  makePool,
  reject,
  WINDOWS,
} from "./characterization-fixtures";

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectProbedStrategies.mockResolvedValue({
    cdpPoolIds: new Set<string>(),
    reservePoolIds: new Set<string>(),
  });
  incrementalRowCache.clear();
  warnedCapKeys.clear();
  partialPageLastCapturedAt.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchNetworkData characterization — window error precedence", () => {
  const makeDaily = (timestamp: number, poolId = "pool-window") => ({
    poolId,
    timestamp: String(timestamp),
    reserves0: "0",
    reserves1: "0",
    swapCount: 1,
    swapVolume0: "1000000000000000000",
    swapVolume1: "2000000000000000000",
  });

  it("truncated-but-not-errored: pagination cap hit, no per-window error for windows fully covered", async () => {
    // 12-hour spacing so 1000 rows (the pagination cap) spans far more than
    // 30 real days — every window is covered by preserved rows, so hitting
    // the cap flags `snapshotsAllDailyTruncated` without an `error` and
    // without degrading any individual window.
    const now = Math.floor(Date.now() / 1000);
    const pool = makePool("42220-0xtrunc", { id: "pool-window" });
    let rowCursor = 0;
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      PoolDailySnapshotsAll: () => ({
        PoolDailySnapshot: Array.from({ length: 1000 }, () =>
          makeDaily(now - rowCursor++ * 43200),
        ),
      }),
    });

    const result = await fetchNetworkData(CELO_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    expect(result.snapshotsAllDailyTruncated).toBe(true);
    expect(result.snapshotsAllDailyError).toBeNull();
    expect(result.snapshotsError).toBeNull();
    expect(result.snapshots7dError).toBeNull();
    expect(result.snapshots30dError).toBeNull();
  });

  it("truncated-but-not-errored: truncation alone degrades only the windows it falls short of", async () => {
    // Every page is completely full (never a short page) so the loop only
    // stops by hitting the pagination safety cap — truncation, not a fetch
    // error. With 1-second row spacing, 100 pages x 1000 rows only reaches
    // ~1.16 days back: within the 24h window's bound, but short of the
    // 7d/30d bounds, so only those two pick up the synthetic truncation
    // error while `error` stays null throughout.
    const now = Math.floor(Date.now() / 1000);
    const pool = makePool("42220-0xtrunc-window", { id: "pool-window" });
    let rowCursor = 0;
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      PoolDailySnapshotsAll: () => ({
        PoolDailySnapshot: Array.from({ length: 1000 }, () =>
          makeDaily(now - rowCursor++),
        ),
      }),
    });

    const result = await fetchNetworkData(CELO_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    expect(result.snapshotsAllDailyTruncated).toBe(true);
    expect(result.snapshotsAllDailyError).toBeNull();
    expect(result.snapshotsError).toBeNull();
    expect(result.snapshots7dError).not.toBeNull();
    expect(result.snapshots7dError?.message).toMatch(/truncated/i);
    expect(result.snapshots30dError).toBe(result.snapshots7dError);
  });

  it("errored-tail: mid-loop pagination failure only degrades windows beyond the salvaged rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const pool = makePool("42220-0xmiderr", { id: "pool-window" });
    // Page 1: 1000 rows at 12h spacing (~500 days) — covers all 3 windows.
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      PoolDailySnapshotsAll: (callIndex: number) =>
        callIndex === 0
          ? {
              PoolDailySnapshot: Array.from({ length: 1000 }, (_, i) =>
                makeDaily(now - i * 43200),
              ),
            }
          : reject(new Error("upstream timeout on page 2")),
    });

    const result = await fetchNetworkData(CELO_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    expect(result.snapshotsAllDailyError).not.toBeNull();
    expect(result.snapshotsAllDailyTruncated).toBe(true);
    // All three windows sit inside the ~500d of salvaged rows.
    expect(result.snapshotsError).toBeNull();
    expect(result.snapshots7dError).toBeNull();
    expect(result.snapshots30dError).toBeNull();
  });

  it("errored-tail: incremental mutable-tail refresh failure degrades every current window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const todayMidnight = Math.floor(now / 86400) * 86400;
    const pool = makePool("42220-0xtail", { id: "pool-tail" });
    incrementalRowCache.set("celo-mainnet:PoolDailySnapshot", {
      variablesKey: "pool-tail",
      rows: [
        makeDaily(todayMidnight, "pool-tail"),
        makeDaily(todayMidnight - 60 * 86400, "pool-tail"),
      ],
      refreshAfterTimestamp: todayMidnight - 86400,
    });
    const tailErr = new Error("incremental tail timeout");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      PoolDailySnapshotsAll: reject(tailErr),
    });

    const result = await fetchNetworkData(CELO_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    // Cached history is preserved, but the mutable tail failure degrades
    // every window that reaches into the mutable UTC-day range — all three.
    expect(result.snapshotsAllDailyError).toBe(tailErr);
    expect(result.snapshotsError).toBe(tailErr);
    expect(result.snapshots7dError).toBe(tailErr);
    expect(result.snapshots30dError).toBe(tailErr);
  });
});

describe("fetchNetworkData characterization — empty network", () => {
  it("returns a fully-healthy, all-empty NetworkData when the network has zero pools", async () => {
    installGraphQLMock({ AllPoolsWithHealth: { Pool: [] } });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.pools).toEqual([]);
    expect(result.snapshots).toEqual([]);
    expect(result.snapshots7d).toEqual([]);
    expect(result.snapshots30d).toEqual([]);
    expect(result.snapshotsAllDaily).toEqual([]);
    expect(result.snapshotsAllDailyTruncated).toBe(false);
    expect(result.snapshotsAllDailyError).toBeNull();
    expect(result.brokerSnapshotsAllDaily).toEqual([]);
    expect(result.olsPoolIds).toEqual(new Set());
    expect(result.cdpPoolIds).toEqual(new Set());
    expect(result.reservePoolIds).toEqual(new Set());
    expect(result.strategyError).toBeNull();
    // No pools means the empty-rates guard does not fire (it only applies
    // when pools exist but rate resolution failed).
    expect(result.ratesError).toBeNull();
    expect(result.uniqueLpAddresses).toEqual([]);
    expect(result.uniqueLpAddressesTruncated).toBe(false);
    expect(result.lpError).toBeNull();
  });
});
