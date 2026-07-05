/**
 * Issue #1054 scenario 3 — batchReplay idempotency: replaying already-seen
 * `BatchUpdated`/bootstrap events must not double-count.
 *
 * `replayBatchedTroveUpdate` (src/handlers/liquity/batchReplay.ts) consumes
 * `PendingBatchedTroveUpdate` scratch rows and deletes each one after
 * replaying it — so a second delivery of the same `BatchUpdated` event finds
 * no matching pending rows and must not re-apply the debt/systemDebt delta.
 * `bootstrapCollaterals` (bootstrapHandler.ts's onBlock target) is a plain
 * get-or-create and is idempotent by construction.
 *
 * The last test in this file pins a REAL gap found while writing this
 * coverage: `recordBorrowingFeeAndApplyCum` (borrowingRevenue.ts), called
 * unconditionally from both the `TroveOperation` and `BatchUpdated` handlers,
 * has no replay guard — a redelivered event with a nonzero
 * `_debtIncreaseFromUpfrontFee` double-counts `LiquityInstance.borrowingFeeCum`
 * and the `LiquityBorrowingRevenueDailySnapshot.upfrontFee` bucket. Filed as
 * follow-up issue #1083; this test pins CURRENT behavior, it does not assert
 * desired behavior.
 */
import { strict as assert } from "assert";
import type {
  LiquityBorrowingRevenueDailySnapshot,
  LiquityCollateral,
  LiquityInstance,
  Trove,
} from "envio";
import { bootstrapCollaterals } from "../src/handlers/liquity/bootstrap";
import { makeLiquityCollateral } from "../src/handlers/liquity/bootstrap";
import { borrowingRevenueDailySnapshotId } from "../src/handlers/liquity/borrowingRevenue";
import {
  LIQUITY_MARKETS,
  makeCollateralId,
} from "../src/handlers/liquity/config";
import { OP } from "../src/handlers/liquity/operations";
import { pendingTroveKey } from "../src/handlers/liquity/keys";
import { makeTroveId } from "../src/handlers/liquity/troves";
import {
  indexerTestHelpers,
  processMockEvents,
  type EntityCollection,
  type EntityReader,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";

type PendingBatchedTroveUpdate = {
  id: string;
  troveId: string;
};

type ReplayMockDb = MockDbWith<{
  LiquityCollateral: WritableEntity<LiquityCollateral>;
  LiquityInstance: WritableEntity<LiquityInstance>;
  Trove: WritableEntity<Trove>;
  PendingBatchedTroveUpdate: EntityCollection<PendingBatchedTroveUpdate>;
  LiquityBorrowingRevenueDailySnapshot: EntityReader<LiquityBorrowingRevenueDailySnapshot>;
}>;

const TestHelpers = indexerTestHelpers<ReplayMockDb>();
const { MockDb, LiquityTroveManager } = TestHelpers;

const market = LIQUITY_MARKETS[0]!;
const collateralId = makeCollateralId(market);
const MIN_DEBT = 100n * 10n ** 18n;
const BATCH_MANAGER = "0x000000000000000000000000000000000000b0b0";
const TROVE_ID = 1n;
const TX_HASH = "0xbatchreplay";

function seedLoadedCollateral(mockDb: ReplayMockDb): void {
  mockDb.entities.LiquityCollateral.set({
    ...makeLiquityCollateral(market, 0n, 0n),
    systemParamsLoaded: true,
    minDebt: MIN_DEBT,
  });
}

function batchedTroveUpdatedEvent(logIndex: number) {
  return LiquityTroveManager.BatchedTroveUpdated.createMockEvent({
    _troveId: TROVE_ID,
    _interestBatchManager: BATCH_MANAGER,
    _batchDebtShares: 1_000n,
    _coll: 500n * 10n ** 18n,
    _stake: 500n * 10n ** 18n,
    _snapshotOfTotalCollRedist: 0n,
    _snapshotOfTotalDebtRedist: 0n,
    mockEventData: {
      chainId: market.chainId,
      srcAddress: market.troveManager,
      logIndex,
      block: { number: 500, timestamp: 5_000 },
      transaction: { hash: TX_HASH },
    },
  });
}

function batchUpdatedEvent(args: {
  logIndex: number;
  debtIncreaseFromUpfrontFee?: bigint;
}) {
  return LiquityTroveManager.BatchUpdated.createMockEvent({
    _interestBatchManager: BATCH_MANAGER,
    _operation: OP.SET_INTEREST_BATCH_MANAGER,
    _debt: 1_000n * 10n ** 18n,
    _coll: 500n * 10n ** 18n,
    _annualInterestRate: 5n * 10n ** 16n,
    _annualManagementFee: 0n,
    _totalDebtShares: 1_000n,
    _debtIncreaseFromUpfrontFee: args.debtIncreaseFromUpfrontFee ?? 0n,
    mockEventData: {
      chainId: market.chainId,
      srcAddress: market.troveManager,
      logIndex: args.logIndex,
      block: { number: 500, timestamp: 5_000 },
      transaction: { hash: TX_HASH },
    },
  });
}

describe("Liquity batchReplay idempotency", () => {
  it("replaying the same BatchUpdated event does not double-apply the debt/systemDebt delta", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);

    // First delivery: BatchedTroveUpdated (writes the pending scratch row)
    // then BatchUpdated (replays it, consuming + deleting the scratch row).
    mockDb = await processMockEvents({
      mockDb,
      events: [batchedTroveUpdatedEvent(1), batchUpdatedEvent({ logIndex: 2 })],
    });

    const troveEntityId = makeTroveId(collateralId, "0x1");
    const pendingId = pendingTroveKey(
      market.chainId,
      TX_HASH,
      collateralId,
      "0x1",
    );

    let trove = mockDb.entities.Trove.get(troveEntityId);
    let instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(
      trove?.debt,
      1_000n * 10n ** 18n,
      "batch share debt applied once",
    );
    assert.equal(trove?.status, "active");
    assert.equal(
      instance?.systemDebt,
      1_000n * 10n ** 18n,
      "systemDebt reflects the trove entering the batch exactly once",
    );
    assert.equal(
      mockDb.entities.PendingBatchedTroveUpdate.get(pendingId),
      undefined,
      "the scratch row is consumed after the first replay",
    );

    // Second delivery of the SAME BatchUpdated event (e.g. a reorg/backfill
    // redelivering an already-seen block). No matching PendingBatchedTroveUpdate
    // row exists anymore, so the replay loop must be a no-op this time.
    mockDb = await processMockEvents({
      mockDb,
      events: [batchUpdatedEvent({ logIndex: 2 })],
    });

    trove = mockDb.entities.Trove.get(troveEntityId);
    instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(
      trove?.debt,
      1_000n * 10n ** 18n,
      "trove debt is unchanged by the replayed event — not doubled",
    );
    assert.equal(
      instance?.systemDebt,
      1_000n * 10n ** 18n,
      "systemDebt is unchanged by the replayed event — not doubled",
    );
  });

  it("bootstrapCollaterals is idempotent: a second call does not create duplicate or drifted rows", async () => {
    const mockDb = MockDb.createMockDb();
    await bootstrapCollaterals(
      {
        LiquityCollateral: mockDb.entities.LiquityCollateral,
        LiquityInstance: mockDb.entities.LiquityInstance,
      },
      1_000n,
      10_000n,
    );
    const firstPassInstance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.ok(firstPassInstance, "instance bootstrapped on first call");
    const firstPassCollateral =
      mockDb.entities.LiquityCollateral.get(collateralId);
    assert.ok(firstPassCollateral, "collateral bootstrapped on first call");

    // Mutate the instance and collateral the way a later handler would, then
    // call bootstrapCollaterals again (simulating the onBlock heartbeat
    // firing a second time, e.g. a re-sync from an earlier checkpoint).
    // `bootstrapCollaterals` guards both rows with the same `existing ??`
    // pattern, so both must survive the second call untouched.
    mockDb.entities.LiquityInstance.set({
      ...firstPassInstance!,
      systemDebt: 42n,
    });
    mockDb.entities.LiquityCollateral.set({
      ...firstPassCollateral!,
      systemParamsLoaded: true,
      minDebt: MIN_DEBT,
    });
    await bootstrapCollaterals(
      {
        LiquityCollateral: mockDb.entities.LiquityCollateral,
        LiquityInstance: mockDb.entities.LiquityInstance,
      },
      2_000n,
      20_000n,
    );

    const secondPassInstance =
      mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(
      secondPassInstance?.systemDebt,
      42n,
      "existing instance is preserved verbatim — bootstrap never overwrites live state",
    );
    const secondPassCollateral =
      mockDb.entities.LiquityCollateral.get(collateralId);
    assert.equal(
      secondPassCollateral?.systemParamsLoaded,
      true,
      "existing collateral is preserved verbatim — bootstrap never overwrites live state",
    );
    assert.equal(secondPassCollateral?.minDebt, MIN_DEBT);
  });

  it("KNOWN GAP (#1083): replaying a BatchUpdated event with a nonzero upfront fee double-counts LiquityInstance.borrowingFeeCum AND LiquityBorrowingRevenueDailySnapshot.upfrontFee (pins current behavior)", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const fee = 10n * 10n ** 18n;
    const snapshotId = borrowingRevenueDailySnapshotId(collateralId, 0n);

    mockDb = await processMockEvents({
      mockDb,
      events: [
        batchedTroveUpdatedEvent(1),
        batchUpdatedEvent({ logIndex: 2, debtIncreaseFromUpfrontFee: fee }),
      ],
    });
    let instance = mockDb.entities.LiquityInstance.get(collateralId);
    assert.equal(
      instance?.borrowingFeeCum,
      fee,
      "fee recorded once on first delivery",
    );
    let snapshot =
      mockDb.entities.LiquityBorrowingRevenueDailySnapshot.get(snapshotId);
    assert.equal(
      snapshot?.upfrontFee,
      fee,
      "daily snapshot upfrontFee recorded once on first delivery",
    );

    // Replay the identical event a second time.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        batchUpdatedEvent({ logIndex: 2, debtIncreaseFromUpfrontFee: fee }),
      ],
    });
    instance = mockDb.entities.LiquityInstance.get(collateralId);
    snapshot =
      mockDb.entities.LiquityBorrowingRevenueDailySnapshot.get(snapshotId);
    // NOTE for whoever fixes #1083: once recordBorrowingFeeAndApplyCum is
    // made replay-safe, BOTH expectations below must flip to `fee` (not
    // `fee * 2n`) — recordBorrowingUpfrontFee (which writes the daily
    // snapshot) and the borrowingFeeCum increment share the same missing
    // replay guard. Leaving these assertions on the buggy value is
    // intentional — it pins CURRENT behavior per issue #1054's workflow
    // contract, not the desired behavior; it is deliberately not skipped so
    // it forces an explicit update the moment #1083 lands.
    assert.equal(
      instance?.borrowingFeeCum,
      fee * 2n,
      "KNOWN GAP: recordBorrowingFeeAndApplyCum has no replay guard, so the " +
        "fee is double-counted on redelivery — pinned here, not the desired behavior",
    );
    assert.equal(
      snapshot?.upfrontFee,
      fee * 2n,
      "KNOWN GAP: the daily snapshot's upfrontFee bucket is double-counted " +
        "in lockstep with borrowingFeeCum — pinned here, not the desired behavior",
    );
  });
});
