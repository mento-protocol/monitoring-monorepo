/**
 * Issue #1054 scenario 1 — Liquity trove lifecycle driven through the real
 * handlers (harness/processEvent), asserting Trove + LiquityInstance +
 * StabilityPool accumulators stay consistent at each step:
 *
 *   open -> adjust -> liquidate -> redistribution
 *
 * plus the Bold-fork rebalance-vs-user-redemption conflation (CLAUDE.md
 * "Rebalance redemptions are conflated with user redemptions today").
 *
 * Existing `test/liquity.test.ts` coverage for this handler subtree drives
 * mostly pure helper functions (transitionOpenedTrove, applySystemDebtDelta,
 * etc.) directly, not through the harness. Per repo convention ("MockDb-based
 * multi-entity assertions are unreliable for heal logic — assert entity state
 * after processEvent"), this file closes that gap by driving
 * LiquityTroveManager events end-to-end and asserting persisted entity state.
 */
import { strict as assert } from "assert";
import type {
  InterestRateBracket,
  LiquidationEvent,
  LiquityCollateral,
  LiquityInstance,
  PendingBatchMembershipOperation,
  RedemptionEvent,
  StabilityPoolLossAccumulator,
  StabilityPoolLossScale,
  Trove,
} from "envio";
import { makeLiquityCollateral } from "../src/handlers/liquity/bootstrap";
import {
  LIQUITY_MARKETS,
  makeCollateralId,
} from "../src/handlers/liquity/config";
import { pendingTroveKey } from "../src/handlers/liquity/keys";
import { OP } from "../src/handlers/liquity/operations";
import {
  makeInterestRateBracketId,
  makeTroveId,
} from "../src/handlers/liquity/troves";
import {
  indexerTestHelpers,
  processMockEvents,
  type EntityReader,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";

type LifecycleMockDb = MockDbWith<{
  InterestRateBracket: EntityReader<InterestRateBracket>;
  LiquityCollateral: WritableEntity<LiquityCollateral>;
  LiquityInstance: WritableEntity<LiquityInstance>;
  Trove: WritableEntity<Trove>;
  PendingBatchMembershipOperation: EntityReader<PendingBatchMembershipOperation>;
  LiquidationEvent: EntityReader<LiquidationEvent>;
  RedemptionEvent: EntityReader<RedemptionEvent>;
  StabilityPoolLossAccumulator: WritableEntity<StabilityPoolLossAccumulator>;
  StabilityPoolLossScale: EntityReader<StabilityPoolLossScale>;
}>;

const TestHelpers = indexerTestHelpers<LifecycleMockDb>();
const { MockDb, LiquityTroveManager, LiquityStabilityPool } = TestHelpers;

const market = LIQUITY_MARKETS[0]!;
const collateralId = makeCollateralId(market);
const MIN_DEBT = 100n * 10n ** 18n;

/** Seed a fully-loaded LiquityCollateral row so trove status classification
 * (statusFromCollateral) resolves to active/zombie/redeemed deterministically
 * instead of always falling back to "zombie" (systemParamsLoaded === false). */
function seedLoadedCollateral(mockDb: LifecycleMockDb): void {
  mockDb.entities.LiquityCollateral.set({
    ...makeLiquityCollateral(market, 0n, 0n),
    systemParamsLoaded: true,
    minDebt: MIN_DEBT,
  });
}

function troveOperationEvent(args: {
  troveId: bigint;
  operation: number;
  annualInterestRate?: bigint;
  debtIncreaseFromRedist?: bigint;
  debtIncreaseFromUpfrontFee?: bigint;
  debtChangeFromOperation?: bigint;
  collIncreaseFromRedist?: bigint;
  collChangeFromOperation?: bigint;
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  txHash: string;
  to?: string | null;
}) {
  return LiquityTroveManager.TroveOperation.createMockEvent({
    _troveId: args.troveId,
    _operation: args.operation,
    _annualInterestRate: args.annualInterestRate ?? 0n,
    _debtIncreaseFromRedist: args.debtIncreaseFromRedist ?? 0n,
    _debtIncreaseFromUpfrontFee: args.debtIncreaseFromUpfrontFee ?? 0n,
    _debtChangeFromOperation: args.debtChangeFromOperation ?? 0n,
    _collIncreaseFromRedist: args.collIncreaseFromRedist ?? 0n,
    _collChangeFromOperation: args.collChangeFromOperation ?? 0n,
    mockEventData: {
      chainId: market.chainId,
      srcAddress: market.troveManager,
      logIndex: args.logIndex,
      block: { number: args.blockNumber, timestamp: args.blockTimestamp },
      transaction: { hash: args.txHash, to: args.to ?? null },
    },
  });
}

function troveUpdatedEvent(args: {
  troveId: bigint;
  debt: bigint;
  coll: bigint;
  stake: bigint;
  annualInterestRate?: bigint;
  snapshotOfTotalCollRedist?: bigint;
  snapshotOfTotalDebtRedist?: bigint;
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  txHash: string;
}) {
  return LiquityTroveManager.TroveUpdated.createMockEvent({
    _troveId: args.troveId,
    _debt: args.debt,
    _coll: args.coll,
    _stake: args.stake,
    _annualInterestRate: args.annualInterestRate ?? 0n,
    _snapshotOfTotalCollRedist: args.snapshotOfTotalCollRedist ?? 0n,
    _snapshotOfTotalDebtRedist: args.snapshotOfTotalDebtRedist ?? 0n,
    mockEventData: {
      chainId: market.chainId,
      srcAddress: market.troveManager,
      logIndex: args.logIndex,
      block: { number: args.blockNumber, timestamp: args.blockTimestamp },
      transaction: { hash: args.txHash },
    },
  });
}

describe("Liquity trove lifecycle — harness-driven multi-entity consistency", () => {
  it("open -> adjust: Trove.debt and LiquityInstance.systemDebt track the delta exactly once", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 1n;
    const troveEntityId = makeTroveId(collateralId, "0x1");

    // OPEN: TroveUpdated(debt=1000, coll=500) + TroveOperation(OPEN_TROVE) in
    // one tx — the real on-chain emission order (`onOpenTrove` emits
    // TroveUpdated first).
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          troveId,
          debt: 1_000n * 10n ** 18n,
          coll: 500n * 10n ** 18n,
          stake: 500n * 10n ** 18n,
          blockNumber: 100,
          blockTimestamp: 1_000,
          logIndex: 1,
          txHash: "0xopen",
        }),
        troveOperationEvent({
          troveId,
          operation: OP.OPEN_TROVE,
          blockNumber: 100,
          blockTimestamp: 1_000,
          logIndex: 2,
          txHash: "0xopen",
        }),
      ],
    });

    let trove = mockDb.entities.Trove.get(troveEntityId);
    let instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(trove?.status, "active", "opened trove is active");
    assert.equal(trove?.debt, 1_000n * 10n ** 18n);
    assert.equal(instance?.systemDebt, 1_000n * 10n ** 18n);
    assert.equal(instance?.activeTroveCount, 1);
    assert.equal(instance?.troveOpenedCountBucket, 1);

    // ADJUST: borrow more — debt 1000 -> 1500, coll 500 -> 600, in the same
    // TroveUpdated-first order (`onAdjustTrove`).
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          troveId,
          debt: 1_500n * 10n ** 18n,
          coll: 600n * 10n ** 18n,
          stake: 600n * 10n ** 18n,
          blockNumber: 101,
          blockTimestamp: 1_100,
          logIndex: 1,
          txHash: "0xadjust",
        }),
        troveOperationEvent({
          troveId,
          operation: OP.ADJUST_TROVE,
          debtChangeFromOperation: 500n * 10n ** 18n,
          collChangeFromOperation: 100n * 10n ** 18n,
          blockNumber: 101,
          blockTimestamp: 1_100,
          logIndex: 2,
          txHash: "0xadjust",
        }),
      ],
    });

    trove = mockDb.entities.Trove.get(troveEntityId);
    instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(trove?.status, "active", "adjusted trove stays active");
    assert.equal(trove?.debt, 1_500n * 10n ** 18n);
    assert.equal(
      instance?.systemDebt,
      1_500n * 10n ** 18n,
      "systemDebt reflects the +500 delta exactly once, not the full new debt added on top",
    );
    // activeTroveCount must NOT double-increment on a same-status update.
    assert.equal(instance?.activeTroveCount, 1);
  });

  it("liquidate: trove closes, activeTroveCount/systemDebt decrement, and a survivor absorbs redistribution via ordinary TroveUpdated", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveAId = 10n;
    const troveBId = 11n;
    const troveAEntityId = makeTroveId(collateralId, "0xa");
    const troveBEntityId = makeTroveId(collateralId, "0xb");

    // Open trove A (to be liquidated) and trove B (the survivor).
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          troveId: troveAId,
          operation: OP.OPEN_TROVE,
          blockNumber: 200,
          blockTimestamp: 2_000,
          logIndex: 1,
          txHash: "0xopenA",
        }),
        troveUpdatedEvent({
          troveId: troveAId,
          debt: 1_500n * 10n ** 18n,
          coll: 600n * 10n ** 18n,
          stake: 600n * 10n ** 18n,
          blockNumber: 200,
          blockTimestamp: 2_000,
          logIndex: 2,
          txHash: "0xopenA",
        }),
        troveOperationEvent({
          troveId: troveBId,
          operation: OP.OPEN_TROVE,
          blockNumber: 201,
          blockTimestamp: 2_100,
          logIndex: 1,
          txHash: "0xopenB",
        }),
        troveUpdatedEvent({
          troveId: troveBId,
          debt: 800n * 10n ** 18n,
          coll: 400n * 10n ** 18n,
          stake: 400n * 10n ** 18n,
          blockNumber: 201,
          blockTimestamp: 2_100,
          logIndex: 2,
          txHash: "0xopenB",
        }),
      ],
    });

    let instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(instance?.systemDebt, 2_300n * 10n ** 18n, "both troves open");
    assert.equal(instance?.activeTroveCount, 2);

    // LIQUIDATE trove A: TroveOperation(LIQUIDATE) + the aggregate
    // Liquidation event (real contracts fire both).
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          troveId: troveAId,
          operation: OP.LIQUIDATE,
          collChangeFromOperation: -600n * 10n ** 18n,
          debtChangeFromOperation: -1_500n * 10n ** 18n,
          blockNumber: 202,
          blockTimestamp: 2_200,
          logIndex: 1,
          txHash: "0xliquidateA",
        }),
        LiquityTroveManager.Liquidation.createMockEvent({
          _debtOffsetBySP: 300n * 10n ** 18n,
          _debtRedistributed: 1_200n * 10n ** 18n,
          _boldGasCompensation: 0n,
          _collGasCompensation: 0n,
          _collSentToSP: 120n * 10n ** 18n,
          _collRedistributed: 480n * 10n ** 18n,
          _collSurplus: 0n,
          _L_ETH: 500n,
          _L_boldDebt: 700n,
          _price: 10n ** 18n,
          mockEventData: {
            chainId: market.chainId,
            srcAddress: market.troveManager,
            logIndex: 2,
            block: { number: 202, timestamp: 2_200 },
            transaction: { hash: "0xliquidateA" },
          },
        }),
      ],
    });

    const troveA = mockDb.entities.Trove.get(troveAEntityId);
    assert.ok(troveA, "liquidated trove exists");
    instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(troveA?.status, "liquidated");
    assert.equal(troveA?.liquidatedDebt, 1_500n * 10n ** 18n);
    assert.equal(troveA?.liquidatedColl, 600n * 10n ** 18n);
    assert.equal(
      instance?.systemDebt,
      800n * 10n ** 18n,
      "liquidated trove's debt is removed from systemDebt exactly once",
    );
    assert.equal(
      instance?.activeTroveCount,
      1,
      "activeTroveCount decrements for the liquidated trove only",
    );
    assert.equal(instance?.liqCountCum, 1);
    assert.equal(instance?.liqDebtOffsetCum, 300n * 10n ** 18n);
    assert.equal(instance?.liqDebtRedistributedCum, 1_200n * 10n ** 18n);
    assert.equal(instance?.liqCollSentToSpCum, 120n * 10n ** 18n);
    assert.equal(instance?.liqCollRedistributedCum, 480n * 10n ** 18n);
    assert.equal(instance?.latestTotalCollRedist, 500n);
    assert.equal(instance?.latestTotalDebtRedist, 700n);

    const liquidationEvent = mockDb.entities.LiquidationEvent.get(
      `${market.chainId}_202_2`,
    );
    assert.ok(liquidationEvent, "LiquidationEvent row is written");
    assert.equal(liquidationEvent?.debtOffsetBySP, 300n * 10n ** 18n);

    // REDISTRIBUTION: trove B is untouched by the liquidation itself — the
    // indexer never computes redistribution math, it just persists whatever
    // snapshot the next TroveUpdated for trove B carries. Simulate the
    // on-chain redistribution having bumped trove B's debt/coll and having
    // caught its snapshot up to the new L_ETH/L_boldDebt accumulator values
    // from the Liquidation event above.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          troveId: troveBId,
          operation: OP.APPLY_PENDING_DEBT,
          blockNumber: 203,
          blockTimestamp: 2_300,
          logIndex: 1,
          txHash: "0xredistB",
        }),
        troveUpdatedEvent({
          troveId: troveBId,
          debt: 900n * 10n ** 18n,
          coll: 450n * 10n ** 18n,
          stake: 400n * 10n ** 18n,
          snapshotOfTotalCollRedist: 500n,
          snapshotOfTotalDebtRedist: 700n,
          blockNumber: 203,
          blockTimestamp: 2_300,
          logIndex: 2,
          txHash: "0xredistB",
        }),
      ],
    });

    const troveB = mockDb.entities.Trove.get(troveBEntityId);
    instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(troveB?.status, "active", "survivor stays active");
    assert.equal(
      troveB?.debt,
      900n * 10n ** 18n,
      "survivor's debt reflects the redistribution bump",
    );
    assert.equal(troveB?.coll, 450n * 10n ** 18n);
    assert.equal(
      troveB?.snapshotOfTotalCollRedist,
      500n,
      "redistribution snapshot persisted verbatim from the event",
    );
    assert.equal(troveB?.snapshotOfTotalDebtRedist, 700n);
    assert.equal(
      instance?.systemDebt,
      900n * 10n ** 18n,
      "systemDebt absorbs the redistribution-driven delta exactly once, regardless of cause",
    );
    assert.equal(
      instance?.activeTroveCount,
      1,
      "activeTroveCount unaffected by a same-status debt update",
    );
  });

  it("stability pool absorbs part of a liquidation: LiquidationEvent + StabilityPoolLossAccumulator/Scale stay consistent", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    mockDb.entities.StabilityPoolLossAccumulator.set({
      id: collateralId,
      chainId: market.chainId,
      collateralId,
      currentP: 1_000n,
      currentScale: 0n,
      totalBoldDeposits: 10_000n,
    });
    const troveId = 20n;

    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          troveId,
          operation: OP.OPEN_TROVE,
          blockNumber: 300,
          blockTimestamp: 3_000,
          logIndex: 1,
          txHash: "0xopenC",
        }),
        troveUpdatedEvent({
          troveId,
          debt: 500n * 10n ** 18n,
          coll: 300n * 10n ** 18n,
          stake: 300n * 10n ** 18n,
          blockNumber: 300,
          blockTimestamp: 3_000,
          logIndex: 2,
          txHash: "0xopenC",
        }),
      ],
    });

    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          troveId,
          operation: OP.LIQUIDATE,
          collChangeFromOperation: -300n * 10n ** 18n,
          debtChangeFromOperation: -500n * 10n ** 18n,
          blockNumber: 301,
          blockTimestamp: 3_100,
          logIndex: 1,
          txHash: "0xliquidateC",
        }),
        LiquityTroveManager.Liquidation.createMockEvent({
          _debtOffsetBySP: 500n * 10n ** 18n,
          _debtRedistributed: 0n,
          _boldGasCompensation: 0n,
          _collGasCompensation: 0n,
          _collSentToSP: 300n * 10n ** 18n,
          _collRedistributed: 0n,
          _collSurplus: 0n,
          _L_ETH: 0n,
          _L_boldDebt: 0n,
          _price: 10n ** 18n,
          mockEventData: {
            chainId: market.chainId,
            srcAddress: market.troveManager,
            logIndex: 2,
            block: { number: 301, timestamp: 3_100 },
            transaction: { hash: "0xliquidateC" },
          },
        }),
        LiquityStabilityPool.S_Updated.createMockEvent({
          _S: 0n,
          mockEventData: {
            chainId: market.chainId,
            srcAddress: market.stabilityPool,
            logIndex: 3,
            block: { number: 301, timestamp: 3_100 },
            transaction: { hash: "0xliquidateC" },
          },
        }),
        LiquityStabilityPool.P_Updated.createMockEvent({
          _P: 900n,
          mockEventData: {
            chainId: market.chainId,
            srcAddress: market.stabilityPool,
            logIndex: 4,
            block: { number: 301, timestamp: 3_100 },
            transaction: { hash: "0xliquidateC" },
          },
        }),
        LiquityStabilityPool.StabilityPoolBoldBalanceUpdated.createMockEvent({
          _newBalance: 9_500n,
          mockEventData: {
            chainId: market.chainId,
            srcAddress: market.stabilityPool,
            logIndex: 5,
            block: { number: 301, timestamp: 3_100 },
            transaction: { hash: "0xliquidateC" },
          },
        }),
      ],
    });

    const instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(instance?.liqDebtOffsetCum, 500n * 10n ** 18n);
    assert.equal(instance?.liqCollSentToSpCum, 300n * 10n ** 18n);

    const accumulator =
      mockDb.entities.StabilityPoolLossAccumulator.get(collateralId);
    assert.equal(
      accumulator?.currentP,
      900n,
      "StabilityPoolLossAccumulator.currentP reflects the pool share dilution",
    );
    assert.equal(accumulator?.totalBoldDeposits, 9_500n);

    const scale = mockDb.entities.StabilityPoolLossScale.get(
      `${collateralId}-0`,
    );
    assert.equal(
      scale?.liquidationLossSum,
      100n,
      "liquidation loss is classified into the scale-0 bucket (1000-900=100)",
    );
    assert.equal(scale?.rebalanceLossSum, 0n);
  });

  it("redemption: rebalance-driven (CDPLiquidityStrategy tx.to) and user redemptions both count toward the total, only rebalance increments the rebalance-specific cumulative buckets", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);

    function redemptionEvent(args: {
      blockNumber: number;
      logIndex: number;
      txHash: string;
      to: string | null;
      actualBoldAmount: bigint;
      ethFee: bigint;
    }) {
      return LiquityTroveManager.Redemption.createMockEvent({
        _attemptedBoldAmount: args.actualBoldAmount,
        _actualBoldAmount: args.actualBoldAmount,
        _ETHSent: args.actualBoldAmount,
        _ETHFee: args.ethFee,
        _price: 10n ** 18n,
        _redemptionPrice: 10n ** 18n,
        mockEventData: {
          chainId: market.chainId,
          srcAddress: market.troveManager,
          logIndex: args.logIndex,
          block: { number: args.blockNumber, timestamp: args.blockNumber * 10 },
          transaction: { hash: args.txHash, to: args.to },
        },
      });
    }

    // Rebalance-driven redemption: tx.to === CDPLiquidityStrategy address.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        redemptionEvent({
          blockNumber: 400,
          logIndex: 1,
          txHash: "0xrebalanceRedeem",
          to: market.cdpLiquidityStrategy,
          actualBoldAmount: 100n * 10n ** 18n,
          ethFee: 1n * 10n ** 18n,
        }),
      ],
    });
    // User-driven redemption: tx.to is some other address, different block.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        redemptionEvent({
          blockNumber: 401,
          logIndex: 1,
          txHash: "0xuserRedeem",
          to: "0x00000000000000000000000000000000009999",
          actualBoldAmount: 40n * 10n ** 18n,
          ethFee: 2n * 10n ** 17n,
        }),
      ],
    });

    const rebalanceEvent = mockDb.entities.RedemptionEvent.get(
      `${market.chainId}_400_1`,
    );
    const userEvent = mockDb.entities.RedemptionEvent.get(
      `${market.chainId}_401_1`,
    );
    assert.equal(rebalanceEvent?.isRebalance, true);
    assert.equal(userEvent?.isRebalance, false);

    const instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(
      instance?.redemptionCountCum,
      2,
      "both redemptions count toward the total",
    );
    assert.equal(
      instance?.redemptionDebtCum,
      140n * 10n ** 18n,
      "total redemption debt sums both",
    );
    assert.equal(
      instance?.rebalanceRedemptionCountCum,
      1,
      "only the CDPLiquidityStrategy-tx redemption counts as rebalance-driven",
    );
    assert.equal(
      instance?.rebalanceRedemptionDebtCum,
      100n * 10n ** 18n,
      "rebalance subset excludes the user redemption's debt",
    );
  });
});

/**
 * Issue #2097 — `REMOVE_FROM_BATCH` driven in the real `onRemoveFromBatch`
 * emission order: `TroveUpdated` (full individual debt and rate), then
 * `TroveOperation(9)`, then the exit `BatchUpdated`, with no
 * `BatchedTroveUpdated`. `TroveUpdated` runs before `TroveOperation(9)` stages
 * the membership row, so the operation must own the batch exit.
 */
describe("Liquity batch exit — real emission order", () => {
  type Tx = { blockNumber: number; blockTimestamp: number; txHash: string };
  const D18 = 10n ** 18n;
  const troveId = 30n;
  const troveEntityId = makeTroveId(collateralId, "0x1e");
  const oldManager = "0x00000000000000000000000000000000000000b1";
  const newManager = "0x00000000000000000000000000000000000000b2";
  const individualRate = 5n * 10n ** 16n;
  const oldBatchRate = 6n * 10n ** 16n;
  const exitRate = 7n * 10n ** 16n;
  const newBatchRate = 8n * 10n ** 16n;
  const openTx: Tx = {
    blockNumber: 500,
    blockTimestamp: 5_000,
    txHash: "0xopenBatchExit",
  };
  const joinTx: Tx = {
    blockNumber: 501,
    blockTimestamp: 5_100,
    txHash: "0xjoinBatchExit",
  };
  const exitTx: Tx = {
    blockNumber: 502,
    blockTimestamp: 5_200,
    txHash: "0xexitBatch",
  };

  function eventData(tx: Tx, logIndex: number) {
    return {
      chainId: market.chainId,
      srcAddress: market.troveManager,
      logIndex,
      block: { number: tx.blockNumber, timestamp: tx.blockTimestamp },
      transaction: { hash: tx.txHash },
    };
  }

  function batchedTroveUpdatedEvent(
    tx: Tx,
    logIndex: number,
    batchManager: string,
  ) {
    return LiquityTroveManager.BatchedTroveUpdated.createMockEvent({
      _troveId: troveId,
      _interestBatchManager: batchManager,
      _batchDebtShares: 1_000n * D18,
      _coll: 500n * D18,
      _stake: 500n * D18,
      _snapshotOfTotalCollRedist: 0n,
      _snapshotOfTotalDebtRedist: 0n,
      mockEventData: eventData(tx, logIndex),
    });
  }

  /** One-trove batch: total debt shares track batch debt 1:1. */
  function batchUpdatedEvent(
    tx: Tx,
    logIndex: number,
    args: {
      batchManager: string;
      debt: bigint;
      coll: bigint;
      annualInterestRate: bigint;
    },
  ) {
    return LiquityTroveManager.BatchUpdated.createMockEvent({
      _interestBatchManager: args.batchManager,
      _operation: 0n,
      _debt: args.debt,
      _coll: args.coll,
      _annualInterestRate: args.annualInterestRate,
      _annualManagementFee: 0n,
      _totalDebtShares: args.debt,
      _debtIncreaseFromUpfrontFee: 0n,
      mockEventData: eventData(tx, logIndex),
    });
  }

  function removeFromBatchEvents(tx: Tx, args: { debt: bigint; rate: bigint }) {
    return [
      troveUpdatedEvent({
        ...tx,
        troveId,
        debt: args.debt,
        coll: 500n * D18,
        stake: 500n * D18,
        annualInterestRate: args.rate,
        logIndex: 1,
      }),
      troveOperationEvent({
        ...tx,
        troveId,
        operation: OP.REMOVE_FROM_BATCH,
        annualInterestRate: args.rate,
        logIndex: 2,
      }),
      batchUpdatedEvent(tx, 3, {
        batchManager: oldManager,
        debt: 0n,
        coll: 0n,
        annualInterestRate: oldBatchRate,
      }),
    ];
  }

  function bracketDebt(mockDb: LifecycleMockDb, rate: bigint): bigint {
    return (
      mockDb.entities.InterestRateBracket.get(
        makeInterestRateBracketId(collateralId, rate),
      )?.totalDebt ?? 0n
    );
  }

  async function openTrove(): Promise<LifecycleMockDb> {
    const mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    return processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          ...openTx,
          troveId,
          debt: 1_000n * D18,
          coll: 500n * D18,
          stake: 500n * D18,
          annualInterestRate: individualRate,
          logIndex: 1,
        }),
        troveOperationEvent({
          ...openTx,
          troveId,
          operation: OP.OPEN_TROVE,
          annualInterestRate: individualRate,
          logIndex: 2,
        }),
      ],
    });
  }

  /** Open an individual trove, then join `oldManager`'s batch in the real
   * `onSetInterestBatchManager` order: BatchedTroveUpdated →
   * TroveOperation(8) → BatchUpdated. */
  async function openAndJoinBatch(): Promise<LifecycleMockDb> {
    const mockDb = await processMockEvents({
      mockDb: await openTrove(),
      events: [
        batchedTroveUpdatedEvent(joinTx, 1, oldManager),
        troveOperationEvent({
          ...joinTx,
          troveId,
          operation: OP.SET_INTEREST_BATCH_MANAGER,
          annualInterestRate: oldBatchRate,
          logIndex: 2,
        }),
        batchUpdatedEvent(joinTx, 3, {
          batchManager: oldManager,
          debt: 1_000n * D18,
          coll: 500n * D18,
          annualInterestRate: oldBatchRate,
        }),
      ],
    });
    assert.equal(
      mockDb.entities.Trove.get(troveEntityId)?.interestBatchId,
      `${collateralId}-${oldManager}`,
      "precondition: the trove is batch-managed",
    );
    assert.equal(
      bracketDebt(mockDb, individualRate),
      0n,
      "precondition: joining moved the debt out of the individual bracket",
    );
    assert.equal(
      bracketDebt(mockDb, oldBatchRate),
      1_000n * D18,
      "precondition: the batch bracket holds the debt",
    );
    return mockDb;
  }

  it("TroveOperation(9) clears batch membership and moves the individual debt into its rate bracket", async () => {
    const mockDb = await processMockEvents({
      mockDb: await openAndJoinBatch(),
      events: removeFromBatchEvents(exitTx, {
        debt: 1_050n * D18,
        rate: exitRate,
      }),
    });

    const trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(
      trove?.interestBatchId,
      undefined,
      "the trove is individual after the whole tx, including the exit BatchUpdated",
    );
    assert.equal(trove?.batchDebtShares, 0n);
    assert.equal(trove?.interestRate, exitRate);
    assert.equal(trove?.debt, 1_050n * D18);
    assert.equal(
      bracketDebt(mockDb, exitRate),
      1_050n * D18,
      "the individual-rate bracket holds the trove's full debt",
    );
    assert.equal(
      bracketDebt(mockDb, oldBatchRate),
      0n,
      "the exit BatchUpdated removes the batch debt",
    );
    assert.equal(
      mockDb.entities.PendingBatchMembershipOperation.get(
        pendingTroveKey(market.chainId, exitTx.txHash, collateralId, "0x1e"),
      ),
      undefined,
      "the exit BatchUpdated consumes the membership row",
    );
    assert.equal(
      mockDb.entities.LiquityInstance.get(collateralId)?.systemDebt,
      1_050n * D18,
    );
  });

  it("a trove that left its batch is individual for later operations", async () => {
    let mockDb = await processMockEvents({
      mockDb: await openAndJoinBatch(),
      events: removeFromBatchEvents(exitTx, {
        debt: 1_050n * D18,
        rate: exitRate,
      }),
    });
    const adjustTx: Tx = {
      blockNumber: 503,
      blockTimestamp: 5_300,
      txHash: "0xadjustAfterExit",
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          ...adjustTx,
          troveId,
          debt: 1_200n * D18,
          coll: 500n * D18,
          stake: 500n * D18,
          annualInterestRate: exitRate,
          logIndex: 1,
        }),
        troveOperationEvent({
          ...adjustTx,
          troveId,
          operation: OP.ADJUST_TROVE,
          debtChangeFromOperation: 150n * D18,
          annualInterestRate: exitRate,
          logIndex: 2,
        }),
      ],
    });

    assert.equal(
      mockDb.entities.Trove.get(troveEntityId)?.interestBatchId,
      undefined,
    );
    assert.equal(
      bracketDebt(mockDb, exitRate),
      1_200n * D18,
      "the adjust replaces the trove's bracket debt exactly once",
    );
    assert.equal(
      mockDb.entities.LiquityInstance.get(collateralId)?.systemDebt,
      1_200n * D18,
    );
  });

  it("TroveOperation(9) on a trove already outside a batch does not count its debt twice", async () => {
    const mockDb = await processMockEvents({
      mockDb: await openTrove(),
      events: removeFromBatchEvents(exitTx, {
        debt: 1_050n * D18,
        rate: exitRate,
      }),
    });

    assert.equal(
      bracketDebt(mockDb, exitRate),
      1_050n * D18,
      "TroveUpdated already moved the individual debt; the exit adds nothing",
    );
    assert.equal(bracketDebt(mockDb, individualRate), 0n);
  });

  it("switchBatchManager ends in the new batch without double-counting the transient individual debt", async () => {
    // `BorrowerOperations.switchBatchManager` runs `removeFromBatch` at the
    // old batch's rate, then `setInterestBatchManager`, in one tx.
    const mockDb = await processMockEvents({
      mockDb: await openAndJoinBatch(),
      events: [
        ...removeFromBatchEvents(exitTx, {
          debt: 1_000n * D18,
          rate: oldBatchRate,
        }),
        batchedTroveUpdatedEvent(exitTx, 4, newManager),
        troveOperationEvent({
          ...exitTx,
          troveId,
          operation: OP.SET_INTEREST_BATCH_MANAGER,
          annualInterestRate: newBatchRate,
          logIndex: 5,
        }),
        batchUpdatedEvent(exitTx, 6, {
          batchManager: newManager,
          debt: 1_000n * D18,
          coll: 500n * D18,
          annualInterestRate: newBatchRate,
        }),
      ],
    });

    const trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(trove?.interestBatchId, `${collateralId}-${newManager}`);
    assert.equal(trove?.batchDebtShares, 1_000n * D18);
    assert.equal(
      bracketDebt(mockDb, oldBatchRate),
      0n,
      "the old rate bracket keeps neither the batch debt nor the transient individual debt",
    );
    assert.equal(bracketDebt(mockDb, newBatchRate), 1_000n * D18);
    assert.equal(
      mockDb.entities.LiquityInstance.get(collateralId)?.systemDebt,
      1_000n * D18,
    );
  });
});
