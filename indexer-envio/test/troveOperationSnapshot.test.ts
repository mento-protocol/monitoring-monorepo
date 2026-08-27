/**
 * Issue #2080 regression — `TroveOperationEvent.debtBefore/debtAfter/
 * collBefore/collAfter` must derive from the `TroveOperation` event's own
 * delta fields, never from a second read of the `Trove` entity.
 *
 * Root cause (docs/PLAN-trove-history-page.md, "Snapshot before/after bug"):
 * on-chain, every TroveManager function emits `TroveUpdated` BEFORE
 * `TroveOperation` for the same op (lower logIndex, same tx). By the time
 * Envio's ordered event processing reaches the `TroveOperation` handler, the
 * `TroveUpdated` handler has already applied the post-operation debt/coll to
 * the `Trove` entity — so a naive "read the entity before this handler's own
 * mutations" capture (the old approach) actually reads post-op values as
 * "before". These tests drive the real on-chain order (TroveUpdated then
 * TroveOperation, same tx) through the real handlers via `processMockEvents`
 * and assert the persisted `TroveOperationEvent` row, per repo convention
 * ("MockDb-based multi-entity assertions are unreliable for heal logic —
 * assert entity state after processEvent").
 */
import { strict as assert } from "assert";
import type {
  LiquityCollateral,
  LiquityInstance,
  Trove,
  TroveOperationEvent,
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

type SnapshotMockDb = MockDbWith<{
  LiquityCollateral: WritableEntity<LiquityCollateral>;
  LiquityInstance: WritableEntity<LiquityInstance>;
  Trove: WritableEntity<Trove>;
  TroveOperationEvent: EntityReader<TroveOperationEvent>;
}>;

const TestHelpers = indexerTestHelpers<SnapshotMockDb>();
const { MockDb, LiquityTroveManager } = TestHelpers;

const market = LIQUITY_MARKETS[0]!;
const collateralId = makeCollateralId(market);
const MIN_DEBT = 100n * 10n ** 18n;

/** Seed a fully-loaded LiquityCollateral row so trove status classification
 * resolves deterministically (see liquityTroveLifecycle.test.ts for the same
 * pattern). Not asserted on here — only needed so processing doesn't fall
 * back to the systemParamsLoaded===false path. */
function seedLoadedCollateral(mockDb: SnapshotMockDb): void {
  mockDb.entities.LiquityCollateral.set({
    ...makeLiquityCollateral(market, 0n, 0n),
    systemParamsLoaded: true,
    minDebt: MIN_DEBT,
  });
}

function troveOperationEvent(args: {
  troveId: bigint;
  operation: number;
  debtChangeFromOperation?: bigint;
  debtIncreaseFromUpfrontFee?: bigint;
  debtIncreaseFromRedist?: bigint;
  collChangeFromOperation?: bigint;
  collIncreaseFromRedist?: bigint;
  annualInterestRate?: bigint;
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  txHash: string;
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
      transaction: { hash: args.txHash },
    },
  });
}

function troveUpdatedEvent(args: {
  troveId: bigint;
  debt: bigint;
  coll: bigint;
  stake: bigint;
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
    _annualInterestRate: 0n,
    _snapshotOfTotalCollRedist: 0n,
    _snapshotOfTotalDebtRedist: 0n,
    mockEventData: {
      chainId: market.chainId,
      srcAddress: market.troveManager,
      logIndex: args.logIndex,
      block: { number: args.blockNumber, timestamp: args.blockTimestamp },
      transaction: { hash: args.txHash },
    },
  });
}

describe("TroveOperationEvent before/after snapshot (issue #2080)", () => {
  it("open: debtBefore/collBefore read 0, not the post-open Trove values TroveUpdated already wrote", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 1n;
    const troveEntityId = makeTroveId(collateralId, "0x1");

    mockDb = await processMockEvents({
      mockDb,
      events: [
        // Real on-chain order: TroveUpdated (lower logIndex) before
        // TroveOperation, same tx.
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
          debtChangeFromOperation: 1_000n * 10n ** 18n,
          collChangeFromOperation: 500n * 10n ** 18n,
          blockNumber: 100,
          blockTimestamp: 1_000,
          logIndex: 2,
          txHash: "0xopen",
        }),
      ],
    });

    const trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(
      trove?.debt,
      1_000n * 10n ** 18n,
      "TroveUpdated already wrote the opened debt by the time TroveOperation runs",
    );

    const row = mockDb.entities.TroveOperationEvent.get(
      `${market.chainId}_100_2`,
    );
    assert.ok(row, "TroveOperationEvent row is written for OPEN_TROVE");
    assert.equal(
      row?.debtBefore,
      0n,
      "regression: open row's debtBefore is 0, not the post-open debt",
    );
    assert.equal(
      row?.collBefore,
      0n,
      "regression: open row's collBefore is 0, not the post-open coll",
    );
    assert.equal(row?.debtAfter, 1_000n * 10n ** 18n);
    assert.equal(row?.collAfter, 500n * 10n ** 18n);
  });

  it("adjust: debtBefore/collBefore read the pre-adjust state, debtAfter/collAfter read the new state", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 2n;
    const troveEntityId = makeTroveId(collateralId, "0x2");

    // Open at debt=1000, coll=500.
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
          debtChangeFromOperation: 1_000n * 10n ** 18n,
          collChangeFromOperation: 500n * 10n ** 18n,
          blockNumber: 100,
          blockTimestamp: 1_000,
          logIndex: 2,
          txHash: "0xopen",
        }),
      ],
    });

    // Adjust: borrow more — debt 1000 -> 1500, coll 500 -> 600.
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

    const trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(trove?.debt, 1_500n * 10n ** 18n);

    const row = mockDb.entities.TroveOperationEvent.get(
      `${market.chainId}_101_2`,
    );
    assert.ok(row, "TroveOperationEvent row is written for ADJUST_TROVE");
    assert.equal(
      row?.debtBefore,
      1_000n * 10n ** 18n,
      "adjust row's debtBefore is the pre-adjust debt",
    );
    assert.equal(row?.debtAfter, 1_500n * 10n ** 18n);
    assert.equal(
      row?.collBefore,
      500n * 10n ** 18n,
      "adjust row's collBefore is the pre-adjust coll",
    );
    assert.equal(row?.collAfter, 600n * 10n ** 18n);
  });

  it("close: debtBefore/collBefore read the pre-close state, debtAfter/collAfter land at 0", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 3n;
    const troveEntityId = makeTroveId(collateralId, "0x3");

    // Open at debt=1000, coll=500.
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
          debtChangeFromOperation: 1_000n * 10n ** 18n,
          collChangeFromOperation: 500n * 10n ** 18n,
          blockNumber: 100,
          blockTimestamp: 1_000,
          logIndex: 2,
          txHash: "0xopen",
        }),
      ],
    });

    // Close: full repayment — debt 1000 -> 0, coll 500 -> 0.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          troveId,
          debt: 0n,
          coll: 0n,
          stake: 0n,
          blockNumber: 102,
          blockTimestamp: 1_200,
          logIndex: 1,
          txHash: "0xclose",
        }),
        troveOperationEvent({
          troveId,
          operation: OP.CLOSE_TROVE,
          debtChangeFromOperation: -1_000n * 10n ** 18n,
          collChangeFromOperation: -500n * 10n ** 18n,
          blockNumber: 102,
          blockTimestamp: 1_200,
          logIndex: 2,
          txHash: "0xclose",
        }),
      ],
    });

    const trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(trove?.status, "closed");
    assert.equal(trove?.debt, 0n);

    const row = mockDb.entities.TroveOperationEvent.get(
      `${market.chainId}_102_2`,
    );
    assert.ok(row, "TroveOperationEvent row is written for CLOSE_TROVE");
    assert.equal(
      row?.debtBefore,
      1_000n * 10n ** 18n,
      "close row's debtBefore is the pre-close debt",
    );
    assert.equal(row?.debtAfter, 0n);
    assert.equal(
      row?.collBefore,
      500n * 10n ** 18n,
      "close row's collBefore is the pre-close coll",
    );
    assert.equal(row?.collAfter, 0n);
  });

  it("open-and-join-batch (issue found in review of #2095): debtBefore/debtAfter are null — BatchedTroveUpdated stages only debt SHARES, not the real per-trove debt — and collAfter reads the staged coll, not the not-yet-mutated Trove entity", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 9n;
    const txHash = "0xopenjoinbatch";

    mockDb = await processMockEvents({
      mockDb,
      events: [
        // Real on-chain order for a batch-managed op: `BatchedTroveUpdated`
        // (never `TroveUpdated`) fires before `TroveOperation`, same tx.
        // It stages the real resulting coll (500) but only debt SHARES
        // (1_000n) — the per-trove debt figure needs the batch's total debt
        // and total shares, only known once `BatchUpdated` replays.
        LiquityTroveManager.BatchedTroveUpdated.createMockEvent({
          _troveId: troveId,
          _interestBatchManager: "0x000000000000000000000000000000000000b0b0",
          _batchDebtShares: 1_000n,
          _coll: 500n * 10n ** 18n,
          _stake: 500n * 10n ** 18n,
          _snapshotOfTotalCollRedist: 0n,
          _snapshotOfTotalDebtRedist: 0n,
          mockEventData: {
            chainId: market.chainId,
            srcAddress: market.troveManager,
            logIndex: 1,
            block: { number: 200, timestamp: 2_000 },
            transaction: { hash: txHash },
          },
        }),
        troveOperationEvent({
          troveId,
          operation: OP.OPEN_TROVE_AND_JOIN_BATCH,
          debtChangeFromOperation: 1_000n * 10n ** 18n,
          collChangeFromOperation: 500n * 10n ** 18n,
          blockNumber: 200,
          blockTimestamp: 2_000,
          logIndex: 2,
          txHash,
        }),
      ],
    });

    const row = mockDb.entities.TroveOperationEvent.get(
      `${market.chainId}_200_2`,
    );
    assert.ok(
      row,
      "TroveOperationEvent row is written for OPEN_TROVE_AND_JOIN_BATCH",
    );
    assert.equal(
      row?.debtBefore,
      undefined,
      "regression: debtBefore is null, not a number derived from the stale pre-tx Trove.debt",
    );
    assert.equal(
      row?.debtAfter,
      undefined,
      "regression: debtAfter is null — BatchedTroveUpdated never wrote the real per-trove debt to the Trove entity",
    );
    assert.equal(
      row?.collAfter,
      500n * 10n ** 18n,
      "collAfter reads BatchedTroveUpdated's staged (absolute) coll, not the not-yet-mutated Trove entity",
    );
    assert.equal(
      row?.collBefore,
      0n,
      "collBefore derives arithmetically from the corrected collAfter",
    );
  });
});
