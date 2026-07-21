import { describe, expect, it } from "vitest";
import type { NetworkData } from "@/lib/fetch-all-networks";
import { computeHealthStatus } from "@/lib/health";
import type { IndexerNetworkId, Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import {
  mergeLivePoolHealth,
  retainLastSuccessfulLivePoolHealth,
  type LivePoolHealthRow,
  type LivePoolHealthSlice,
} from "../use-live-pool-health";

function makePool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "shared-pool-id",
    chainId: 42220,
    token0: "0xtoken0",
    token1: "0xtoken1",
    source: "fpmm_factory",
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
    oracleOk: true,
    oracleTimestamp: "1800",
    lastOracleReportAt: "1800",
    priceDifference: "10",
    ...overrides,
  };
}

function makeNetworkData(
  networkId: IndexerNetworkId,
  pools: Pool[],
): NetworkData {
  return {
    network: { id: networkId } as Network,
    pools,
  } as NetworkData;
}

function makeLiveRow(
  overrides: Partial<LivePoolHealthRow> = {},
): LivePoolHealthRow {
  return {
    id: "shared-pool-id",
    updatedAtBlock: "3",
    updatedAtTimestamp: "2100",
    oracleOk: true,
    oracleTimestamp: "2050",
    lastOracleReportAt: "2050",
    oracleExpiry: "300",
    oracleNumReporters: 3,
    priceDifference: "20",
    rebalanceThreshold: 5000,
    rebalanceThresholdAbove: 5000,
    rebalanceThresholdBelow: 5000,
    rebalanceThresholdsKnown: true,
    tokenDecimalsKnown: true,
    degenerateReserves: false,
    breakerTripped: false,
    deviationBreachStartedAt: "0",
    lastRebalancedAt: "1900",
    hasHealthData: true,
    limitStatus: "OK",
    limitPressure0: "0.1",
    limitPressure1: "0.2",
    medianLive: true,
    oracleFreshnessWindow: "0",
    oracleFreshnessCheckedAt: 2_120,
    ...overrides,
  };
}

function successfulSlice(
  networkId: IndexerNetworkId,
  pools: LivePoolHealthRow[],
): LivePoolHealthSlice {
  return { networkId, pools, error: null };
}

describe("mergeLivePoolHealth", () => {
  it("marks cached pools pending until the first live-health response arrives", () => {
    const basePool = makePool();
    const networkData = [makeNetworkData("celo-mainnet", [basePool])];

    const merged = mergeLivePoolHealth(networkData, undefined, true);

    expect(merged[0]!.pools[0]).toMatchObject({
      id: basePool.id,
      oracleFreshnessCheckPending: true,
    });
    expect(basePool.oracleFreshnessCheckPending).toBeUndefined();
  });

  it("does not hide staleness already confirmed by the full-payload fetch", () => {
    const confirmedPool = makePool({ oracleFreshnessCheckedAt: 2_400 });
    const networkData = [makeNetworkData("celo-mainnet", [confirmedPool])];

    const merged = mergeLivePoolHealth(networkData, undefined, true);

    expect(merged[0]!.pools[0]).toBe(confirmedPool);
    expect(merged[0]!.pools[0]!.oracleFreshnessCheckPending).toBeUndefined();
  });

  it.each([
    ["same-timestamp", "2000"],
    ["newer", "2100"],
  ])(
    "overlays a %s matching row only within its network and records the check time",
    (_caseName, liveUpdatedAt) => {
      const celoPool = makePool();
      const monadPool = makePool({ chainId: 143 });
      const networkData = [
        makeNetworkData("celo-mainnet", [celoPool]),
        makeNetworkData("monad-mainnet", [monadPool]),
      ];
      const liveRow = makeLiveRow({
        updatedAtTimestamp: liveUpdatedAt,
        oracleOk: false,
        oracleTimestamp: "1990",
        oracleFreshnessCheckedAt: 2_120,
      });

      const merged = mergeLivePoolHealth(
        networkData,
        [successfulSlice("celo-mainnet", [liveRow])],
        false,
      );

      expect(merged[0]!.pools[0]).toMatchObject({
        oracleOk: false,
        oracleTimestamp: "1990",
        updatedAtTimestamp: liveUpdatedAt,
        oracleFreshnessCheckedAt: 2_120,
        oracleFreshnessCheckPending: false,
      });
      expect(merged[1]!.pools[0]).toBe(monadPool);
      expect(celoPool.oracleFreshnessCheckedAt).toBeUndefined();
    },
  );

  it("ignores a live row older than the full-payload pool", () => {
    const basePool = makePool({
      updatedAtTimestamp: "2200",
      oracleTimestamp: "2190",
    });
    const networkData = [makeNetworkData("celo-mainnet", [basePool])];
    const olderRow = makeLiveRow({
      updatedAtBlock: "1",
      updatedAtTimestamp: "2100",
      oracleTimestamp: "2050",
      oracleFreshnessCheckedAt: 2_300,
    });

    const merged = mergeLivePoolHealth(
      networkData,
      [successfulSlice("celo-mainnet", [olderRow])],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      updatedAtTimestamp: "2200",
      oracleTimestamp: "2190",
    });
    expect(merged[0]!.pools[0]!.oracleFreshnessCheckedAt).toBeUndefined();
    expect(merged[0]!.liveHealthError?.message).toContain(
      "did not confirm 1 displayed pool",
    );
  });

  it("preserves a pending primary check when only older live data arrives", () => {
    const basePool = makePool({
      updatedAtBlock: "4",
      oracleOk: true,
      oracleFreshnessCheckPending: true,
    });
    const olderRow = makeLiveRow({
      updatedAtBlock: "3",
      oracleOk: false,
    });

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [successfulSlice("celo-mainnet", [olderRow])],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      oracleOk: true,
      oracleFreshnessCheckPending: true,
    });
    expect(merged[0]!.pools[0]!.oracleFreshnessCheckedAt).toBeUndefined();
    expect(merged[0]!.liveHealthError?.message).toContain(
      "did not confirm 1 displayed pool",
    );
  });

  it("accepts an equal-block client observation without comparing server and browser clocks", () => {
    const basePool = makePool({
      updatedAtBlock: "3",
      oracleOk: true,
      oracleFreshnessCheckedAt: 3_000,
    });
    const equalBlockRow = makeLiveRow({
      updatedAtBlock: "3",
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_000,
    });

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [successfulSlice("celo-mainnet", [equalBlockRow])],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_000,
      oracleFreshnessCheckPending: false,
    });
  });

  it("does not let an equal-block retained row replace a newer fleet observation", () => {
    const basePool = makePool({
      updatedAtBlock: "3",
      oracleOk: false,
      oracleTimestamp: "1900",
      oracleFreshnessCheckedAt: 2_300,
    });
    const retainedRow = makeLiveRow({
      updatedAtBlock: "3",
      oracleOk: true,
      oracleTimestamp: "2050",
      oracleFreshnessCheckedAt: 2_200,
    });
    const retainedSlice: LivePoolHealthSlice = {
      ...successfulSlice("celo-mainnet", [retainedRow]),
      error: new Error("live health unavailable"),
      retainedPoolIds: [retainedRow.id],
    };

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [retainedSlice],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      oracleOk: false,
      oracleTimestamp: "1900",
      oracleFreshnessCheckedAt: 2_300,
    });
  });

  it("does not let an older warm-cache row replace a newer equal-block fleet observation", () => {
    const basePool = makePool({
      updatedAtBlock: "3",
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_300,
    });
    const cachedRow = makeLiveRow({
      updatedAtBlock: "3",
      oracleOk: true,
      oracleFreshnessCheckedAt: 2_200,
    });
    const cachedSlice = {
      ...successfulSlice("celo-mainnet", [cachedRow]),
      receiptSequence: 1,
    };

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [cachedSlice],
      false,
      2,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_300,
    });
  });

  it("silently merges a higher-block live row whose request overlapped a slower fleet fetch", () => {
    const basePool = makePool({
      updatedAtBlock: "3",
      thresholdHealthUpdatedAtBlock: "3",
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_300,
    });
    const overlappingLiveRow = makeLiveRow({
      updatedAtBlock: "4",
      oracleOk: true,
      oracleFreshnessCheckedAt: 2_200,
    });
    const overlappingSlice = {
      ...successfulSlice("celo-mainnet", [overlappingLiveRow]),
      // The live request started first, but observed a later block while the
      // full fleet request was still completing its fan-out.
      receiptSequence: 1,
    };

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [overlappingSlice],
      false,
      2,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      updatedAtBlock: "4",
      oracleOk: true,
      oracleFreshnessCheckedAt: 2_200,
    });
    expect(merged[0]!.liveHealthError).toBeNull();
  });

  it("does not flag pools missing only from an intentionally older cache slice", () => {
    const firstPool = makePool({
      id: "first-pool",
      oracleFreshnessCheckedAt: 2_300,
      thresholdHealthUpdatedAtBlock: "2",
      vpHealthUpdatedAtBlock: "2",
    });
    const secondPool = makePool({
      id: "second-pool",
      oracleFreshnessCheckedAt: 2_300,
    });
    const cachedSlice = {
      ...successfulSlice("celo-mainnet", [
        makeLiveRow({ id: firstPool.id, updatedAtBlock: "2" }),
      ]),
      receiptSequence: 1,
    };

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [firstPool, secondPool])],
      [cachedSlice],
      false,
      2,
    );

    expect(merged[0]!.liveHealthError).toBeNull();
    expect(merged[0]!.pools[1]).toBe(secondPool);
  });

  it("discloses an older retained slice that repairs a regressed fleet row", () => {
    const basePool = makePool({
      updatedAtBlock: "4",
      oracleOk: true,
      oracleFreshnessCheckedAt: 2_300,
    });
    const retainedRow = makeLiveRow({
      updatedAtBlock: "5",
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_200,
    });
    const cachedSlice = {
      ...successfulSlice("celo-mainnet", [retainedRow]),
      receiptSequence: 1,
      retainedPoolIds: [retainedRow.id],
    };

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [cachedSlice],
      false,
      2,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      updatedAtBlock: "5",
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_200,
    });
    expect(merged[0]!.liveHealthError?.message).toContain(
      "did not confirm 1 displayed pool",
    );
  });

  it("does not treat the VP cursor as a missing FPMM health group", () => {
    const basePool = makePool({
      updatedAtBlock: "4",
      thresholdHealthUpdatedAtBlock: "4",
      oracleFreshnessCheckedAt: 2_300,
    });
    const cachedSlice = {
      ...successfulSlice("celo-mainnet", [
        makeLiveRow({ updatedAtBlock: "3" }),
      ]),
      receiptSequence: 1,
    };

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [cachedSlice],
      false,
      2,
    );

    expect(merged[0]!.liveHealthError).toBeNull();
    expect(merged[0]!.pools[0]).toBe(basePool);
  });

  it("rejects malformed or precision-losing live block cursors", () => {
    const basePool = makePool({
      updatedAtBlock: "9007199254740993",
      oracleOk: true,
    });
    const malformed = makeLiveRow({
      updatedAtBlock: "invalid",
      oracleOk: false,
    });
    const olderBeyondNumberPrecision = makeLiveRow({
      updatedAtBlock: "9007199254740992",
      oracleOk: false,
    });
    const data = [makeNetworkData("celo-mainnet", [basePool])];

    for (const row of [malformed, olderBeyondNumberPrecision]) {
      const merged = mergeLivePoolHealth(
        data,
        [successfulSlice("celo-mainnet", [row])],
        false,
      );
      expect(merged[0]!.pools[0]!.oracleOk).toBe(true);
    }
  });

  it("merges primary fields without rolling newer extension fields backward", () => {
    const basePool = makePool({
      source: "virtual_pool_factory",
      wrappedExchangeId: "0xexchange",
      oracleFreshnessCheckedAt: 2_300,
      updatedAtBlock: "2",
      updatedAtTimestamp: "2000",
      breakerTripped: false,
      thresholdHealthUpdatedAtBlock: "4",
      medianLive: true,
      vpHealthUpdatedAtBlock: "4",
    });
    const networkData = [makeNetworkData("celo-mainnet", [basePool])];
    const earlierLiveRow = makeLiveRow({
      oracleFreshnessCheckedAt: 2_200,
      updatedAtBlock: "3",
      updatedAtTimestamp: "2100",
      oracleOk: false,
      breakerTripped: true,
      medianLive: false,
    });

    const merged = mergeLivePoolHealth(
      networkData,
      [successfulSlice("celo-mainnet", [earlierLiveRow])],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      oracleOk: false,
      oracleFreshnessCheckedAt: 2_200,
      breakerTripped: false,
      thresholdHealthUpdatedAtBlock: "4",
      medianLive: true,
      vpHealthUpdatedAtBlock: "4",
    });
    expect(merged[0]!.liveHealthError?.message).toContain(
      "did not confirm 1 displayed pool",
    );
  });

  it("orders the two extension field groups independently", () => {
    const basePool = makePool({
      source: "virtual_pool_factory",
      wrappedExchangeId: "0xexchange",
      thresholdHealthUpdatedAtBlock: "4",
      breakerTripped: false,
      vpHealthUpdatedAtBlock: "2",
      medianLive: true,
    });
    const liveRow = makeLiveRow({
      updatedAtBlock: "3",
      breakerTripped: true,
      medianLive: false,
    });

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [successfulSlice("celo-mainnet", [liveRow])],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      breakerTripped: false,
      thresholdHealthUpdatedAtBlock: "4",
      medianLive: false,
      vpHealthUpdatedAtBlock: "3",
    });
  });

  it("can advance threshold health while retaining newer VP health", () => {
    const basePool = makePool({
      source: "virtual_pool_factory",
      wrappedExchangeId: "0xexchange",
      thresholdHealthUpdatedAtBlock: "2",
      breakerTripped: false,
      vpHealthUpdatedAtBlock: "4",
      medianLive: true,
    });
    const liveRow = makeLiveRow({
      updatedAtBlock: "3",
      breakerTripped: true,
      medianLive: false,
    });

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [successfulSlice("celo-mainnet", [liveRow])],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      breakerTripped: true,
      thresholdHealthUpdatedAtBlock: "3",
      medianLive: true,
      vpHealthUpdatedAtBlock: "4",
    });
  });

  it("retains the newer atomic VP health group while primary fields advance", () => {
    const basePool = makePool({
      source: "virtual_pool_factory",
      wrappedExchangeId: "0xexchange",
      vpHealthUpdatedAtBlock: "4",
      vpOracleTimestamp: "2050",
      vpOracleNumReporters: 3,
      vpTokenDecimalsKnown: true,
      vpOracleFreshnessCheckedAt: 2_120,
      medianLive: true,
      oracleFreshnessWindow: "300",
      wrappedExchangeMinimumReports: "1",
    });
    const liveRow = makeLiveRow({
      updatedAtBlock: "3",
      oracleTimestamp: "1200",
      oracleNumReporters: 0,
      tokenDecimalsKnown: false,
      medianLive: false,
      oracleFreshnessWindow: "300",
    });

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [successfulSlice("celo-mainnet", [liveRow])],
      false,
    );
    const pool = merged[0]!.pools[0]!;

    expect(pool).toMatchObject({
      oracleTimestamp: "1200",
      oracleNumReporters: 0,
      tokenDecimalsKnown: false,
      vpOracleTimestamp: "2050",
      vpOracleNumReporters: 3,
      vpTokenDecimalsKnown: true,
      vpOracleFreshnessCheckedAt: 2_120,
      medianLive: true,
      vpHealthUpdatedAtBlock: "4",
    });
    expect(computeHealthStatus(pool, 42220, 9_999)).toBe("N/A");
  });

  it("keeps retained live rows and exposes degradation when a network slice fails", () => {
    const basePool = makePool();
    const networkData = [makeNetworkData("celo-mainnet", [basePool])];
    const retainedRow = makeLiveRow({ oracleOk: false });
    const failedSlice: LivePoolHealthSlice = {
      networkId: "celo-mainnet",
      pools: [retainedRow],
      error: new Error("live health unavailable"),
    };

    const merged = mergeLivePoolHealth(networkData, [failedSlice], false);

    expect(merged[0]!.pools[0]).toMatchObject({
      oracleOk: false,
      oracleTimestamp: retainedRow.oracleTimestamp,
      oracleFreshnessCheckedAt: retainedRow.oracleFreshnessCheckedAt,
    });
    expect(merged[0]!.liveHealthError).toEqual({
      message: "live health unavailable",
    });
  });

  it.each([
    ["clears", true, null],
    ["preserves", false, "fleet extension unavailable"],
  ] as const)(
    "%s an inherited fleet error according to its live-poll recovery scope",
    (_caseName, clearsOnLivePoll, expectedMessage) => {
      const basePool = makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId: "0xexchange",
        updatedAtBlock: "3",
        thresholdHealthUpdatedAtBlock: "3",
        vpHealthUpdatedAtBlock: "3",
        oracleFreshnessCheckedAt: 2_100,
      });
      const data = makeNetworkData("celo-mainnet", [basePool]);
      data.liveHealthError = { message: "fleet extension unavailable" };
      data.liveHealthErrorClearsOnLivePoll = clearsOnLivePoll;

      const merged = mergeLivePoolHealth(
        [data],
        [
          successfulSlice("celo-mainnet", [
            makeLiveRow({ updatedAtBlock: "4" }),
          ]),
        ],
        false,
      );

      expect(merged[0]?.liveHealthError?.message ?? null).toBe(expectedMessage);
    },
  );

  it("does not clear a fleet error from an older equal-block warm-cache slice", () => {
    const basePool = makePool({
      updatedAtBlock: "4",
      thresholdHealthUpdatedAtBlock: "4",
      oracleFreshnessCheckedAt: 2_300,
    });
    const data = makeNetworkData("celo-mainnet", [basePool]);
    data.liveHealthError = { message: "fleet freshness unavailable" };
    data.liveHealthErrorClearsOnLivePoll = true;
    const cachedSlice = {
      ...successfulSlice("celo-mainnet", [
        makeLiveRow({ updatedAtBlock: "4" }),
      ]),
      receiptSequence: 1,
    };

    const merged = mergeLivePoolHealth([data], [cachedSlice], false, 2);

    expect(merged[0]?.liveHealthError?.message).toBe(
      "fleet freshness unavailable",
    );
  });

  it("lets an overlapping lower-sequence live request clear an error when every group advances", () => {
    const basePool = makePool({
      updatedAtBlock: "3",
      thresholdHealthUpdatedAtBlock: "3",
      oracleFreshnessCheckedAt: 2_100,
    });
    const data = makeNetworkData("celo-mainnet", [basePool]);
    data.liveHealthError = { message: "fleet freshness unavailable" };
    data.liveHealthErrorClearsOnLivePoll = true;
    const overlappingSlice = {
      ...successfulSlice("celo-mainnet", [
        makeLiveRow({ updatedAtBlock: "4" }),
      ]),
      receiptSequence: 1,
    };

    const merged = mergeLivePoolHealth([data], [overlappingSlice], false, 2);

    expect(merged[0]?.liveHealthError).toBeNull();
  });

  it("ignores retained IDs for pools no longer displayed when clearing a fleet error", () => {
    const basePool = makePool({
      updatedAtBlock: "3",
      thresholdHealthUpdatedAtBlock: "3",
      oracleFreshnessCheckedAt: 2_100,
    });
    const data = makeNetworkData("celo-mainnet", [basePool]);
    data.liveHealthError = { message: "fleet freshness unavailable" };
    data.liveHealthErrorClearsOnLivePoll = true;
    const slice = {
      ...successfulSlice("celo-mainnet", [
        makeLiveRow({ updatedAtBlock: "4" }),
      ]),
      retainedPoolIds: ["removed-pool"],
    };

    const merged = mergeLivePoolHealth([data], [slice], false);

    expect(merged[0]?.liveHealthError).toBeNull();
  });

  it("keeps the full-payload pools when the first live request fails", () => {
    const basePool = makePool();
    const networkData = [makeNetworkData("celo-mainnet", [basePool])];
    const failedSlice: LivePoolHealthSlice = {
      networkId: "celo-mainnet",
      pools: [],
      error: new Error("live health unavailable"),
    };

    const merged = mergeLivePoolHealth(networkData, [failedSlice], false);

    expect(merged[0]!.pools[0]).toMatchObject({
      id: basePool.id,
      oracleFreshnessCheckPending: true,
    });
    expect(merged[0]!.liveHealthError).toEqual({
      message: "live health unavailable",
    });
  });

  it("keeps a fleet-confirmed observation when the first live request fails", () => {
    const basePool = makePool({ oracleFreshnessCheckedAt: 2_000 });
    const failedSlice: LivePoolHealthSlice = {
      networkId: "celo-mainnet",
      pools: [],
      error: new Error("live health unavailable"),
    };

    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [basePool])],
      [failedSlice],
      false,
    );

    expect(merged[0]!.pools[0]).toMatchObject({
      id: basePool.id,
      oracleFreshnessCheckedAt: 2_000,
    });
    expect(merged[0]!.pools[0]!.oracleFreshnessCheckPending).toBeUndefined();
    expect(merged[0]!.liveHealthError).toEqual({
      message: "live health unavailable",
    });
  });
});

describe("retainLastSuccessfulLivePoolHealth", () => {
  it("attaches a refresh error without discarding the last confirmed rows", () => {
    const confirmedRow = makeLiveRow({ oracleOk: false });
    const previous = [successfulSlice("celo-mainnet", [confirmedRow])];
    const refreshError = new Error("timeout");

    const retained = retainLastSuccessfulLivePoolHealth(
      [
        {
          networkId: "celo-mainnet",
          pools: [],
          error: refreshError,
        },
      ],
      previous,
    );

    expect(retained[0]?.pools).toEqual([confirmedRow]);
    expect(retained[0]?.error).toBe(refreshError);
  });

  it("updates successful networks while retaining only the failed network", () => {
    const previous = [
      successfulSlice("celo-mainnet", [makeLiveRow({ oracleOk: false })]),
      successfulSlice("monad-mainnet", [
        makeLiveRow({ oracleTimestamp: "2000" }),
      ]),
    ];
    const newMonadRow = makeLiveRow({ oracleTimestamp: "2200" });

    const retained = retainLastSuccessfulLivePoolHealth(
      [
        {
          networkId: "celo-mainnet",
          pools: [],
          error: new Error("celo timeout"),
        },
        successfulSlice("monad-mainnet", [newMonadRow]),
      ],
      previous,
    );

    expect(retained[0]?.pools).toEqual(previous[0]?.pools);
    expect(retained[1]).toEqual(
      successfulSlice("monad-mainnet", [newMonadRow]),
    );
  });

  it("retains rows omitted by a partial 200 response and marks them degraded", () => {
    const confirmedRow = makeLiveRow();
    const previous = [successfulSlice("celo-mainnet", [confirmedRow])];

    const retained = retainLastSuccessfulLivePoolHealth(
      [successfulSlice("celo-mainnet", [])],
      previous,
    );
    const merged = mergeLivePoolHealth(
      [makeNetworkData("celo-mainnet", [makePool()])],
      retained,
      false,
    );

    expect(retained[0]?.pools).toEqual([confirmedRow]);
    expect(retained[0]?.retainedPoolIds).toEqual([confirmedRow.id]);
    expect(merged[0]?.pools[0]).toMatchObject({
      oracleTimestamp: confirmedRow.oracleTimestamp,
      oracleFreshnessCheckedAt: confirmedRow.oracleFreshnessCheckedAt,
    });
    expect(merged[0]?.liveHealthError?.message).toContain(
      "did not confirm 1 displayed pool",
    );
  });

  it("retains a newer confirmed row when a successful response regresses", () => {
    const confirmedRow = makeLiveRow({
      updatedAtBlock: "5",
      oracleOk: false,
    });
    const regressedRow = makeLiveRow({
      updatedAtBlock: "4",
      oracleOk: true,
    });
    const retained = retainLastSuccessfulLivePoolHealth(
      [successfulSlice("celo-mainnet", [regressedRow])],
      [successfulSlice("celo-mainnet", [confirmedRow])],
    );
    const merged = mergeLivePoolHealth(
      [
        makeNetworkData("celo-mainnet", [
          makePool({ updatedAtBlock: "2", oracleOk: true }),
        ]),
      ],
      retained,
      false,
    );

    expect(retained[0]?.pools).toEqual([confirmedRow]);
    expect(retained[0]?.retainedPoolIds).toEqual([confirmedRow.id]);
    expect(merged[0]?.pools[0]).toMatchObject({
      updatedAtBlock: "5",
      oracleOk: false,
    });
    expect(merged[0]?.liveHealthError?.message).toContain(
      "did not confirm 1 displayed pool",
    );
  });
});
