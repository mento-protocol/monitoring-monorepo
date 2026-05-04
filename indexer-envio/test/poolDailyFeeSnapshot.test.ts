/// <reference types="mocha" />
import assert from "node:assert/strict";
import generated from "generated";
import {
  _setMockFeeTokenMeta,
  _clearMockFeeTokenMeta,
  _clearBackfilledTokens,
  _clearFeeTokenMetaCache,
  _addMockAllowedFeeToken,
  _clearMockAllowedFeeTokens,
} from "../src/EventHandlers.ts";
import { makePoolId, dayBucket, dailySnapshotId } from "../src/helpers.ts";
import { mergeFeeSnapshot } from "../src/protocolFeeSnapshot.ts";
import { USD_WEI_DECIMALS, computeFeeUsdWei } from "../src/usd.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MockDb = {
  entities: {
    Pool: { get: (id: string) => unknown; set: (e: unknown) => MockDb };
    ProtocolFeeTransfer: { get: (id: string) => unknown };
    PoolDailyFeeSnapshot: { get: (id: string) => unknown };
    [key: string]: { get: (id: string) => unknown };
  };
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    ERC20FeeToken: {
      Transfer: {
        createMockEvent: (args: {
          from?: string;
          to?: string;
          value?: bigint;
          mockEventData?: {
            chainId?: number;
            srcAddress?: string;
            logIndex?: number;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
    };
    FPMMFactory: {
      FPMMDeployed: {
        createMockEvent: (args: {
          token0: string;
          token1: string;
          fpmmProxy: string;
          fpmmImplementation: string;
          mockEventData: {
            chainId: number;
            logIndex: number;
            srcAddress: string;
            block: { number: number; timestamp: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, ERC20FeeToken, FPMMFactory } = TestHelpers;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const YIELD_SPLIT = "0x0dd57f6f181d0469143fe9380762d8a112e96e4a" as const;
const POOL_ADDRESS = "0x00000000000000000000000000000000000000aa";
const POOL_ADDRESS_B = "0x00000000000000000000000000000000000000bb";
const RANDOM_SENDER = "0x0000000000000000000000000000000000dead01";

// Token addresses (all lowercased)
const USDC_ADDRESS = "0x0000000000000000000000000000000000000042";
const USDM_ADDRESS = "0x0000000000000000000000000000000000000043";
const EURM_ADDRESS = "0x0000000000000000000000000000000000000044";
const UNKNOWN_TOKEN = "0x0000000000000000000000000000000000000099";

// UTC timestamps — all on 2025-01-15 (same day)
const TS_DAY1_MORNING = 1_736_928_000; // 2025-01-15 08:00:00 UTC
const TS_DAY1_AFTERNOON = 1_736_951_400; // 2025-01-15 14:30:00 UTC
// 2025-01-16 01:00:00 UTC — different day
const TS_DAY2 = 1_736_989_200;

const CELO_CHAIN = 42220;
const MONAD_CHAIN = 143;

// Scale: USDC is 6dp, USDm/EURm are 18dp
const USDC_DECIMALS = 6;
const USDM_DECIMALS = 18;
const EURM_DECIMALS = 18;

// Amounts
const AMOUNT_1E6 = 1_000_000n; // 1 USDC (6dp)
const AMOUNT_1E18 = 1_000_000_000_000_000_000n; // 1 USDm / 1 EURm (18dp)

// USD-wei equivalents
const USD_WEI_SCALE_6 = 10n ** BigInt(USD_WEI_DECIMALS - USDC_DECIMALS); // 1e12
const AMOUNT_1E6_USD_WEI = AMOUNT_1E6 * USD_WEI_SCALE_6; // 1e18

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pid(addr: string, chainId = CELO_CHAIN): string {
  return makePoolId(chainId, addr);
}

async function seedFpmmPool(
  mockDb: MockDb,
  poolAddr: string,
  chainId = CELO_CHAIN,
  token0 = USDC_ADDRESS,
  token1 = USDM_ADDRESS,
): Promise<MockDb> {
  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0,
    token1,
    fpmmProxy: poolAddr,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId,
      logIndex: 1,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: 100, timestamp: 1_700_000_000 },
    },
  });
  return FPMMFactory.FPMMDeployed.processEvent({ event: deployEvent, mockDb });
}

function createTransferEvent(overrides: {
  from?: string;
  to?: string;
  value?: bigint;
  srcAddress?: string;
  chainId?: number;
  blockNumber?: number;
  blockTimestamp?: number;
  logIndex?: number;
}) {
  return ERC20FeeToken.Transfer.createMockEvent({
    from: overrides.from ?? POOL_ADDRESS,
    to: overrides.to ?? YIELD_SPLIT,
    value: overrides.value ?? AMOUNT_1E6,
    mockEventData: {
      chainId: overrides.chainId ?? CELO_CHAIN,
      srcAddress: overrides.srcAddress ?? USDC_ADDRESS,
      logIndex: overrides.logIndex ?? 10,
      block: {
        number: overrides.blockNumber ?? 500,
        timestamp: overrides.blockTimestamp ?? TS_DAY1_MORNING,
      },
    },
  });
}

type FeeSnapshotLike = {
  id: string;
  chainId: number;
  poolId: string;
  poolAddress: string;
  timestamp: bigint;
  tokens: string[];
  tokenSymbols: string[];
  tokenDecimals: number[];
  amounts: bigint[];
  feesUsdWei: bigint;
  allPegged: boolean;
  unresolvedCount: number;
  transferCount: number;
  blockNumber: bigint;
  updatedAtTimestamp: bigint;
};

function getSnapshot(
  mockDb: MockDb,
  poolAddr: string,
  dayTs: bigint,
  chainId = CELO_CHAIN,
): FeeSnapshotLike | undefined {
  const id = dailySnapshotId(pid(poolAddr, chainId), dayTs);
  return mockDb.entities.PoolDailyFeeSnapshot.get(id) as
    | FeeSnapshotLike
    | undefined;
}

// ---------------------------------------------------------------------------
// Handler-level integration tests (use mockDb)
// ---------------------------------------------------------------------------

describe("PoolDailyFeeSnapshot handler integration", () => {
  beforeEach(() => {
    _setMockFeeTokenMeta(CELO_CHAIN, USDC_ADDRESS, {
      symbol: "USDC",
      decimals: USDC_DECIMALS,
    });
    _setMockFeeTokenMeta(CELO_CHAIN, USDM_ADDRESS, {
      symbol: "USDm",
      decimals: USDM_DECIMALS,
    });
    _setMockFeeTokenMeta(CELO_CHAIN, EURM_ADDRESS, {
      symbol: "EURm",
      decimals: EURM_DECIMALS,
    });
    _addMockAllowedFeeToken(CELO_CHAIN, USDC_ADDRESS);
    _addMockAllowedFeeToken(CELO_CHAIN, USDM_ADDRESS);
    _addMockAllowedFeeToken(CELO_CHAIN, EURM_ADDRESS);
  });

  afterEach(() => {
    _clearMockFeeTokenMeta();
    _clearBackfilledTokens();
    _clearFeeTokenMetaCache();
    _clearMockAllowedFeeTokens();
  });

  // -------------------------------------------------------------------------
  // Test 1: Same-day same-token merge
  // -------------------------------------------------------------------------
  it("same-day same-token merge: accumulates amounts and feesUsdWei", async function () {
    this.timeout(15_000);

    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb, POOL_ADDRESS);

    const event1 = createTransferEvent({
      value: AMOUNT_1E6,
      srcAddress: USDC_ADDRESS,
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 501,
      logIndex: 10,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({
      event: event1,
      mockDb,
    });

    const event2 = createTransferEvent({
      value: AMOUNT_1E6 * 2n,
      srcAddress: USDC_ADDRESS,
      blockTimestamp: TS_DAY1_AFTERNOON,
      blockNumber: 502,
      logIndex: 11,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({
      event: event2,
      mockDb,
    });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const snap = getSnapshot(mockDb, POOL_ADDRESS, dayTs);
    assert.ok(snap, "PoolDailyFeeSnapshot must exist");
    assert.equal(snap!.transferCount, 2, "transferCount === 2");
    assert.equal(snap!.tokens.length, 1, "single token");
    assert.equal(snap!.amounts[0], AMOUNT_1E6 * 3n, "amounts[0] = a + b");
    assert.equal(
      snap!.feesUsdWei,
      AMOUNT_1E6_USD_WEI * 3n,
      "feesUsdWei = (a + b) scaled to 18dp",
    );
    assert.equal(snap!.allPegged, true, "USDC is pegged");
    assert.equal(snap!.unresolvedCount, 0);

    // Parity check: raw ProtocolFeeTransfer amounts summed == snapshot amounts[0]
    const tx1Id = `${CELO_CHAIN}_501_10`;
    const tx2Id = `${CELO_CHAIN}_502_11`;
    const raw1 = mockDb.entities.ProtocolFeeTransfer.get(tx1Id) as
      | { amount: bigint }
      | undefined;
    const raw2 = mockDb.entities.ProtocolFeeTransfer.get(tx2Id) as
      | { amount: bigint }
      | undefined;
    assert.ok(raw1 && raw2, "both raw transfers must exist");
    assert.equal(
      raw1!.amount + raw2!.amount,
      snap!.amounts[0],
      "raw transfer sum == snapshot amounts[0] (parity check)",
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: Same-day different tokens
  // -------------------------------------------------------------------------
  it("same-day different tokens: two entries in parallel arrays", async function () {
    this.timeout(15_000);

    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb, POOL_ADDRESS);

    // USDC transfer
    const ev1 = createTransferEvent({
      value: AMOUNT_1E6,
      srcAddress: USDC_ADDRESS,
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 510,
      logIndex: 20,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev1, mockDb });

    // USDm transfer
    const ev2 = createTransferEvent({
      value: AMOUNT_1E18,
      srcAddress: USDM_ADDRESS,
      blockTimestamp: TS_DAY1_AFTERNOON,
      blockNumber: 511,
      logIndex: 21,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev2, mockDb });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const snap = getSnapshot(mockDb, POOL_ADDRESS, dayTs);
    assert.ok(snap);
    assert.equal(snap!.tokens.length, 2, "two distinct tokens");
    assert.equal(snap!.tokenSymbols.length, 2);
    assert.equal(snap!.tokenDecimals.length, 2);
    assert.equal(snap!.amounts.length, 2);

    // USDC entry at index 0, USDm at index 1 (insertion order)
    const usdcIdx = snap!.tokens.indexOf(USDC_ADDRESS);
    const usdmIdx = snap!.tokens.indexOf(USDM_ADDRESS);
    assert.ok(usdcIdx >= 0 && usdmIdx >= 0, "both tokens tracked");
    assert.equal(snap!.amounts[usdcIdx], AMOUNT_1E6);
    assert.equal(snap!.amounts[usdmIdx], AMOUNT_1E18);

    // feesUsdWei = USDC contribution + USDm contribution
    const expectedUsdWei = AMOUNT_1E6_USD_WEI + AMOUNT_1E18; // USDC(6dp->18dp) + USDm(18dp)
    assert.equal(snap!.feesUsdWei, expectedUsdWei);
    assert.equal(snap!.allPegged, true, "both are pegged");
    assert.equal(snap!.transferCount, 2);
  });

  // -------------------------------------------------------------------------
  // Test 3: Cross-day — two distinct rows
  // -------------------------------------------------------------------------
  it("cross-day: creates two distinct PoolDailyFeeSnapshot rows", async function () {
    this.timeout(15_000);

    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb, POOL_ADDRESS);

    const ev1 = createTransferEvent({
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 520,
      logIndex: 30,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev1, mockDb });

    const ev2 = createTransferEvent({
      blockTimestamp: TS_DAY2,
      blockNumber: 521,
      logIndex: 31,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev2, mockDb });

    const day1Ts = dayBucket(BigInt(TS_DAY1_MORNING));
    const day2Ts = dayBucket(BigInt(TS_DAY2));
    assert.notEqual(day1Ts, day2Ts, "different day buckets");

    const snap1 = getSnapshot(mockDb, POOL_ADDRESS, day1Ts);
    const snap2 = getSnapshot(mockDb, POOL_ADDRESS, day2Ts);
    assert.ok(snap1, "day-1 snapshot exists");
    assert.ok(snap2, "day-2 snapshot exists");
    assert.notEqual(snap1!.id, snap2!.id, "distinct row IDs");
    assert.equal(snap1!.transferCount, 1);
    assert.equal(snap2!.transferCount, 1);
  });

  // -------------------------------------------------------------------------
  // Test 4: Non-pegged token (EURm)
  // -------------------------------------------------------------------------
  it("non-pegged token: feesUsdWei === 0, allPegged === false", async function () {
    this.timeout(15_000);

    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(
      mockDb,
      POOL_ADDRESS,
      CELO_CHAIN,
      EURM_ADDRESS,
      USDM_ADDRESS,
    );

    const ev = createTransferEvent({
      value: AMOUNT_1E18,
      srcAddress: EURM_ADDRESS,
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 530,
      logIndex: 40,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev, mockDb });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const snap = getSnapshot(mockDb, POOL_ADDRESS, dayTs);
    assert.ok(snap);
    assert.equal(snap!.feesUsdWei, 0n, "feesUsdWei === 0 for non-pegged");
    assert.equal(snap!.allPegged, false, "allPegged === false");
    assert.equal(
      snap!.tokens.length,
      1,
      "token still tracked in parallel arrays",
    );
    assert.equal(snap!.tokens[0], EURM_ADDRESS);
    assert.equal(snap!.amounts[0], AMOUNT_1E18);
    assert.equal(snap!.tokenSymbols[0], "EURm");
    assert.equal(snap!.unresolvedCount, 0);
  });

  // -------------------------------------------------------------------------
  // Test 5: UNKNOWN symbol
  // -------------------------------------------------------------------------
  it("UNKNOWN symbol: unresolvedCount === 1, feesUsdWei === 0", async function () {
    this.timeout(15_000);

    _setMockFeeTokenMeta(CELO_CHAIN, UNKNOWN_TOKEN, "FAIL");
    _addMockAllowedFeeToken(CELO_CHAIN, UNKNOWN_TOKEN);

    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(
      mockDb,
      POOL_ADDRESS,
      CELO_CHAIN,
      UNKNOWN_TOKEN,
      USDM_ADDRESS,
    );

    const ev = createTransferEvent({
      value: AMOUNT_1E18,
      srcAddress: UNKNOWN_TOKEN,
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 540,
      logIndex: 50,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev, mockDb });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const snap = getSnapshot(mockDb, POOL_ADDRESS, dayTs);
    assert.ok(snap);
    assert.equal(snap!.unresolvedCount, 1, "unresolvedCount === 1");
    assert.equal(snap!.feesUsdWei, 0n, "no USD contribution from UNKNOWN");
    assert.equal(snap!.tokenSymbols[0], "UNKNOWN");
  });

  // -------------------------------------------------------------------------
  // Test 6: Cross-chain isolation
  // -------------------------------------------------------------------------
  it("cross-chain: same pool address on Celo and Monad produces distinct snapshots", async function () {
    this.timeout(15_000);

    // Register mock meta for Monad chain too
    _setMockFeeTokenMeta(MONAD_CHAIN, USDC_ADDRESS, {
      symbol: "USDC",
      decimals: USDC_DECIMALS,
    });
    _addMockAllowedFeeToken(MONAD_CHAIN, USDC_ADDRESS);

    let mockDb = MockDb.createMockDb();

    // Seed pools on both chains (same address)
    mockDb = await seedFpmmPool(mockDb, POOL_ADDRESS, CELO_CHAIN);

    // Also seed on Monad (different chainId)
    const monadDeployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: USDC_ADDRESS,
      token1: USDM_ADDRESS,
      fpmmProxy: POOL_ADDRESS,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: MONAD_CHAIN,
        logIndex: 1,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 100, timestamp: 1_700_000_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: monadDeployEvent,
      mockDb,
    });

    // Fire a transfer on Celo
    const celoEv = createTransferEvent({
      from: POOL_ADDRESS,
      chainId: CELO_CHAIN,
      srcAddress: USDC_ADDRESS,
      value: AMOUNT_1E6,
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 550,
      logIndex: 60,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({
      event: celoEv,
      mockDb,
    });

    // Fire a transfer on Monad
    const monadEv = createTransferEvent({
      from: POOL_ADDRESS,
      chainId: MONAD_CHAIN,
      srcAddress: USDC_ADDRESS,
      value: AMOUNT_1E6 * 5n,
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 551,
      logIndex: 61,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({
      event: monadEv,
      mockDb,
    });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const celoSnap = getSnapshot(mockDb, POOL_ADDRESS, dayTs, CELO_CHAIN);
    const monadSnap = getSnapshot(mockDb, POOL_ADDRESS, dayTs, MONAD_CHAIN);

    assert.ok(celoSnap, "Celo snapshot exists");
    assert.ok(monadSnap, "Monad snapshot exists");
    assert.notEqual(celoSnap!.id, monadSnap!.id, "distinct IDs by chainId");
    assert.equal(celoSnap!.chainId, CELO_CHAIN);
    assert.equal(monadSnap!.chainId, MONAD_CHAIN);
    assert.equal(celoSnap!.amounts[0], AMOUNT_1E6, "Celo amount correct");
    assert.equal(
      monadSnap!.amounts[0],
      AMOUNT_1E6 * 5n,
      "Monad amount correct",
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: Non-pool sender — no snapshot written
  // -------------------------------------------------------------------------
  it("non-pool sender: no PoolDailyFeeSnapshot row created", async function () {
    this.timeout(15_000);

    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb, POOL_ADDRESS);

    const ev = createTransferEvent({
      from: RANDOM_SENDER, // not a pool
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 560,
      logIndex: 70,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev, mockDb });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const snap = getSnapshot(mockDb, RANDOM_SENDER, dayTs);
    assert.equal(snap, undefined, "no snapshot written for non-pool sender");

    // Also verify the FPMM pool's snapshot is untouched
    const poolSnap = getSnapshot(mockDb, POOL_ADDRESS, dayTs);
    assert.equal(poolSnap, undefined, "pool snapshot also untouched");
  });

  // -------------------------------------------------------------------------
  // Replay idempotency: re-processing the same event must not double-count.
  // -------------------------------------------------------------------------
  it("replay: re-processing the same event leaves snapshot unchanged", async function () {
    this.timeout(15_000);
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb, POOL_ADDRESS);

    const ev = createTransferEvent({
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 700,
      logIndex: 1,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev, mockDb });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const after1 = getSnapshot(mockDb, POOL_ADDRESS, dayTs)!;
    assert.equal(after1.transferCount, 1);
    assert.equal(after1.amounts[0], AMOUNT_1E6);

    // Reorg / restart: same event re-fires.
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev, mockDb });
    const after2 = getSnapshot(mockDb, POOL_ADDRESS, dayTs)!;

    // No double-count.
    assert.equal(
      after2.transferCount,
      1,
      "transferCount must NOT increment on replay",
    );
    assert.equal(
      after2.amounts[0],
      AMOUNT_1E6,
      "amount must NOT double on replay",
    );
    assert.equal(
      after2.feesUsdWei,
      after1.feesUsdWei,
      "USD must NOT double on replay",
    );
  });

  // NOTE: cross-day backfill (a later-day resolution healing past-day
  // snapshots via the handler's backfill loop) cannot be verified here.
  // Envio's mockDb does not surface multi-id `set()` calls within a single
  // handler invocation — even the EXISTING `ProtocolFeeTransfer` repair in
  // the same loop is invisible after `processEvent` returns. Production
  // Envio runtime persists all sets correctly. The cross-day heal logic is
  // covered at the unit-test level via `mergeFeeSnapshot` heal mode tests
  // below (heal mode reprices the prior accumulated amount and decrements
  // `unresolvedCount` regardless of the day boundary).

  it("replay with newly-resolved symbol: heals snapshot without double-counting", async function () {
    this.timeout(15_000);
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb, POOL_ADDRESS);

    // First indexing: token resolution failed → UNKNOWN.
    const stalledTokenAddress = "0x000000000000000000000000000000000000feed";
    _addMockAllowedFeeToken(CELO_CHAIN, stalledTokenAddress);
    // Don't register meta — resolveFeeTokenMeta returns UNKNOWN/18.
    const ev = createTransferEvent({
      srcAddress: stalledTokenAddress,
      blockTimestamp: TS_DAY1_MORNING,
      blockNumber: 800,
      logIndex: 2,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev, mockDb });

    const dayTs = dayBucket(BigInt(TS_DAY1_MORNING));
    const before = getSnapshot(mockDb, POOL_ADDRESS, dayTs)!;
    assert.equal(before.tokenSymbols[0], "UNKNOWN");
    assert.equal(before.feesUsdWei, 0n, "UNKNOWN contributes 0 USD");
    assert.equal(before.unresolvedCount, 1);
    assert.equal(before.transferCount, 1);

    // Cache populates (e.g. another swap happened, FPMMDeployed, etc.) and
    // the same event re-fires (replay).
    _setMockFeeTokenMeta(CELO_CHAIN, stalledTokenAddress, {
      symbol: "USDC",
      decimals: USDC_DECIMALS,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event: ev, mockDb });

    const after = getSnapshot(mockDb, POOL_ADDRESS, dayTs)!;
    // Metadata repaired.
    assert.equal(after.tokenSymbols[0], "USDC");
    assert.equal(after.tokenDecimals[0], USDC_DECIMALS);
    // USD repriced for the prior amount, not double-counted.
    assert.equal(after.amounts[0], AMOUNT_1E6, "amount unchanged");
    assert.equal(
      after.feesUsdWei,
      computeFeeUsdWei({
        tokenSymbol: "USDC",
        tokenDecimals: USDC_DECIMALS,
        amount: AMOUNT_1E6,
      }),
      "USD covers the prior accumulated amount, not 2x",
    );
    assert.equal(after.unresolvedCount, 0, "slot now resolved");
    assert.equal(after.allPegged, true);
    assert.equal(after.transferCount, 1, "transferCount unchanged on replay");
  });
});

// ---------------------------------------------------------------------------
// Pure-function mergeFeeSnapshot tests (no mockDb)
// ---------------------------------------------------------------------------

describe("mergeFeeSnapshot pure function", () => {
  const BASE_ID = `${CELO_CHAIN}-${POOL_ADDRESS}-1736899200`;
  const POOL_ID = pid(POOL_ADDRESS);
  const NOW_TS = BigInt(TS_DAY1_MORNING);
  const DAY_TS = dayBucket(NOW_TS);
  const BLOCK_NUM = 500n;

  function makeInput(overrides: {
    token?: string;
    tokenSymbol?: string;
    tokenDecimals?: number;
    amount?: bigint;
    blockNumber?: bigint;
    updatedAtTimestamp?: bigint;
  }) {
    return {
      id: BASE_ID,
      chainId: CELO_CHAIN,
      poolId: POOL_ID,
      poolAddress: POOL_ADDRESS,
      timestamp: DAY_TS,
      token: overrides.token ?? USDC_ADDRESS,
      tokenSymbol: overrides.tokenSymbol ?? "USDC",
      tokenDecimals: overrides.tokenDecimals ?? USDC_DECIMALS,
      amount: overrides.amount ?? AMOUNT_1E6,
      blockNumber: overrides.blockNumber ?? BLOCK_NUM,
      updatedAtTimestamp: overrides.updatedAtTimestamp ?? NOW_TS,
    };
  }

  // -------------------------------------------------------------------------
  // First-write (undefined existing)
  // -------------------------------------------------------------------------
  it("undefined → first-write seeds all fields correctly", () => {
    const result = mergeFeeSnapshot(undefined, makeInput({}));

    assert.equal(result.id, BASE_ID);
    assert.equal(result.transferCount, 1);
    assert.deepEqual(result.tokens, [USDC_ADDRESS]);
    assert.deepEqual(result.tokenSymbols, ["USDC"]);
    assert.deepEqual(result.tokenDecimals, [USDC_DECIMALS]);
    assert.deepEqual(result.amounts, [AMOUNT_1E6]);
    assert.equal(result.feesUsdWei, AMOUNT_1E6_USD_WEI);
    assert.equal(result.allPegged, true);
    assert.equal(result.unresolvedCount, 0);
    assert.equal(result.blockNumber, BLOCK_NUM);
    assert.equal(result.updatedAtTimestamp, NOW_TS);
  });

  // -------------------------------------------------------------------------
  // Same-token merge
  // -------------------------------------------------------------------------
  it("same-token merge: sums amounts and feesUsdWei", () => {
    const first = mergeFeeSnapshot(
      undefined,
      makeInput({ amount: AMOUNT_1E6 }),
    );
    const second = mergeFeeSnapshot(
      first,
      makeInput({ amount: AMOUNT_1E6 * 2n, blockNumber: 501n }),
    );

    assert.equal(second.transferCount, 2);
    assert.equal(second.tokens.length, 1, "still one token");
    assert.equal(second.amounts[0], AMOUNT_1E6 * 3n, "amounts summed");
    assert.equal(
      second.feesUsdWei,
      AMOUNT_1E6_USD_WEI * 3n,
      "feesUsdWei summed",
    );
    assert.equal(second.blockNumber, 501n, "blockNumber = max");
  });

  // -------------------------------------------------------------------------
  // New-token append
  // -------------------------------------------------------------------------
  it("new-token append: pushes to all parallel arrays", () => {
    const first = mergeFeeSnapshot(undefined, makeInput({}));
    const second = mergeFeeSnapshot(
      first,
      makeInput({
        token: USDM_ADDRESS,
        tokenSymbol: "USDm",
        tokenDecimals: USDM_DECIMALS,
        amount: AMOUNT_1E18,
      }),
    );

    assert.equal(second.tokens.length, 2);
    assert.equal(second.tokenSymbols.length, 2);
    assert.equal(second.tokenDecimals.length, 2);
    assert.equal(second.amounts.length, 2);
    assert.equal(second.tokens[1], USDM_ADDRESS);
    assert.equal(second.amounts[1], AMOUNT_1E18);
    // feesUsdWei = USDC contribution + USDm contribution
    assert.equal(second.feesUsdWei, AMOUNT_1E6_USD_WEI + AMOUNT_1E18);
    assert.equal(second.allPegged, true);
    assert.equal(second.transferCount, 2);
  });

  // -------------------------------------------------------------------------
  // allPegged transitions
  // -------------------------------------------------------------------------
  it("allPegged stays true when all transfers are pegged", () => {
    const first = mergeFeeSnapshot(undefined, makeInput({}));
    const second = mergeFeeSnapshot(
      first,
      makeInput({
        token: USDM_ADDRESS,
        tokenSymbol: "USDm",
        tokenDecimals: USDM_DECIMALS,
        amount: AMOUNT_1E18,
      }),
    );
    assert.equal(second.allPegged, true);
  });

  it("allPegged flips false when a non-pegged transfer arrives", () => {
    // Start with a pegged token
    const first = mergeFeeSnapshot(undefined, makeInput({}));
    assert.equal(first.allPegged, true);

    // Add a non-pegged token
    const second = mergeFeeSnapshot(
      first,
      makeInput({
        token: EURM_ADDRESS,
        tokenSymbol: "EURm",
        tokenDecimals: EURM_DECIMALS,
        amount: AMOUNT_1E18,
      }),
    );
    assert.equal(
      second.allPegged,
      false,
      "must flip false on first non-pegged",
    );

    // Adding another pegged token afterwards does NOT restore allPegged
    const third = mergeFeeSnapshot(
      second,
      makeInput({
        token: USDM_ADDRESS,
        tokenSymbol: "USDm",
        tokenDecimals: USDM_DECIMALS,
        amount: AMOUNT_1E18,
      }),
    );
    assert.equal(third.allPegged, false, "allPegged never reverts to true");
  });

  it("allPegged is false from first-write when token is non-pegged", () => {
    const result = mergeFeeSnapshot(
      undefined,
      makeInput({
        token: EURM_ADDRESS,
        tokenSymbol: "EURm",
        tokenDecimals: EURM_DECIMALS,
      }),
    );
    assert.equal(result.allPegged, false);
  });

  // -------------------------------------------------------------------------
  // unresolvedCount = number of UNKNOWN slots in tokens[] (NOT transfer count)
  // -------------------------------------------------------------------------
  it("unresolvedCount counts UNKNOWN slots, not UNKNOWN transfers", () => {
    // First UNKNOWN transfer for UNKNOWN_TOKEN: 1 unresolved slot.
    const first = mergeFeeSnapshot(
      undefined,
      makeInput({
        tokenSymbol: "UNKNOWN",
        token: UNKNOWN_TOKEN,
      }),
    );
    assert.equal(first!.unresolvedCount, 1);
    assert.equal(first!.feesUsdWei, 0n);
    assert.equal(first!.tokens.length, 1);

    // Second UNKNOWN transfer for the SAME token: still 1 unresolved slot.
    // The slot already exists; we sum amounts but don't double-count the
    // unresolved state. This matches the dashboard's "is this row
    // approximate?" signal — it doesn't care about transfer count.
    const second = mergeFeeSnapshot(
      first,
      makeInput({
        tokenSymbol: "UNKNOWN",
        token: UNKNOWN_TOKEN,
      }),
    );
    assert.equal(
      second!.unresolvedCount,
      1,
      "same UNKNOWN slot doesn't double-count",
    );
    assert.equal(second!.tokens.length, 1, "still one slot");

    // A resolved transfer for a DIFFERENT token: appends a new slot but
    // doesn't change the unresolved count.
    const third = mergeFeeSnapshot(second, makeInput({}));
    assert.equal(
      third!.unresolvedCount,
      1,
      "resolved transfer for different token doesn't increment",
    );
    assert.equal(third!.tokens.length, 2, "two slots now");
  });

  it("unresolvedCount increments per distinct UNKNOWN token slot", () => {
    const first = mergeFeeSnapshot(
      undefined,
      makeInput({ tokenSymbol: "UNKNOWN", token: UNKNOWN_TOKEN }),
    );
    const second = mergeFeeSnapshot(
      first,
      makeInput({
        tokenSymbol: "UNKNOWN",
        token: "0x000000000000000000000000000000000000ab12",
      }),
    );
    assert.equal(
      second!.unresolvedCount,
      2,
      "two distinct UNKNOWN token slots = count 2",
    );
  });

  // -------------------------------------------------------------------------
  // Self-heal: same-day UNKNOWN → resolved
  // -------------------------------------------------------------------------
  it("self-heals when a same-day re-write resolves a previously UNKNOWN slot", () => {
    // Day-1: first transfer for token X arrives as UNKNOWN, amount 100.
    const unknownAmount = 100n * 10n ** BigInt(USDC_DECIMALS);
    const first = mergeFeeSnapshot(
      undefined,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "UNKNOWN",
        tokenDecimals: USDC_DECIMALS,
        amount: unknownAmount,
      }),
    );
    assert.equal(first!.unresolvedCount, 1);
    assert.equal(first!.feesUsdWei, 0n, "UNKNOWN contributes 0 USD");
    assert.equal(first!.allPegged, false, "UNKNOWN flips allPegged");

    // Same day, second transfer for the SAME token, but symbol now resolves.
    const resolvedAmount = 50n * 10n ** BigInt(USDC_DECIMALS);
    const second = mergeFeeSnapshot(
      first,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "USDC",
        tokenDecimals: USDC_DECIMALS,
        amount: resolvedAmount,
      }),
    );

    // Slot metadata repaired.
    assert.equal(second!.tokenSymbols[0], "USDC");
    assert.equal(second!.tokenDecimals[0], USDC_DECIMALS);
    // Both prior + new amount accumulated.
    assert.equal(
      second!.amounts[0],
      unknownAmount + resolvedAmount,
      "amounts accumulate across the heal",
    );
    // USD = repaired prior amount + new contribution. Both are USDC (pegged).
    const expectedUsd = computeFeeUsdWei({
      tokenSymbol: "USDC",
      tokenDecimals: USDC_DECIMALS,
      amount: unknownAmount + resolvedAmount,
    });
    assert.equal(
      second!.feesUsdWei,
      expectedUsd,
      "feesUsdWei reprices the FULL accumulated amount",
    );
    assert.equal(second!.unresolvedCount, 0, "slot now resolved");
    assert.equal(second!.allPegged, true, "all slots resolved + pegged");
    assert.equal(second!.transferCount, 2, "transferCount tracks both");
  });

  it("self-heal in 'add' mode also adds the new transfer's amount", () => {
    const priorAmount = 100n * 10n ** BigInt(USDC_DECIMALS);
    const first = mergeFeeSnapshot(
      undefined,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "UNKNOWN",
        tokenDecimals: USDC_DECIMALS,
        amount: priorAmount,
      }),
    );
    const newAmount = 7n * 10n ** BigInt(USDC_DECIMALS);
    const healed = mergeFeeSnapshot(
      first,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "USDC",
        tokenDecimals: USDC_DECIMALS,
        amount: newAmount,
      }),
    );
    assert.equal(healed!.amounts[0], priorAmount + newAmount);
    // Total USD covers both.
    assert.equal(
      healed!.feesUsdWei,
      computeFeeUsdWei({
        tokenSymbol: "USDC",
        tokenDecimals: USDC_DECIMALS,
        amount: priorAmount + newAmount,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Heal mode (replay): repair metadata only; don't add amount
  // -------------------------------------------------------------------------
  it("heal mode repairs metadata + reprices prior amount without adding", () => {
    // Original add: UNKNOWN, amount 200.
    const priorAmount = 200n * 10n ** BigInt(USDC_DECIMALS);
    const original = mergeFeeSnapshot(
      undefined,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "UNKNOWN",
        tokenDecimals: USDC_DECIMALS,
        amount: priorAmount,
      }),
    );

    // Replay of the same event with newly resolved symbol — heal mode.
    const healed = mergeFeeSnapshot(
      original,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "USDC",
        tokenDecimals: USDC_DECIMALS,
        amount: priorAmount, // same amount; the prior call already counted it
      }),
      "heal",
    );

    // Slot metadata repaired.
    assert.equal(healed!.tokenSymbols[0], "USDC");
    assert.equal(healed!.tokenDecimals[0], USDC_DECIMALS);
    // Amount UNCHANGED — heal mode doesn't add.
    assert.equal(
      healed!.amounts[0],
      priorAmount,
      "heal must NOT add amount (the original handler call already did)",
    );
    // USD repriced for the prior amount.
    assert.equal(
      healed!.feesUsdWei,
      computeFeeUsdWei({
        tokenSymbol: "USDC",
        tokenDecimals: USDC_DECIMALS,
        amount: priorAmount,
      }),
    );
    assert.equal(healed!.unresolvedCount, 0);
    assert.equal(healed!.allPegged, true);
    // transferCount UNCHANGED — heal doesn't double-count.
    assert.equal(
      healed!.transferCount,
      original!.transferCount,
      "heal must NOT bump transferCount",
    );
  });

  it("heal mode no-op returns null when snapshot doesn't exist", () => {
    const result = mergeFeeSnapshot(undefined, makeInput({}), "heal");
    assert.equal(result, null);
  });

  it("heal mode no-op returns existing unchanged when slot doesn't exist", () => {
    const original = mergeFeeSnapshot(undefined, makeInput({}));
    const result = mergeFeeSnapshot(
      original,
      makeInput({
        token: "0x00000000000000000000000000000000000000ff",
        tokenSymbol: "USDC",
      }),
      "heal",
    );
    assert.deepEqual(result, original);
  });

  it("self-heal preserves allPegged=false when other slots remain unresolved", () => {
    // Slot 0: UNKNOWN. Slot 1 (different token): also UNKNOWN.
    const first = mergeFeeSnapshot(
      undefined,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "UNKNOWN",
        tokenDecimals: USDC_DECIMALS,
      }),
    );
    const second = mergeFeeSnapshot(
      first,
      makeInput({
        token: UNKNOWN_TOKEN,
        tokenSymbol: "UNKNOWN",
        tokenDecimals: 18,
      }),
    );
    assert.equal(second!.unresolvedCount, 2);

    // Heal slot 0 (USDC). Slot 1 still UNKNOWN.
    const partiallyHealed = mergeFeeSnapshot(
      second,
      makeInput({
        token: USDC_ADDRESS,
        tokenSymbol: "USDC",
        tokenDecimals: USDC_DECIMALS,
      }),
    );
    assert.equal(partiallyHealed!.unresolvedCount, 1);
    assert.equal(
      partiallyHealed!.allPegged,
      false,
      "allPegged stays false while ANY slot is unresolved",
    );
  });

  // -------------------------------------------------------------------------
  // blockNumber = max
  // -------------------------------------------------------------------------
  it("blockNumber is always the maximum across merges", () => {
    const first = mergeFeeSnapshot(undefined, makeInput({ blockNumber: 100n }));
    const second = mergeFeeSnapshot(first, makeInput({ blockNumber: 50n }));
    assert.equal(
      second.blockNumber,
      100n,
      "keeps existing max when new is lower",
    );

    const third = mergeFeeSnapshot(second, makeInput({ blockNumber: 200n }));
    assert.equal(third.blockNumber, 200n, "updates when new is higher");
  });

  // -------------------------------------------------------------------------
  // feesUsdWei: non-pegged contributes 0
  // -------------------------------------------------------------------------
  it("feesUsdWei stays 0 for fully non-pegged days", () => {
    const first = mergeFeeSnapshot(
      undefined,
      makeInput({
        token: EURM_ADDRESS,
        tokenSymbol: "EURm",
        tokenDecimals: EURM_DECIMALS,
        amount: AMOUNT_1E18,
      }),
    );
    assert.equal(first.feesUsdWei, 0n);

    const second = mergeFeeSnapshot(
      first,
      makeInput({
        token: EURM_ADDRESS,
        tokenSymbol: "EURm",
        tokenDecimals: EURM_DECIMALS,
        amount: AMOUNT_1E18 * 5n,
      }),
    );
    assert.equal(second.feesUsdWei, 0n);
  });
});
