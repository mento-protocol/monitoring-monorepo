// Characterization tests for `fetchNetworkData`'s current behavior (#1055).
// These pin the orchestrator's output BEFORE its internals are decomposed
// into per-source fetch modules + a pure `assembleNetworkData`. They must
// keep passing UNCHANGED once that refactor lands — only mechanical renames
// are allowed on this file afterward.
//
// Coverage matrix:
//   - all 13 Promise.allSettled sources succeeding together
//   - each of those 13 sources failing alone (the other 12 stay healthy)
//   - the top-level pools query failing
//   - the per-window pagination-truncation vs mutable-tail-error precedence,
//     both the truncated-but-not-errored case and the errored-tail case
//   - an empty network (zero pools)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

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

import { GraphQLClient } from "graphql-request";
import {
  fetchNetworkData,
  incrementalRowCache,
  partialPageLastCapturedAt,
  warnedCapKeys,
} from "../fetch";

const CELO_NETWORK: Network = {
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

// Chain 143 — the only chain `usesRuntimeStrategyProbe` treats as a fallback
// strategy candidate (`strategy-probe-scope.ts`).
const MONAD_NETWORK: Network = {
  ...CELO_NETWORK,
  id: "monad-mainnet",
  label: "Monad",
  chainId: 143,
  hasuraUrl: "https://hasura-monad.example.com/v1/graphql",
  explorerBaseUrl: "https://monadscan.com",
};

const WINDOWS = {
  w24h: { from: 0, to: 1000 },
  w7d: { from: 0, to: 7000 },
  w30d: { from: 0, to: 30000 },
};

/** Oracle-eligible FPMM pool — enough for `buildOracleRateMap` to price the
 * FX leg so the happy-path fee aggregation doesn't trip the empty-rates
 * guard (mirrors the fixture in `use-protocol-fees.test.ts`). */
function makePool(id: string, overrides: Partial<Pool> = {}): Pool {
  return {
    id,
    chainId: 42220,
    token0: "USDm",
    token1: "EURm",
    source: "FPMM",
    oraclePrice: "1140000000000000000000000",
    oracleOk: true,
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
    ...overrides,
  } as Pool;
}

// Maps each query's operation name to its GraphQL response key and a
// default (empty, successful) response — so a test only needs to override
// the one source it cares about and every other source resolves cleanly.
const DEFAULT_RESPONSES: Record<string, Record<string, unknown>> = {
  AllPoolsWithHealth: { Pool: [] },
  AllPoolsBreachRollup: { Pool: [] },
  AllPoolsHealthCursor: { Pool: [] },
  AllPoolsRebalanceThresholdsKnown: { Pool: [] },
  AllPoolsVpOracleFreshness: { Pool: [] },
  AllPoolsVpDeprecation: { BiPoolExchange: [] },
  AllPoolsVpLifecycleDeprecation: { VirtualPoolLifecycle: [] },
  AllOlsPools: { OlsPool: [] },
  AllCdpPools: { CdpPool: [] },
  PoolDailyFeeSnapshotsPage: { PoolDailyFeeSnapshot: [] },
  PoolDailySnapshotsAll: { PoolDailySnapshot: [] },
  BrokerDailySnapshotsAll: { BrokerDailySnapshot: [] },
  UniqueLpAddresses: { LiquidityPosition: [] },
};

function extractQuery(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "document" in arg) {
    const doc = (arg as { document: unknown }).document;
    if (typeof doc === "string") return doc;
  }
  return "";
}

function queryNameOf(document: string): string {
  return /query\s+(\w+)/.exec(document)?.[1] ?? "";
}

type Reply = Record<string, unknown> | { reject: unknown };

function reject(reason: unknown): Reply {
  return { reject: reason };
}

function isRejectReply(reply: Reply): reply is { reject: unknown } {
  return "reject" in reply;
}

/**
 * Installs a per-operation-name request mock. `overrides[name]` may be a
 * fixed reply, or a function of the call index (0-based, per operation name)
 * for pagination sequences. Any operation not overridden gets its default
 * empty/successful response from `DEFAULT_RESPONSES`.
 */
function installGraphQLMock(
  overrides: Partial<Record<string, Reply | ((callIndex: number) => Reply)>>,
): void {
  const callCounts = new Map<string, number>();
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((arg: unknown) => {
    const name = queryNameOf(extractQuery(arg));
    const index = callCounts.get(name) ?? 0;
    callCounts.set(name, index + 1);
    const override = overrides[name];
    const reply: Reply =
      override === undefined
        ? (DEFAULT_RESPONSES[name] ?? {})
        : typeof override === "function"
          ? override(index)
          : override;
    return isRejectReply(reply)
      ? Promise.reject(reply.reject)
      : Promise.resolve(reply);
  });
}

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
