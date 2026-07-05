// Characterization tests for `fetchNetworkData`'s current behavior (#1055).
// These pin the orchestrator's output BEFORE its internals are decomposed
// into per-source fetch modules + a pure `assembleNetworkData`. They must
// keep passing UNCHANGED once that refactor lands — only mechanical renames
// are allowed on this file afterward. Shared fixtures live in
// `characterization-fixtures.ts`; the window-precedence and empty-network
// cases live in `fetch.characterization.windows.test.ts`.
//
// Coverage matrix (this file):
//   - all 13 Promise.allSettled sources succeeding together
//   - each of those 13 sources failing alone (the other 12 stay healthy)
//   - the top-level pools query failing

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

vi.mock("graphql-request", () => {
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
  MONAD_NETWORK,
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

describe("fetchNetworkData characterization — all sources succeed", () => {
  it("assembles pools, fees, snapshots, badges, and LP data from every source", async () => {
    const pool = makePool("42220-0xpool");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllPoolsBreachRollup: {
        Pool: [
          {
            id: pool.id,
            breachCount: 2,
            healthBinarySeconds: "100",
            healthTotalSeconds: "200",
          },
        ],
      },
      AllPoolsHealthCursor: {
        Pool: [
          {
            id: pool.id,
            lastOracleSnapshotTimestamp: "1000",
            lastDeviationRatio: "5",
          },
        ],
      },
      AllPoolsRebalanceThresholdsKnown: {
        Pool: [
          {
            id: pool.id,
            rebalanceThresholdAbove: 100,
            rebalanceThresholdBelow: 100,
            rebalanceThresholdsKnown: true,
            tokenDecimalsKnown: true,
            degenerateReserves: false,
            breakerTripped: false,
          },
        ],
      },
      AllPoolsVpOracleFreshness: {
        Pool: [
          {
            id: pool.id,
            lastOracleReportAt: "1000",
            medianLive: true,
            oracleFreshnessWindow: "300",
          },
        ],
      },
      AllOlsPools: { OlsPool: [{ poolId: "42220-0xols" }] },
      AllCdpPools: {
        CdpPool: [{ poolId: pool.id, strategyAddress: "0xabc" }],
      },
      UniqueLpAddresses: { LiquidityPosition: [{ address: "0xa" }] },
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      id: pool.id,
      breachCount: 2,
      lastOracleSnapshotTimestamp: "1000",
      rebalanceThresholdsKnown: true,
      lastOracleReportAt: "1000",
    });
    expect(result.olsPoolIds).toEqual(new Set(["42220-0xols"]));
    expect(result.fees).not.toBeNull();
    expect(result.uniqueLpAddresses).toEqual(["0xa"]);
    expect(result.strategyError).toBeNull();
    expect(result.feeSnapshotsError).toBeNull();
    expect(result.snapshotsAllDailyError).toBeNull();
    expect(result.brokerSnapshotsAllDailyError).toBeNull();
    expect(result.lpError).toBeNull();
  });
});

describe("fetchNetworkData characterization — top-level pools query fails", () => {
  it("returns emptyNetworkData shape with the pools error surfaced", async () => {
    const poolsErr = new Error("pools query failed");
    installGraphQLMock({ AllPoolsWithHealth: reject(poolsErr) });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBe(poolsErr);
    expect(result.pools).toEqual([]);
    expect(result.snapshots).toEqual([]);
    expect(result.fees).toBeNull();
    expect(result.strategyError).toBeNull();
    expect(result.olsPoolIds).toEqual(new Set());
    expect(result.cdpPoolIds).toEqual(new Set());
    expect(result.reservePoolIds).toEqual(new Set());
  });
});

describe("fetchNetworkData characterization — each source failing alone", () => {
  it("fee snapshots: feeSnapshotsError set, fees null, everything else healthy", async () => {
    const pool = makePool("42220-0xfee");
    const err = new Error("fee snapshots down");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      PoolDailyFeeSnapshotsPage: reject(err),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.feeSnapshotsError).toBe(err);
    expect(result.fees).toBeNull();
    expect(result.snapshotsAllDailyError).toBeNull();
  });

  it("daily snapshots: snapshotsAllDailyError set on all three windows (no rows salvaged)", async () => {
    const pool = makePool("42220-0xdaily");
    const err = new Error("daily snapshots down");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      PoolDailySnapshotsAll: reject(err),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.snapshotsAllDailyError).toBe(err);
    expect(result.snapshotsError).toBe(err);
    expect(result.snapshots7dError).toBe(err);
    expect(result.snapshots30dError).toBe(err);
    expect(result.snapshotsAllDaily).toEqual([]);
  });

  it("broker daily snapshots: brokerSnapshotsAllDailyError set, other slices healthy", async () => {
    const pool = makePool("42220-0xbroker");
    const err = new Error("broker snapshots down");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      BrokerDailySnapshotsAll: reject(err),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.brokerSnapshotsAllDailyError).toBe(err);
    expect(result.brokerSnapshotsAllDaily).toEqual([]);
    expect(result.snapshotsAllDailyError).toBeNull();
  });

  it("LP addresses: lpError set, uniqueLpAddresses null, pools/fees unaffected", async () => {
    const pool = makePool("42220-0xlp");
    const err = new Error("LP query down");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      UniqueLpAddresses: reject(err),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.lpError).toBe(err);
    expect(result.uniqueLpAddresses).toBeNull();
    expect(result.fees).not.toBeNull();
  });

  it("OLS pools: strategyError set, olsPoolIds empty", async () => {
    const pool = makePool("42220-0xols-fail");
    const err = new Error("OLS query down");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllOlsPools: reject(err),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.strategyError).toBe(err);
    expect(result.olsPoolIds).toEqual(new Set());
  });

  it("breach rollup: fails open — no error channel, rollup fields stay undefined", async () => {
    const pool = makePool("42220-0xbreach-fail");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllPoolsBreachRollup: reject(new Error("breach rollup down")),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.strategyError).toBeNull();
    expect(result.pools[0]).not.toHaveProperty("breachCount");
  });

  it("health cursor: fails open — no error channel, cursor fields stay undefined", async () => {
    const pool = makePool("42220-0xcursor-fail");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllPoolsHealthCursor: reject(new Error("health cursor down")),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.strategyError).toBeNull();
    expect(result.pools[0]).not.toHaveProperty("lastOracleSnapshotTimestamp");
  });

  it("rebalance-thresholds-known: fails open — flags stay undefined", async () => {
    const pool = makePool("42220-0xthresh-fail");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllPoolsRebalanceThresholdsKnown: reject(
        new Error("thresholds known down"),
      ),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.strategyError).toBeNull();
    expect(result.pools[0]).not.toHaveProperty("rebalanceThresholdsKnown");
  });

  it("VP oracle freshness: fails open — freshness fields stay undefined", async () => {
    const pool = makePool("42220-0xfresh-fail");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllPoolsVpOracleFreshness: reject(new Error("vp freshness down")),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.strategyError).toBeNull();
    expect(result.pools[0]).not.toHaveProperty("lastOracleReportAt");
  });

  it("VP deprecation (exchange rows): fails open — lifecycle deprecation still applies", async () => {
    const pool = makePool("42220-0xvpdep-fail");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllPoolsVpDeprecation: reject(new Error("vp deprecation down")),
      AllPoolsVpLifecycleDeprecation: {
        VirtualPoolLifecycle: [{ poolId: pool.id }],
      },
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.pools[0]).toMatchObject({ wrappedExchangeDeprecated: true });
    expect(result.pools[0]).not.toHaveProperty("wrappedExchangeMinimumReports");
  });

  it("VP lifecycle deprecation: fails open — exchange-row deprecation still applies", async () => {
    const pool = makePool("42220-0xvplife-fail");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllPoolsVpLifecycleDeprecation: reject(
        new Error("vp lifecycle deprecation down"),
      ),
      AllPoolsVpDeprecation: {
        BiPoolExchange: [{ wrappedByPoolId: pool.id, isDeprecated: true }],
      },
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.pools[0]).toMatchObject({ wrappedExchangeDeprecated: true });
  });

  it("indexed CDP pools (Celo): strategyError set, cdpPoolIds empty", async () => {
    const pool = makePool("42220-0xcdp-fail", {
      rebalancerAddress: "0x000000000000000000000000000000000000d0d0",
    });
    const err = new Error("CdpPool query down");
    installGraphQLMock({
      AllPoolsWithHealth: { Pool: [pool] },
      AllCdpPools: reject(err),
    });

    const result = await fetchNetworkData(CELO_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.strategyError).toBe(err);
    expect(result.cdpPoolIds).toEqual(new Set());
  });

  it("fallback strategy probe (non-Celo): strategyError set, reservePoolIds empty", async () => {
    const pool = makePool("143-0xprobe-fail", {
      chainId: 143,
      rebalancerAddress: "0x000000000000000000000000000000000000d0d0",
    });
    const err = new Error("strategy probe down");
    mockDetectProbedStrategies.mockRejectedValueOnce(err);
    installGraphQLMock({ AllPoolsWithHealth: { Pool: [pool] } });

    const result = await fetchNetworkData(MONAD_NETWORK, WINDOWS);

    expect(result.error).toBeNull();
    expect(result.strategyError).toBe(err);
    expect(result.reservePoolIds).toEqual(new Set());
    expect(result.cdpPoolIds).toEqual(new Set());
  });
});
