import { strict as assert } from "assert";
import type {
  AggregatorDailySnapshot,
  AggregatorTraderDayMarker,
  LeaderboardChainState,
  LeaderboardWindowSnapshot,
  Pool,
  TraderDailySnapshot,
  TraderPoolDailySnapshot,
  TraderPoolDayMarker,
} from "envio";
import {
  applyLeaderboardSnapshots,
  type LeaderboardContext,
} from "../src/leaderboardSnapshots.js";

// Real addresses on Celo (chain 42220).
const CHAIN = 42220;
const TRADER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRADER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SQUID = "0xce16f69375520ab01377ce7b88f5ba8c48f8d666";
const LIFI = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const CELO_BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const POOL_ADDR_1 = "0x1111111111111111111111111111111111111111";
const POOL_ADDR_2 = "0x2222222222222222222222222222222222222222";
const POOL_ID_1 = `${CHAIN}-${POOL_ADDR_1}`;
const POOL_ID_2 = `${CHAIN}-${POOL_ADDR_2}`;

const ONE_USD = 10n ** 18n;
const DAY_2026_05_04 = 1778457600n; // UTC midnight 2026-05-04

// Build a minimal Map-backed mock context. The leaderboard helper only
// touches the 5 entity types declared in `LeaderboardContext`; everything
// else can be left undefined.
function makeContext(): {
  context: LeaderboardContext;
  store: {
    TraderDailySnapshot: Map<string, TraderDailySnapshot>;
    TraderPoolDailySnapshot: Map<string, TraderPoolDailySnapshot>;
    AggregatorDailySnapshot: Map<string, AggregatorDailySnapshot>;
    TraderPoolDayMarker: Map<string, TraderPoolDayMarker>;
    AggregatorTraderDayMarker: Map<string, AggregatorTraderDayMarker>;
    LeaderboardChainState: Map<string, LeaderboardChainState>;
    LeaderboardWindowSnapshot: Map<string, LeaderboardWindowSnapshot>;
  };
} {
  const store = {
    TraderDailySnapshot: new Map<string, TraderDailySnapshot>(),
    TraderPoolDailySnapshot: new Map<string, TraderPoolDailySnapshot>(),
    AggregatorDailySnapshot: new Map<string, AggregatorDailySnapshot>(),
    TraderPoolDayMarker: new Map<string, TraderPoolDayMarker>(),
    AggregatorTraderDayMarker: new Map<string, AggregatorTraderDayMarker>(),
    LeaderboardChainState: new Map<string, LeaderboardChainState>(),
    LeaderboardWindowSnapshot: new Map<string, LeaderboardWindowSnapshot>(),
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
        ...wrap(store.TraderDailySnapshot),
        getWhere: {
          chainId: {
            eq: async (chainId: number) =>
              Array.from(store.TraderDailySnapshot.values()).filter(
                (r) => r.chainId === chainId,
              ),
          },
        },
      },
      TraderPoolDailySnapshot: wrap(store.TraderPoolDailySnapshot),
      AggregatorDailySnapshot: wrap(store.AggregatorDailySnapshot),
      TraderPoolDayMarker: wrap(store.TraderPoolDayMarker),
      AggregatorTraderDayMarker: wrap(store.AggregatorTraderDayMarker),
      LeaderboardChainState: wrap(store.LeaderboardChainState),
      LeaderboardWindowSnapshot: wrap(store.LeaderboardWindowSnapshot),
    },
    store,
  };
}

// Stub Pool with the few fields the helper reads.
function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: POOL_ID_1,
    chainId: CHAIN,
    token0: "0xtoken0",
    token1: "0xtoken1",
    token0Decimals: 18,
    token1Decimals: 18,
    source: "fpmm_factory",
    reserves0: 0n,
    reserves1: 0n,
    swapCount: 0,
    notionalVolume0: 0n,
    notionalVolume1: 0n,
    rebalanceCount: 0,
    oracleOk: false,
    oraclePrice: 0n,
    oracleTimestamp: 0n,
    oracleTxHash: "",
    oracleExpiry: 0n,
    oracleNumReporters: 0,
    referenceRateFeedID: "",
    lastMedianPrice: 0n,
    lastMedianAt: 0n,
    prevMedianPrice: 0n,
    prevMedianAt: 0n,
    lastOracleJumpBps: "0.0000",
    lastOracleJumpAt: 0n,
    invertRateFeed: false,
    priceDifference: 0n,
    rebalanceThreshold: 0,
    lastRebalancedAt: 0n,
    deviationBreachStartedAt: 0n,
    currentOpenBreachPeak: 0n,
    currentOpenBreachEntryThreshold: 0,
    healthStatus: "OK",
    healthTotalSeconds: 0n,
    healthBinarySeconds: 0n,
    lastOracleSnapshotTimestamp: 0n,
    lastDeviationRatio: "-1",
    lastEffectivenessRatio: "-1",
    hasHealthData: false,
    cumulativeBreachSeconds: 0n,
    cumulativeCriticalSeconds: 0n,
    breachCount: 0,
    lpFee: 25, // 25bps LP fee
    protocolFee: 5, // 5bps protocol fee → 30bps total
    rebalanceReward: -1,
    limitStatus: "OK",
    limitPressure0: "0.0000",
    limitPressure1: "0.0000",
    rebalancerAddress: "",
    rebalanceLivenessStatus: "N/A",
    createdAtBlock: 0n,
    createdAtTimestamp: 0n,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
    ...overrides,
  };
}

// Default swap: trader bought 1000 USD of token1 by giving 1000 USD of token0.
const buyToken1 = {
  amount0In: 1_000n * ONE_USD,
  amount0Out: 0n,
  amount1In: 0n,
  amount1Out: 1_000n * ONE_USD,
};

const sellToken1 = {
  amount0In: 0n,
  amount0Out: 1_000n * ONE_USD,
  amount1In: 1_000n * ONE_USD,
  amount1Out: 0n,
};

describe("applyLeaderboardSnapshots", () => {
  it("first swap creates all expected entities with correct values", async () => {
    const { context, store } = makeContext();
    const pool = fakePool();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 3600n, // 1am UTC
      blockNumber: 0n,
    });

    // TraderDailySnapshot
    const td = store.TraderDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${DAY_2026_05_04}`,
    );
    assert.ok(td, "TraderDailySnapshot row written");
    assert.equal(td.swapCount, 1);
    assert.equal(td.uniquePools, 1);
    assert.equal(td.volumeUsdWei, 1_000n * ONE_USD);
    assert.equal(td.feesPaidUsdWei, (1_000n * ONE_USD * 30n) / 10_000n); // 3.0 USD
    assert.equal(td.isSystemAddress, false);
    assert.equal(td.lastSeenTimestamp, DAY_2026_05_04 + 3600n);

    // TraderPoolDailySnapshot
    const tpd = store.TraderPoolDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${POOL_ID_1}-${DAY_2026_05_04}`,
    );
    assert.ok(tpd);
    assert.equal(tpd.swapCount, 1);
    assert.equal(tpd.volumeUsdWei, 1_000n * ONE_USD);
    // Bought token1 → outflow_token0 + inflow_token1, both = volumeUsdWei
    assert.equal(tpd.outflowToken0UsdWei, 1_000n * ONE_USD);
    assert.equal(tpd.inflowToken1UsdWei, 1_000n * ONE_USD);
    assert.equal(tpd.inflowToken0UsdWei, 0n);
    assert.equal(tpd.outflowToken1UsdWei, 0n);

    // AggregatorDailySnapshot — txTo was Squid
    const ad = store.AggregatorDailySnapshot.get(
      `${CHAIN}-squid-${DAY_2026_05_04}`,
    );
    assert.ok(ad);
    assert.equal(ad.aggregator, "squid");
    assert.equal(ad.lastSeenAggregatorAddress, SQUID);
    assert.equal(ad.swapCount, 1);
    assert.equal(ad.uniqueTraders, 1);
    assert.equal(ad.volumeUsdWei, 1_000n * ONE_USD);

    // Markers exist
    assert.equal(store.TraderPoolDayMarker.size, 1);
    assert.equal(store.AggregatorTraderDayMarker.size, 1);
  });

  it("second swap by same trader in same pool same day: increments counts, does NOT bump uniquePools", async () => {
    const { context, store } = makeContext();
    const pool = fakePool();

    for (let i = 0; i < 2; i++) {
      await applyLeaderboardSnapshots({
        context,
        chainId: CHAIN,
        poolId: POOL_ID_1,
        pool,
        caller: TRADER_A,
        txTo: SQUID,
        volumeUsdWei: 500n * ONE_USD,
        amounts: buyToken1,
        blockTimestamp: DAY_2026_05_04 + BigInt(3600 + i * 60),
        blockNumber: 0n,
      });
    }

    const td = store.TraderDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${DAY_2026_05_04}`,
    )!;
    assert.equal(td.swapCount, 2);
    assert.equal(td.uniquePools, 1, "same pool both swaps");
    assert.equal(td.volumeUsdWei, 1_000n * ONE_USD);

    const ad = store.AggregatorDailySnapshot.get(
      `${CHAIN}-squid-${DAY_2026_05_04}`,
    )!;
    assert.equal(ad.swapCount, 2);
    assert.equal(ad.uniqueTraders, 1, "same trader both swaps");
  });

  it("swaps in 2 different pools: uniquePools increments to 2", async () => {
    const { context, store } = makeContext();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool: fakePool({ id: POOL_ID_1 }),
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 100n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_2,
      pool: fakePool({ id: POOL_ID_2 }),
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 200n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 200n,
      blockNumber: 0n,
    });

    const td = store.TraderDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${DAY_2026_05_04}`,
    )!;
    assert.equal(td.swapCount, 2);
    assert.equal(td.uniquePools, 2);
    assert.equal(td.volumeUsdWei, 300n * ONE_USD);
  });

  it("two different traders via same aggregator: uniqueTraders increments to 2", async () => {
    const { context, store } = makeContext();
    const pool = fakePool();

    for (const trader of [TRADER_A, TRADER_B]) {
      await applyLeaderboardSnapshots({
        context,
        chainId: CHAIN,
        poolId: POOL_ID_1,
        pool,
        caller: trader,
        txTo: SQUID,
        volumeUsdWei: 100n * ONE_USD,
        amounts: buyToken1,
        blockTimestamp: DAY_2026_05_04 + 100n,
        blockNumber: 0n,
      });
    }

    const ad = store.AggregatorDailySnapshot.get(
      `${CHAIN}-squid-${DAY_2026_05_04}`,
    )!;
    assert.equal(ad.swapCount, 2);
    assert.equal(ad.uniqueTraders, 2);
    assert.equal(ad.volumeUsdWei, 200n * ONE_USD);

    // Two distinct TraderDailySnapshot rows, one per trader.
    assert.equal(store.TraderDailySnapshot.size, 2);
  });

  it("swaps via different aggregators land in different AggregatorDailySnapshot rows", async () => {
    const { context, store } = makeContext();
    const pool = fakePool();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 100n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: TRADER_A,
      txTo: LIFI,
      volumeUsdWei: 200n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 200n,
      blockNumber: 0n,
    });

    assert.ok(
      store.AggregatorDailySnapshot.get(`${CHAIN}-squid-${DAY_2026_05_04}`),
    );
    assert.ok(
      store.AggregatorDailySnapshot.get(`${CHAIN}-lifi-${DAY_2026_05_04}`),
    );

    // TraderDailySnapshot — same trader, two swaps, total volume = 300 USD
    const td = store.TraderDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${DAY_2026_05_04}`,
    )!;
    assert.equal(td.swapCount, 2);
    assert.equal(td.volumeUsdWei, 300n * ONE_USD);
  });

  it("Mento Broker txTo classifies swap as 'direct' aggregator", async () => {
    const { context, store } = makeContext();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool: fakePool(),
      caller: TRADER_A,
      txTo: CELO_BROKER,
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    assert.ok(
      store.AggregatorDailySnapshot.get(`${CHAIN}-direct-${DAY_2026_05_04}`),
    );
  });

  it("rebalancer EOA on Pool: trader is flagged isSystemAddress=true", async () => {
    const { context, store } = makeContext();
    const rebalancerEoa = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const pool = fakePool({ rebalancerAddress: rebalancerEoa });

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: rebalancerEoa,
      txTo: rebalancerEoa, // direct call from rebalancer
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    const td = store.TraderDailySnapshot.get(
      `${CHAIN}-${rebalancerEoa}-${DAY_2026_05_04}`,
    )!;
    assert.equal(td.isSystemAddress, true);
  });

  it("isSystemAddress is sticky across multiple swaps in a day", async () => {
    const { context, store } = makeContext();
    const rebalancerEoa = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const pool = fakePool({ rebalancerAddress: rebalancerEoa });

    // First swap: rebalancer EOA → flagged
    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: rebalancerEoa,
      txTo: SQUID,
      volumeUsdWei: 100n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    // Second swap: rebalancer EOA on a *different* pool where the rebalancer
    // is NOT this address — would no longer be flagged via the per-pool check
    // alone, but stickiness preserves the flag.
    const otherPool = fakePool({
      id: POOL_ID_2,
      rebalancerAddress: "0x0000000000000000000000000000000000000000",
    });
    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_2,
      pool: otherPool,
      caller: rebalancerEoa,
      txTo: SQUID,
      volumeUsdWei: 100n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 200n,
      blockNumber: 0n,
    });

    const td = store.TraderDailySnapshot.get(
      `${CHAIN}-${rebalancerEoa}-${DAY_2026_05_04}`,
    )!;
    assert.equal(
      td.isSystemAddress,
      true,
      "sticky: once flagged, stays flagged for the day",
    );
  });

  it("missing caller (empty string) is dropped — no entities created", async () => {
    const { context, store } = makeContext();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool: fakePool(),
      caller: "",
      txTo: SQUID,
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    assert.equal(store.TraderDailySnapshot.size, 0);
    assert.equal(store.TraderPoolDailySnapshot.size, 0);
    assert.equal(store.AggregatorDailySnapshot.size, 0);
  });

  it("sell direction: trader gave token1 + got token0 → outflow_token1 + inflow_token0", async () => {
    const { context, store } = makeContext();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool: fakePool(),
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: sellToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    const tpd = store.TraderPoolDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${POOL_ID_1}-${DAY_2026_05_04}`,
    )!;
    assert.equal(tpd.inflowToken0UsdWei, 1_000n * ONE_USD);
    assert.equal(tpd.outflowToken1UsdWei, 1_000n * ONE_USD);
    assert.equal(tpd.outflowToken0UsdWei, 0n);
    assert.equal(tpd.inflowToken1UsdWei, 0n);
  });

  it("pool with -1 fee sentinels (RPC not yet read) → feesPaidUsdWei = 0", async () => {
    const { context, store } = makeContext();
    const pool = fakePool({ lpFee: -1, protocolFee: -1 });

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    const td = store.TraderDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${DAY_2026_05_04}`,
    )!;
    assert.equal(td.feesPaidUsdWei, 0n);
  });

  it("swaps spanning two days create two TraderDailySnapshot rows", async () => {
    const { context, store } = makeContext();
    const pool = fakePool();

    // Day N
    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 100n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 3600n,
      blockNumber: 0n,
    });

    // Day N+1
    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool,
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 200n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 86_400n + 3600n,
      blockNumber: 0n,
    });

    assert.equal(store.TraderDailySnapshot.size, 2);
    const day1 = store.TraderDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${DAY_2026_05_04}`,
    )!;
    const day2 = store.TraderDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${DAY_2026_05_04 + 86_400n}`,
    )!;
    assert.equal(day1.volumeUsdWei, 100n * ONE_USD);
    assert.equal(day2.volumeUsdWei, 200n * ONE_USD);
  });

  it("uncomputable USD (volumeUsdWei === 0n) is dropped — no entities created", async () => {
    // computeSwapUsdWei returns 0n for pools where neither token is in
    // USD_PEGGED_SYMBOLS. Persisting 0n into the rollups would conflate
    // "uncomputable" with "real zero volume" and silently undercount those
    // pools' traders. Helper short-circuits — same pattern as missing caller.
    const { context, store } = makeContext();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool: fakePool(),
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 0n,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    assert.equal(store.TraderDailySnapshot.size, 0);
    assert.equal(store.TraderPoolDailySnapshot.size, 0);
    assert.equal(store.AggregatorDailySnapshot.size, 0);
    assert.equal(store.TraderPoolDayMarker.size, 0);
    assert.equal(store.AggregatorTraderDayMarker.size, 0);
  });

  it("callback-flow swap (both In and Out non-zero on same side) inflates direction-split per documented invariant break", async () => {
    // The src/usd.ts comment notes that for callback / flash-style flows
    // both amount0In AND amount0Out can be non-zero simultaneously. In the
    // standard Uniswap-V2 case exactly one is zero, so inflow + outflow
    // sums to 2 × volumeUsdWei. In callback flow, a single side
    // contributes to BOTH inflow and outflow, breaking that invariant.
    // This test pins the current behavior: don't double-count volumeUsdWei
    // (it's a single value), but DO record both directions for that side.
    const { context, store } = makeContext();
    const callbackAmounts = {
      amount0In: 1_000n * ONE_USD,
      amount0Out: 50n * ONE_USD, // refund leg
      amount1In: 0n,
      amount1Out: 1_000n * ONE_USD,
    };

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool: fakePool(),
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: callbackAmounts,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    const tpd = store.TraderPoolDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${POOL_ID_1}-${DAY_2026_05_04}`,
    )!;
    // Both inflow_token0 and outflow_token0 receive the full volumeUsdWei
    // (current behavior: each non-zero leg → += volumeUsdWei). Token1 only
    // has Out → only inflow_token1.
    assert.equal(tpd.inflowToken0UsdWei, 1_000n * ONE_USD);
    assert.equal(tpd.outflowToken0UsdWei, 1_000n * ONE_USD);
    assert.equal(tpd.inflowToken1UsdWei, 1_000n * ONE_USD);
    assert.equal(tpd.outflowToken1UsdWei, 0n);
    // Sum = 3 × volumeUsdWei, not 2 × — invariant intentionally broken
    // because a single swap genuinely flowed in both directions on token0.
    // TraderDailySnapshot.volumeUsdWei stays = 1 × volumeUsdWei (the SwapEvent's
    // pre-computed notional, not the inflow+outflow sum), so leaderboard
    // ranking is unaffected.
    assert.equal(tpd.volumeUsdWei, 1_000n * ONE_USD);
  });

  it("invariant: inflow + outflow = 2 × volumeUsdWei per swap", async () => {
    const { context, store } = makeContext();

    await applyLeaderboardSnapshots({
      context,
      chainId: CHAIN,
      poolId: POOL_ID_1,
      pool: fakePool(),
      caller: TRADER_A,
      txTo: SQUID,
      volumeUsdWei: 1_000n * ONE_USD,
      amounts: buyToken1,
      blockTimestamp: DAY_2026_05_04 + 100n,
      blockNumber: 0n,
    });

    const tpd = store.TraderPoolDailySnapshot.get(
      `${CHAIN}-${TRADER_A}-${POOL_ID_1}-${DAY_2026_05_04}`,
    )!;
    const total =
      tpd.inflowToken0UsdWei +
      tpd.outflowToken0UsdWei +
      tpd.inflowToken1UsdWei +
      tpd.outflowToken1UsdWei;
    assert.equal(total, 2n * 1_000n * ONE_USD);
  });
});
