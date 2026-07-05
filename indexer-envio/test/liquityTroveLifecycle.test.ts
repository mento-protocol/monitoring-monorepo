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
  LiquidationEvent,
  LiquityCollateral,
  LiquityInstance,
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
import { OP } from "../src/handlers/liquity/operations";
import { makeTroveId } from "../src/handlers/liquity/troves";
import {
  indexerTestHelpers,
  processMockEvents,
  type EntityReader,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";

type LifecycleMockDb = MockDbWith<{
  LiquityCollateral: WritableEntity<LiquityCollateral>;
  LiquityInstance: WritableEntity<LiquityInstance>;
  Trove: WritableEntity<Trove>;
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

    // OPEN: TroveOperation(OPEN_TROVE) + TroveUpdated(debt=1000, coll=500) in
    // one tx — matches the real on-chain emission order.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          troveId,
          operation: OP.OPEN_TROVE,
          blockNumber: 100,
          blockTimestamp: 1_000,
          logIndex: 1,
          txHash: "0xopen",
        }),
        troveUpdatedEvent({
          troveId,
          debt: 1_000n * 10n ** 18n,
          coll: 500n * 10n ** 18n,
          stake: 500n * 10n ** 18n,
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

    // ADJUST: borrow more — debt 1000 -> 1500, coll 500 -> 600.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          troveId,
          operation: OP.ADJUST_TROVE,
          debtChangeFromOperation: 500n * 10n ** 18n,
          collChangeFromOperation: 100n * 10n ** 18n,
          blockNumber: 101,
          blockTimestamp: 1_100,
          logIndex: 1,
          txHash: "0xadjust",
        }),
        troveUpdatedEvent({
          troveId,
          debt: 1_500n * 10n ** 18n,
          coll: 600n * 10n ** 18n,
          stake: 600n * 10n ** 18n,
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
