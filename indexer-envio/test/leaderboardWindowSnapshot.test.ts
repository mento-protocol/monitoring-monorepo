/// <reference types="mocha" />
import { strict as assert } from "assert";
import type {
  BrokerLeaderboardWindowSnapshot,
  BrokerTraderDailySnapshot,
  LeaderboardChainState,
  LeaderboardWindowSnapshot,
  TraderDailySnapshot,
} from "generated";
import {
  WINDOW_KEYS,
  aggregatePerWindow,
  buildLeaderboardWindowSnapshot,
  windowStartDay,
  type TraderDailyRow,
} from "../src/leaderboardWindowSnapshot";
import {
  flushV2LeaderboardWindowSnapshots,
  flushV3LeaderboardWindowSnapshots,
  maybeHeartbeatFlushV2,
  maybeHeartbeatFlushV3,
  type V2FlushContext,
  type V3FlushContext,
} from "../src/leaderboardWindowFlush";

const CHAIN = 42220;
const TRADER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRADER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRADER_C = "0xcccccccccccccccccccccccccccccccccccccccc";

const SECONDS_PER_DAY = 86400n;
const DAY_2026_05_07 = 1778803200n; // UTC midnight 2026-05-07
const DAY_2026_05_06 = DAY_2026_05_07 - SECONDS_PER_DAY;
const DAY_2026_05_05 = DAY_2026_05_07 - 2n * SECONDS_PER_DAY;
const DAY_2026_04_30 = DAY_2026_05_07 - 7n * SECONDS_PER_DAY;
const DAY_2026_04_29 = DAY_2026_05_07 - 8n * SECONDS_PER_DAY;

const ONE_USD = 10n ** 18n;

function row(
  overrides: Partial<TraderDailyRow> & { trader: string; timestamp: bigint },
): TraderDailyRow {
  return {
    chainId: CHAIN,
    volumeUsdWei: 100n * ONE_USD,
    swapCount: 1,
    isSystemAddress: false,
    ...overrides,
  };
}

describe("windowStartDay", () => {
  it("24h returns snapshotDay+1 (empty range — today provides the only day)", () => {
    assert.equal(
      windowStartDay(DAY_2026_05_07, "24h"),
      DAY_2026_05_07 + SECONDS_PER_DAY,
    );
  });

  it("7d covers snapshotDay - 5 days (6 closed days; today is the 7th)", () => {
    assert.equal(
      windowStartDay(DAY_2026_05_07, "7d"),
      DAY_2026_05_07 - 5n * SECONDS_PER_DAY,
    );
  });

  it("30d covers snapshotDay - 28 days (29 closed days)", () => {
    assert.equal(
      windowStartDay(DAY_2026_05_07, "30d"),
      DAY_2026_05_07 - 28n * SECONDS_PER_DAY,
    );
  });

  it("90d covers snapshotDay - 88 days (89 closed days)", () => {
    assert.equal(
      windowStartDay(DAY_2026_05_07, "90d"),
      DAY_2026_05_07 - 88n * SECONDS_PER_DAY,
    );
  });

  it("all returns 0n (no lower bound)", () => {
    assert.equal(windowStartDay(DAY_2026_05_07, "all"), 0n);
  });
});

describe("buildLeaderboardWindowSnapshot", () => {
  it("empty aggregates -> all zeros, deterministic id", () => {
    const snap = buildLeaderboardWindowSnapshot({
      chainId: CHAIN,
      windowKey: "7d",
      snapshotDay: DAY_2026_05_07,
      windowStartDay: DAY_2026_04_30 + SECONDS_PER_DAY,
      aggregates: [],
      blockNumber: 1n,
      updatedAtTimestamp: 1n,
    });
    assert.equal(snap.id, `${CHAIN}-7d-${DAY_2026_05_07}`);
    assert.equal(snap.totalVolumeUsdWei, 0n);
    assert.equal(snap.totalSwapCount, 0);
    assert.equal(snap.uniqueTraders, 0);
    assert.equal(snap.uniqueTradersIncludingSystem, 0);
  });

  it("primary totals exclude system; *IncludingSystem variants keep all", () => {
    const snap = buildLeaderboardWindowSnapshot({
      chainId: CHAIN,
      windowKey: "24h",
      snapshotDay: DAY_2026_05_07,
      windowStartDay: DAY_2026_05_07,
      aggregates: [
        {
          trader: TRADER_A,
          volumeUsdWei: 100n * ONE_USD,
          swapCount: 2,
          isSystemAddress: false,
        },
        {
          trader: TRADER_B,
          volumeUsdWei: 50n * ONE_USD,
          swapCount: 1,
          isSystemAddress: true,
        },
      ],
      blockNumber: 1n,
      updatedAtTimestamp: 1n,
    });
    assert.equal(snap.totalVolumeUsdWei, 100n * ONE_USD, "system excluded");
    assert.equal(snap.totalVolumeUsdWeiIncludingSystem, 150n * ONE_USD);
    assert.equal(snap.totalSwapCount, 2, "system swaps excluded");
    assert.equal(snap.totalSwapCountIncludingSystem, 3);
    assert.equal(snap.uniqueTraders, 1);
    assert.equal(snap.uniqueTradersIncludingSystem, 2);
  });
});

describe("aggregatePerWindow", () => {
  it("filters out cross-chain rows (defensive against getWhere index quirks)", () => {
    const grouped = aggregatePerWindow(
      [
        row({ trader: TRADER_A, timestamp: DAY_2026_05_07 }),
        row({ trader: TRADER_B, timestamp: DAY_2026_05_07, chainId: 99999 }),
      ],
      CHAIN,
      DAY_2026_05_07,
    );
    // Use 7d (24h window is empty by design — see windowStartDay).
    assert.equal(grouped["7d"].length, 1, "only chainId=42220 row kept");
    assert.equal(grouped["7d"][0].trader, TRADER_A);
  });

  it("inclusive upper bound: timestamp == snapshotDay included in 7d/30d/all; > snapshotDay dropped", () => {
    const grouped = aggregatePerWindow(
      [
        row({ trader: TRADER_A, timestamp: DAY_2026_05_07 }),
        row({
          trader: TRADER_B,
          timestamp: DAY_2026_05_07 + SECONDS_PER_DAY,
        }),
      ],
      CHAIN,
      DAY_2026_05_07,
    );
    assert.equal(grouped["7d"].length, 1);
    assert.equal(grouped["7d"][0].trader, TRADER_A);
    // 24h window is empty (its start = snapshotDay + 1d, so even
    // timestamp == snapshotDay is below it).
    assert.equal(grouped["24h"].length, 0);
  });

  it("7d window covers 6 closed days (snapshotDay-5 .. snapshotDay); today is the 7th", () => {
    const grouped = aggregatePerWindow(
      [
        // day -5 from snapshotDay → in 7d window (start = snapshotDay - 5d)
        row({
          trader: TRADER_A,
          timestamp: DAY_2026_05_07 - 5n * SECONDS_PER_DAY,
        }),
        // day -6 from snapshotDay → out of 7d window (today on the dashboard
        // would have been the 7th day, so this falls off the back)
        row({
          trader: TRADER_B,
          timestamp: DAY_2026_05_07 - 6n * SECONDS_PER_DAY,
        }),
      ],
      CHAIN,
      DAY_2026_05_07,
    );
    assert.equal(grouped["7d"].length, 1);
    assert.equal(grouped["7d"][0].trader, TRADER_A);
    // 30d window catches the day-6 row (covers snapshotDay-28 onwards)
    const trader30d = grouped["30d"].find((a) => a.trader === TRADER_B);
    assert(trader30d, "TRADER_B in 30d window");
  });

  it("24h window is empty; today's partial provides the day on the dashboard", () => {
    const grouped = aggregatePerWindow(
      [row({ trader: TRADER_A, timestamp: DAY_2026_05_07 })],
      CHAIN,
      DAY_2026_05_07,
    );
    assert.equal(
      grouped["24h"].length,
      0,
      "24h snapshot covers nothing; today fills it on the dashboard",
    );
  });

  it("sums volume across multiple days for the same trader", () => {
    const grouped = aggregatePerWindow(
      [
        row({
          trader: TRADER_A,
          timestamp: DAY_2026_05_07,
          volumeUsdWei: 100n * ONE_USD,
          swapCount: 2,
        }),
        row({
          trader: TRADER_A,
          timestamp: DAY_2026_05_06,
          volumeUsdWei: 50n * ONE_USD,
          swapCount: 1,
        }),
      ],
      CHAIN,
      DAY_2026_05_07,
    );
    assert.equal(grouped["7d"].length, 1);
    assert.equal(grouped["7d"][0].volumeUsdWei, 150n * ONE_USD);
    assert.equal(grouped["7d"][0].swapCount, 3);
  });

  it("isSystemAddress is sticky-true across days", () => {
    const grouped = aggregatePerWindow(
      [
        row({
          trader: TRADER_A,
          timestamp: DAY_2026_05_07,
          isSystemAddress: false,
        }),
        row({
          trader: TRADER_A,
          timestamp: DAY_2026_05_06,
          isSystemAddress: true,
        }),
      ],
      CHAIN,
      DAY_2026_05_07,
    );
    assert.equal(grouped["7d"][0].isSystemAddress, true);
  });

  it('"all" window has no lower bound — includes ancient rows', () => {
    const grouped = aggregatePerWindow(
      [row({ trader: TRADER_A, timestamp: 1n })],
      CHAIN,
      DAY_2026_05_07,
    );
    assert.equal(grouped["all"].length, 1);
    assert.equal(grouped["7d"].length, 0);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat smoke tests against a Map-backed mock context.
// ---------------------------------------------------------------------------

function makeV3Context(traderRows: TraderDailySnapshot[] = []): {
  context: V3FlushContext;
  store: {
    LeaderboardWindowSnapshot: Map<string, LeaderboardWindowSnapshot>;
    LeaderboardChainState: Map<string, LeaderboardChainState>;
  };
} {
  const store = {
    LeaderboardWindowSnapshot: new Map<string, LeaderboardWindowSnapshot>(),
    LeaderboardChainState: new Map<string, LeaderboardChainState>(),
  };
  const wrap = <T extends { id: string }>(m: Map<string, T>) => ({
    get: async (id: string) => m.get(id),
    set: (entity: T) => {
      m.set(entity.id, entity);
    },
  });
  return {
    context: {
      TraderDailySnapshot: {
        getWhere: {
          chainId: {
            eq: async (chainId: number) =>
              traderRows.filter((r) => r.chainId === chainId),
          },
        },
      },
      LeaderboardChainState: wrap(store.LeaderboardChainState),
      LeaderboardWindowSnapshot: wrap(store.LeaderboardWindowSnapshot),
    },
    store,
  };
}

function fakeTraderDay(
  trader: string,
  timestamp: bigint,
  volumeUsd: bigint,
  isSystem = false,
): TraderDailySnapshot {
  return {
    id: `${CHAIN}-${trader}-${timestamp}`,
    chainId: CHAIN,
    trader,
    timestamp,
    swapCount: 1,
    uniquePools: 1,
    volumeUsdWei: volumeUsd * ONE_USD,
    feesPaidUsdWei: 0n,
    isSystemAddress: isSystem,
    lastSeenTimestamp: timestamp,
  };
}

describe("flushV3LeaderboardWindowSnapshots", () => {
  it("writes 4 rows (one per windowKey) for the same snapshotDay", async () => {
    const { context, store } = makeV3Context([
      fakeTraderDay(TRADER_A, DAY_2026_05_06, 100n),
      fakeTraderDay(TRADER_B, DAY_2026_05_06, 50n),
    ]);
    await flushV3LeaderboardWindowSnapshots({
      context,
      chainId: CHAIN,
      snapshotDay: DAY_2026_05_06,
      blockNumber: 1n,
      updatedAtTimestamp: 1n,
    });
    assert.equal(store.LeaderboardWindowSnapshot.size, 5);
    // 24h is empty (today's partial fills it on the dashboard); 7d/30d/all
    // see the full yesterday's data.
    const snap24h = store.LeaderboardWindowSnapshot.get(
      `${CHAIN}-24h-${DAY_2026_05_06}`,
    );
    assert.equal(snap24h?.totalVolumeUsdWei, 0n);
    assert.equal(snap24h?.uniqueTraders, 0);
    for (const w of ["7d", "30d", "90d", "all"] as const) {
      const snap = store.LeaderboardWindowSnapshot.get(
        `${CHAIN}-${w}-${DAY_2026_05_06}`,
      );
      assert(snap, `snapshot for windowKey=${w}`);
      assert.equal(snap.totalVolumeUsdWei, 150n * ONE_USD);
      assert.equal(snap.uniqueTraders, 2);
    }
  });

  it("idempotent: re-running with same args overwrites identical row", async () => {
    const { context, store } = makeV3Context([
      fakeTraderDay(TRADER_A, DAY_2026_05_06, 100n),
    ]);
    await flushV3LeaderboardWindowSnapshots({
      context,
      chainId: CHAIN,
      snapshotDay: DAY_2026_05_06,
      blockNumber: 1n,
      updatedAtTimestamp: 1n,
    });
    await flushV3LeaderboardWindowSnapshots({
      context,
      chainId: CHAIN,
      snapshotDay: DAY_2026_05_06,
      blockNumber: 1n,
      updatedAtTimestamp: 1n,
    });
    assert.equal(store.LeaderboardWindowSnapshot.size, 5);
  });
});

describe("maybeHeartbeatFlushV3", () => {
  it("cold-start (lastFlushedDay=0) flushes only the most recent closed day", async () => {
    const { context, store } = makeV3Context([
      fakeTraderDay(TRADER_A, DAY_2026_05_06, 100n),
    ]);
    // current event is mid-day on 2026-05-07
    await maybeHeartbeatFlushV3({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07 + 60n * 60n * 12n,
      blockNumber: 1n,
    });
    assert.equal(store.LeaderboardWindowSnapshot.size, 5);
    for (const w of WINDOW_KEYS) {
      assert(
        store.LeaderboardWindowSnapshot.has(`${CHAIN}-${w}-${DAY_2026_05_06}`),
        `flushed yesterday for windowKey=${w}`,
      );
    }
    const state = store.LeaderboardChainState.get(`${CHAIN}`);
    assert.equal(state?.lastFlushedDay, DAY_2026_05_06);
  });

  it("same-day no-op: lastFlushedDay already at today-1", async () => {
    const { context, store } = makeV3Context();
    store.LeaderboardChainState.set(`${CHAIN}`, {
      id: `${CHAIN}`,
      chainId: CHAIN,
      lastFlushedDay: DAY_2026_05_06,
      lastFlushedDayBroker: 0n,
      updatedAtTimestamp: 0n,
    });
    await maybeHeartbeatFlushV3({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07 + 1n,
      blockNumber: 1n,
    });
    assert.equal(store.LeaderboardWindowSnapshot.size, 0);
  });

  it("multi-day gap: flushes one row per closed day", async () => {
    const { context, store } = makeV3Context([
      fakeTraderDay(TRADER_A, DAY_2026_05_05, 100n),
      fakeTraderDay(TRADER_B, DAY_2026_05_06, 50n),
    ]);
    // Last flush was 2026-05-04 (lastFlushedDay = 2026-05-04 in seconds)
    const DAY_2026_05_04 = DAY_2026_05_07 - 3n * SECONDS_PER_DAY;
    store.LeaderboardChainState.set(`${CHAIN}`, {
      id: `${CHAIN}`,
      chainId: CHAIN,
      lastFlushedDay: DAY_2026_05_04,
      lastFlushedDayBroker: 0n,
      updatedAtTimestamp: 0n,
    });
    // Current event: mid-day 2026-05-07. Should flush 2026-05-05 and 2026-05-06.
    await maybeHeartbeatFlushV3({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07 + 60n * 60n * 12n,
      blockNumber: 100n,
    });
    // 2 days × 4 windowKeys = 8 rows
    assert.equal(store.LeaderboardWindowSnapshot.size, 10);
    assert(
      store.LeaderboardWindowSnapshot.has(`${CHAIN}-7d-${DAY_2026_05_05}`),
    );
    assert(
      store.LeaderboardWindowSnapshot.has(`${CHAIN}-7d-${DAY_2026_05_06}`),
    );
    const state = store.LeaderboardChainState.get(`${CHAIN}`);
    assert.equal(state?.lastFlushedDay, DAY_2026_05_06);
  });

  it("preserves lastFlushedDayBroker when advancing v3 cursor", async () => {
    const { context, store } = makeV3Context();
    store.LeaderboardChainState.set(`${CHAIN}`, {
      id: `${CHAIN}`,
      chainId: CHAIN,
      lastFlushedDay: 0n,
      lastFlushedDayBroker: DAY_2026_04_29,
      updatedAtTimestamp: 0n,
    });
    await maybeHeartbeatFlushV3({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07,
      blockNumber: 1n,
    });
    const state = store.LeaderboardChainState.get(`${CHAIN}`);
    assert.equal(state?.lastFlushedDay, DAY_2026_05_06);
    assert.equal(
      state?.lastFlushedDayBroker,
      DAY_2026_04_29,
      "broker cursor untouched by v3 heartbeat",
    );
  });

  it("excludes today's rows from window aggregates (upper bound = snapshotDay)", async () => {
    const { context, store } = makeV3Context([
      // Yesterday — should appear in 7d/30d/all snapshots
      fakeTraderDay(TRADER_A, DAY_2026_05_06, 100n),
      // Today — should NOT appear (timestamp > snapshotDay = yesterday)
      fakeTraderDay(TRADER_C, DAY_2026_05_07, 999n),
    ]);
    await maybeHeartbeatFlushV3({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07 + 1n,
      blockNumber: 1n,
    });
    const snap7d = store.LeaderboardWindowSnapshot.get(
      `${CHAIN}-7d-${DAY_2026_05_06}`,
    );
    assert.equal(snap7d?.totalVolumeUsdWei, 100n * ONE_USD);
    assert.equal(snap7d?.uniqueTraders, 1);
    // 24h snapshot is empty by design: today's partial covers it on the
    // dashboard.
    const snap24h = store.LeaderboardWindowSnapshot.get(
      `${CHAIN}-24h-${DAY_2026_05_06}`,
    );
    assert.equal(snap24h?.totalVolumeUsdWei, 0n);
    assert.equal(snap24h?.uniqueTraders, 0);
  });
});

// ---------------------------------------------------------------------------
// v2 (Broker) heartbeat tests — symmetric with the v3 suite above. The
// shared LeaderboardChainState row tracks v3 (`lastFlushedDay`) and v2
// (`lastFlushedDayBroker`) cursors independently; these tests cover the
// v2 side end-to-end.
// ---------------------------------------------------------------------------

function makeV2Context(traderRows: BrokerTraderDailySnapshot[] = []): {
  context: V2FlushContext;
  store: {
    BrokerLeaderboardWindowSnapshot: Map<
      string,
      BrokerLeaderboardWindowSnapshot
    >;
    LeaderboardChainState: Map<string, LeaderboardChainState>;
  };
} {
  const store = {
    BrokerLeaderboardWindowSnapshot: new Map<
      string,
      BrokerLeaderboardWindowSnapshot
    >(),
    LeaderboardChainState: new Map<string, LeaderboardChainState>(),
  };
  const wrap = <T extends { id: string }>(m: Map<string, T>) => ({
    get: async (id: string) => m.get(id),
    set: (entity: T) => {
      m.set(entity.id, entity);
    },
  });
  return {
    context: {
      BrokerTraderDailySnapshot: {
        getWhere: {
          chainId: {
            eq: async (chainId: number) =>
              traderRows.filter((r) => r.chainId === chainId),
          },
        },
      },
      LeaderboardChainState: wrap(store.LeaderboardChainState),
      BrokerLeaderboardWindowSnapshot: wrap(
        store.BrokerLeaderboardWindowSnapshot,
      ),
    },
    store,
  };
}

function fakeBrokerTraderDay(
  trader: string,
  timestamp: bigint,
  volumeUsd: bigint,
  isSystem = false,
): BrokerTraderDailySnapshot {
  return {
    id: `${CHAIN}-${trader}-${timestamp}`,
    chainId: CHAIN,
    trader,
    timestamp,
    swapCount: 1,
    volumeUsdWei: volumeUsd * ONE_USD,
    isSystemAddress: isSystem,
    lastSeenTimestamp: timestamp,
  };
}

describe("flushV2LeaderboardWindowSnapshots", () => {
  it("writes 4 rows (one per windowKey) for the same snapshotDay", async () => {
    const { context, store } = makeV2Context([
      fakeBrokerTraderDay(TRADER_A, DAY_2026_05_06, 100n),
      fakeBrokerTraderDay(TRADER_B, DAY_2026_05_06, 50n),
    ]);
    await flushV2LeaderboardWindowSnapshots({
      context,
      chainId: CHAIN,
      snapshotDay: DAY_2026_05_06,
      blockNumber: 1n,
      updatedAtTimestamp: 1n,
    });
    assert.equal(store.BrokerLeaderboardWindowSnapshot.size, 5);
    for (const w of ["7d", "30d", "90d", "all"] as const) {
      const snap = store.BrokerLeaderboardWindowSnapshot.get(
        `${CHAIN}-${w}-${DAY_2026_05_06}`,
      );
      assert(snap, `snapshot for windowKey=${w}`);
      assert.equal(snap.totalVolumeUsdWei, 150n * ONE_USD);
      assert.equal(snap.uniqueTraders, 2);
    }
  });
});

describe("maybeHeartbeatFlushV2", () => {
  it("cold-start (lastFlushedDayBroker=0) flushes only the most recent closed day", async () => {
    const { context, store } = makeV2Context([
      fakeBrokerTraderDay(TRADER_A, DAY_2026_05_06, 100n),
    ]);
    await maybeHeartbeatFlushV2({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07 + 60n * 60n * 12n,
      blockNumber: 1n,
    });
    assert.equal(store.BrokerLeaderboardWindowSnapshot.size, 5);
    for (const w of WINDOW_KEYS) {
      assert(
        store.BrokerLeaderboardWindowSnapshot.has(
          `${CHAIN}-${w}-${DAY_2026_05_06}`,
        ),
        `flushed yesterday for windowKey=${w}`,
      );
    }
    const state = store.LeaderboardChainState.get(`${CHAIN}`);
    assert.equal(state?.lastFlushedDayBroker, DAY_2026_05_06);
    assert.equal(state?.lastFlushedDay, 0n, "v3 cursor untouched");
  });

  it("same-day no-op: lastFlushedDayBroker already at today-1", async () => {
    const { context, store } = makeV2Context();
    store.LeaderboardChainState.set(`${CHAIN}`, {
      id: `${CHAIN}`,
      chainId: CHAIN,
      lastFlushedDay: 0n,
      lastFlushedDayBroker: DAY_2026_05_06,
      updatedAtTimestamp: 0n,
    });
    await maybeHeartbeatFlushV2({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07 + 1n,
      blockNumber: 1n,
    });
    assert.equal(store.BrokerLeaderboardWindowSnapshot.size, 0);
  });

  it("multi-day gap: flushes one row per closed day", async () => {
    const { context, store } = makeV2Context([
      fakeBrokerTraderDay(TRADER_A, DAY_2026_05_05, 100n),
      fakeBrokerTraderDay(TRADER_B, DAY_2026_05_06, 50n),
    ]);
    const DAY_2026_05_04 = DAY_2026_05_07 - 3n * SECONDS_PER_DAY;
    store.LeaderboardChainState.set(`${CHAIN}`, {
      id: `${CHAIN}`,
      chainId: CHAIN,
      lastFlushedDay: 0n,
      lastFlushedDayBroker: DAY_2026_05_04,
      updatedAtTimestamp: 0n,
    });
    await maybeHeartbeatFlushV2({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07 + 60n * 60n * 12n,
      blockNumber: 100n,
    });
    // 2 days × 4 windowKeys = 8 rows
    assert.equal(store.BrokerLeaderboardWindowSnapshot.size, 10);
    assert(
      store.BrokerLeaderboardWindowSnapshot.has(
        `${CHAIN}-7d-${DAY_2026_05_05}`,
      ),
    );
    assert(
      store.BrokerLeaderboardWindowSnapshot.has(
        `${CHAIN}-7d-${DAY_2026_05_06}`,
      ),
    );
    const state = store.LeaderboardChainState.get(`${CHAIN}`);
    assert.equal(state?.lastFlushedDayBroker, DAY_2026_05_06);
  });

  it("preserves lastFlushedDay (v3 cursor) when advancing v2 cursor", async () => {
    const { context, store } = makeV2Context();
    store.LeaderboardChainState.set(`${CHAIN}`, {
      id: `${CHAIN}`,
      chainId: CHAIN,
      lastFlushedDay: DAY_2026_04_29,
      lastFlushedDayBroker: 0n,
      updatedAtTimestamp: 0n,
    });
    await maybeHeartbeatFlushV2({
      context,
      chainId: CHAIN,
      blockTimestamp: DAY_2026_05_07,
      blockNumber: 1n,
    });
    const state = store.LeaderboardChainState.get(`${CHAIN}`);
    assert.equal(state?.lastFlushedDayBroker, DAY_2026_05_06);
    assert.equal(
      state?.lastFlushedDay,
      DAY_2026_04_29,
      "v3 cursor untouched by v2 heartbeat",
    );
  });
});
