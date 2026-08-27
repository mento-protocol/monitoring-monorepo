/**
 * Issue #2082 — `TroveLedgerEvent` append-only per-trove ledger, driven
 * through the real handlers (harness/processEvent) in on-chain emission
 * order (`TroveUpdated` / `BatchedTroveUpdated` before `TroveOperation`;
 * branch aggregates last). Covers the acceptance matrix:
 *
 *   open/adjust/close · interest fold (op 4) · single redemption ·
 *   split redemption · liquidation · batch rows with null debt snapshots ·
 *   zombie transition + revival · statusBefore capture · watermark ·
 *   replay-null vs live block-close price · event price wins for ICR
 *
 * Snapshot semantics under test are post-accrual, pre-operation: `before`
 * is derived from the same-tx resulting state minus event-carried deltas,
 * so accrued interest folds into `debtBefore` (asserted with both zero and
 * non-zero elapsed interest).
 */
import { strict as assert } from "assert";
import type {
  LiquityCollateral,
  LiquityInstance,
  PendingTroveLedgerEvent,
  Trove,
  TroveLedgerEvent,
  TroveOperationEvent,
} from "envio";
import { makeLiquityCollateral } from "../src/handlers/liquity/bootstrap";
import {
  LIQUITY_MARKETS,
  makeCollateralId,
} from "../src/handlers/liquity/config";
import { pendingTroveKey } from "../src/handlers/liquity/keys";
import { OP } from "../src/handlers/liquity/operations";
import { TROVE_LEDGER_PRICE_CUTOFF_TIMESTAMP } from "../src/handlers/liquity/troveLedger";
import { makeTroveId } from "../src/handlers/liquity/troves";
import {
  clearHttpRpcMockGroup,
  setHttpRpcMock,
} from "../src/rpc/http-test-mocks.js";
import {
  indexerTestHelpers,
  processMockEvents,
  type EntityCollection,
  type EntityReader,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";

type LedgerMockDb = MockDbWith<{
  LiquityCollateral: WritableEntity<LiquityCollateral>;
  LiquityInstance: WritableEntity<LiquityInstance>;
  Trove: WritableEntity<Trove>;
  TroveLedgerEvent: EntityCollection<TroveLedgerEvent>;
  TroveOperationEvent: EntityReader<TroveOperationEvent>;
  PendingTroveLedgerEvent: EntityReader<PendingTroveLedgerEvent>;
}>;

const TestHelpers = indexerTestHelpers<LedgerMockDb>();
const { MockDb, LiquityTroveManager } = TestHelpers;

const market = LIQUITY_MARKETS[0]!;
const collateralId = makeCollateralId(market);
const D18 = 10n ** 18n;
const MIN_DEBT = 100n * D18;
const PRICE_MOCK_GROUP = "liquityLedgerPrice";

function seedLoadedCollateral(mockDb: LedgerMockDb): void {
  mockDb.entities.LiquityCollateral.set({
    ...makeLiquityCollateral(market, 0n, 0n),
    systemParamsLoaded: true,
    minDebt: MIN_DEBT,
  });
}

type TxMeta = {
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  txHash: string;
  to?: string | null;
};

function mockEventData(args: TxMeta) {
  return {
    chainId: market.chainId,
    srcAddress: market.troveManager,
    logIndex: args.logIndex,
    block: { number: args.blockNumber, timestamp: args.blockTimestamp },
    transaction: { hash: args.txHash, to: args.to ?? null },
  };
}

function troveOperationEvent(
  args: TxMeta & {
    troveId: bigint;
    operation: number;
    annualInterestRate?: bigint;
    debtIncreaseFromRedist?: bigint;
    debtIncreaseFromUpfrontFee?: bigint;
    debtChangeFromOperation?: bigint;
    collIncreaseFromRedist?: bigint;
    collChangeFromOperation?: bigint;
  },
) {
  return LiquityTroveManager.TroveOperation.createMockEvent({
    _troveId: args.troveId,
    _operation: args.operation,
    _annualInterestRate: args.annualInterestRate ?? 0n,
    _debtIncreaseFromRedist: args.debtIncreaseFromRedist ?? 0n,
    _debtIncreaseFromUpfrontFee: args.debtIncreaseFromUpfrontFee ?? 0n,
    _debtChangeFromOperation: args.debtChangeFromOperation ?? 0n,
    _collIncreaseFromRedist: args.collIncreaseFromRedist ?? 0n,
    _collChangeFromOperation: args.collChangeFromOperation ?? 0n,
    mockEventData: mockEventData(args),
  });
}

function troveUpdatedEvent(
  args: TxMeta & {
    troveId: bigint;
    debt: bigint;
    coll: bigint;
    stake?: bigint;
    annualInterestRate?: bigint;
  },
) {
  return LiquityTroveManager.TroveUpdated.createMockEvent({
    _troveId: args.troveId,
    _debt: args.debt,
    _coll: args.coll,
    _stake: args.stake ?? args.coll,
    _annualInterestRate: args.annualInterestRate ?? 0n,
    _snapshotOfTotalCollRedist: 0n,
    _snapshotOfTotalDebtRedist: 0n,
    mockEventData: mockEventData(args),
  });
}

function redemptionFeeEvent(args: TxMeta & { troveId: bigint; fee: bigint }) {
  return LiquityTroveManager.RedemptionFeePaidToTrove.createMockEvent({
    _troveId: args.troveId,
    _ETHFee: args.fee,
    mockEventData: mockEventData(args),
  });
}

function redemptionEvent(
  args: TxMeta & {
    actualBoldAmount: bigint;
    ethFee: bigint;
    redemptionPrice: bigint;
  },
) {
  return LiquityTroveManager.Redemption.createMockEvent({
    _attemptedBoldAmount: args.actualBoldAmount,
    _actualBoldAmount: args.actualBoldAmount,
    _ETHSent: args.actualBoldAmount,
    _ETHFee: args.ethFee,
    _price: args.redemptionPrice,
    _redemptionPrice: args.redemptionPrice,
    mockEventData: mockEventData(args),
  });
}

function ledgerRow(
  mockDb: LedgerMockDb,
  blockNumber: number,
  logIndex: number,
): TroveLedgerEvent | undefined {
  return mockDb.entities.TroveLedgerEvent.get(
    `${market.chainId}_${blockNumber}_${logIndex}`,
  );
}

async function openTrove(
  mockDb: LedgerMockDb,
  args: {
    troveId: bigint;
    debt: bigint;
    coll: bigint;
    upfrontFee?: bigint;
    annualInterestRate?: bigint;
    blockNumber: number;
    blockTimestamp: number;
    txHash: string;
  },
): Promise<LedgerMockDb> {
  const upfrontFee = args.upfrontFee ?? 0n;
  return processMockEvents({
    mockDb,
    events: [
      troveUpdatedEvent({
        troveId: args.troveId,
        debt: args.debt,
        coll: args.coll,
        annualInterestRate: args.annualInterestRate,
        blockNumber: args.blockNumber,
        blockTimestamp: args.blockTimestamp,
        logIndex: 1,
        txHash: args.txHash,
      }),
      troveOperationEvent({
        troveId: args.troveId,
        operation: OP.OPEN_TROVE,
        debtChangeFromOperation: args.debt - upfrontFee,
        debtIncreaseFromUpfrontFee: upfrontFee,
        collChangeFromOperation: args.coll,
        annualInterestRate: args.annualInterestRate,
        blockNumber: args.blockNumber,
        blockTimestamp: args.blockTimestamp,
        logIndex: 2,
        txHash: args.txHash,
      }),
    ],
  });
}

describe("TroveLedgerEvent — append-only per-trove ledger", () => {
  afterEach(() => {
    clearHttpRpcMockGroup(PRICE_MOCK_GROUP);
  });

  it("open/adjust/close write direct rows with post-accrual pre-operation snapshots and maintain the watermark", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 1n;
    const troveEntityId = makeTroveId(collateralId, "0x1");

    // OPEN: zero elapsed interest — before snapshots must read exactly 0.
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_012n * D18,
      coll: 500n * D18,
      upfrontFee: 12n * D18,
      blockNumber: 100,
      blockTimestamp: 1_000,
      txHash: "0xopen",
    });
    const openRow = ledgerRow(mockDb, 100, 2);
    assert.ok(openRow, "open writes a ledger row");
    assert.equal(openRow.operation, OP.OPEN_TROVE);
    assert.equal(openRow.debtBefore, 0n, "open row reads before = 0");
    assert.equal(openRow.debtAfter, 1_012n * D18);
    assert.equal(openRow.collBefore, 0n);
    assert.equal(openRow.collAfter, 500n * D18);
    assert.equal(openRow.debtIncreaseFromUpfrontFee, 12n * D18);
    assert.equal(
      openRow.statusBefore,
      "closed",
      "pre-open placeholder status is captured",
    );
    assert.equal(openRow.statusAfter, "active");
    assert.equal(openRow.troveEntityId, troveEntityId);
    assert.equal(openRow.instanceId, collateralId);
    assert.equal(openRow.txHash, "0xopen");
    assert.equal(openRow.logIndex, 2);
    assert.equal(
      openRow.priceAtEvent,
      undefined,
      "replay rows keep priceAtEvent null",
    );
    assert.equal(openRow.icrAfterBps, undefined);
    let trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(trove?.lastLedgerBlock, 100n, "watermark block after open");
    assert.equal(trove?.lastLedgerLogIndex, 2, "watermark logIndex after open");

    // ADJUST days later with 10 accrued interest: resulting debt
    // 1012 + 10 (accrual) + 500 (borrow) = 1522. debtBefore must be the
    // POST-accrual 1022, not the recorded 1012.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          troveId,
          debt: 1_522n * D18,
          coll: 600n * D18,
          blockNumber: 200,
          blockTimestamp: 90_000,
          logIndex: 1,
          txHash: "0xadjust",
        }),
        troveOperationEvent({
          troveId,
          operation: OP.ADJUST_TROVE,
          debtChangeFromOperation: 500n * D18,
          collChangeFromOperation: 100n * D18,
          blockNumber: 200,
          blockTimestamp: 90_000,
          logIndex: 2,
          txHash: "0xadjust",
        }),
      ],
    });
    const adjustRow = ledgerRow(mockDb, 200, 2);
    assert.ok(adjustRow, "adjust writes a ledger row");
    assert.equal(
      adjustRow.debtBefore,
      1_022n * D18,
      "debtBefore folds accrued interest in (post-accrual, pre-operation)",
    );
    assert.equal(adjustRow.debtAfter, 1_522n * D18);
    assert.equal(adjustRow.collBefore, 500n * D18);
    assert.equal(adjustRow.collAfter, 600n * D18);
    assert.equal(adjustRow.statusBefore, "active");
    assert.equal(adjustRow.statusAfter, "active");

    // CLOSE: zeroed TroveUpdated; before recovers the full entire debt.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          troveId,
          debt: 0n,
          coll: 0n,
          blockNumber: 300,
          blockTimestamp: 100_000,
          logIndex: 1,
          txHash: "0xclose",
        }),
        troveOperationEvent({
          troveId,
          operation: OP.CLOSE_TROVE,
          debtChangeFromOperation: -(1_522n * D18),
          collChangeFromOperation: -(600n * D18),
          blockNumber: 300,
          blockTimestamp: 100_000,
          logIndex: 2,
          txHash: "0xclose",
        }),
      ],
    });
    const closeRow = ledgerRow(mockDb, 300, 2);
    assert.ok(closeRow, "close writes a ledger row");
    assert.equal(closeRow.debtBefore, 1_522n * D18);
    assert.equal(closeRow.debtAfter, 0n);
    assert.equal(closeRow.collBefore, 600n * D18);
    assert.equal(closeRow.collAfter, 0n);
    assert.equal(closeRow.statusBefore, "active");
    assert.equal(closeRow.statusAfter, "closed");
    trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(trove?.lastLedgerBlock, 300n, "watermark advances on close");
    assert.equal(trove?.lastLedgerLogIndex, 2);
  });

  it("interest fold (op 4) writes a row the user-ops feed skips; before equals after (pure accrual)", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 4n;
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_000n * D18,
      coll: 500n * D18,
      blockNumber: 400,
      blockTimestamp: 200_000,
      txHash: "0xopen4",
    });

    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          troveId,
          debt: 1_005n * D18,
          coll: 500n * D18,
          blockNumber: 401,
          blockTimestamp: 300_000,
          logIndex: 1,
          txHash: "0xfold",
        }),
        troveOperationEvent({
          troveId,
          operation: OP.APPLY_PENDING_DEBT,
          blockNumber: 401,
          blockTimestamp: 300_000,
          logIndex: 2,
          txHash: "0xfold",
        }),
      ],
    });

    const foldRow = ledgerRow(mockDb, 401, 2);
    assert.ok(foldRow, "op-4 interest fold writes a ledger row");
    assert.equal(foldRow.operation, OP.APPLY_PENDING_DEBT);
    assert.equal(foldRow.debtChange, 0n);
    assert.equal(
      foldRow.debtBefore,
      1_005n * D18,
      "post-accrual before equals after on a pure fold — the residual lands between rows",
    );
    assert.equal(foldRow.debtAfter, 1_005n * D18);
    assert.equal(
      mockDb.entities.TroveOperationEvent.get(`${market.chainId}_401_2`),
      undefined,
      "the user-ops TroveOperationEvent feed still skips op 4 (unchanged)",
    );
    const trove = mockDb.entities.Trove.get(makeTroveId(collateralId, "0x4"));
    assert.equal(trove?.lastLedgerBlock, 401n, "watermark advances on op 4");
    assert.equal(trove?.lastLedgerLogIndex, 2);
  });

  it("single rebalance redemption stages, then finalizes once with fee, isRebalance, and redemptionPrice; event price wins for ICR", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 6n;
    const troveEntityId = makeTroveId(collateralId, "0x6");
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_000n * D18,
      coll: 500n * D18,
      blockNumber: 500,
      blockTimestamp: 390_000,
      txHash: "0xopen6",
    });

    const tx = {
      blockNumber: 501,
      blockTimestamp: 400_000,
      txHash: "0xredeem",
      to: market.cdpLiquidityStrategy,
    };
    // Per-trove loop first: TroveUpdated, TroveOperation(6), fee.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          ...tx,
          troveId,
          debt: 600n * D18,
          coll: 300n * D18,
          logIndex: 1,
        }),
        troveOperationEvent({
          ...tx,
          troveId,
          operation: OP.REDEEM_COLLATERAL,
          debtChangeFromOperation: -(400n * D18),
          collChangeFromOperation: -(200n * D18),
          logIndex: 2,
        }),
        redemptionFeeEvent({ ...tx, troveId, fee: 2n * D18, logIndex: 3 }),
      ],
    });
    assert.equal(
      ledgerRow(mockDb, 501, 2),
      undefined,
      "op-6 row is staged, not written, before the branch Redemption event",
    );
    const staged = mockDb.entities.PendingTroveLedgerEvent.get(
      pendingTroveKey(market.chainId, "0xredeem", collateralId, "0x6"),
    );
    assert.equal(staged?.kind, "redemption");
    assert.equal(
      staged?.redemptionFeeCredited,
      2n * D18,
      "fee handler folds RedemptionFeePaidToTrove into the staged row",
    );
    let trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(
      trove?.lastLedgerBlock,
      500n,
      "watermark lags until the staged row finalizes",
    );

    // Branch aggregate finalizes the row — the only _redemptionPrice source.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        redemptionEvent({
          ...tx,
          actualBoldAmount: 400n * D18,
          ethFee: 2n * D18,
          redemptionPrice: 15n * 10n ** 17n,
          logIndex: 4,
        }),
      ],
    });
    const row = ledgerRow(mockDb, 501, 2);
    assert.ok(row, "Redemption handler writes the final op-6 row");
    assert.equal(row.operation, OP.REDEEM_COLLATERAL);
    assert.equal(row.debtBefore, 1_000n * D18);
    assert.equal(row.debtAfter, 600n * D18);
    assert.equal(row.collBefore, 500n * D18);
    assert.equal(row.collAfter, 300n * D18);
    assert.equal(row.redemptionFeeCredited, 2n * D18);
    assert.equal(row.isRebalance, true, "tx-target discriminator");
    assert.equal(row.redemptionPrice, 15n * 10n ** 17n);
    assert.equal(
      row.priceAtEvent,
      undefined,
      "replay rows persist no block-close price",
    );
    assert.equal(
      row.icrAfterBps,
      7_500,
      "ICR uses the event-carried redemption price (300 × 1.5 / 600)",
    );
    assert.equal(row.statusBefore, "active");
    assert.equal(row.statusAfter, "active");
    trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(trove?.lastLedgerBlock, 501n, "watermark stamps at finalize");
    assert.equal(trove?.lastLedgerLogIndex, 2);
    assert.equal(
      mockDb.entities.PendingTroveLedgerEvent.get(
        pendingTroveKey(market.chainId, "0xredeem", collateralId, "0x6"),
      ),
      undefined,
      "staged row is consumed exactly once",
    );
  });

  it("one instance redemption split across two troves yields two rows whose debt sum matches the branch event", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveAId = 0xan;
    const troveBId = 0xbn;
    mockDb = await openTrove(mockDb, {
      troveId: troveAId,
      debt: 300n * D18,
      coll: 400n * D18,
      blockNumber: 600,
      blockTimestamp: 490_000,
      txHash: "0xopenA",
    });
    mockDb = await openTrove(mockDb, {
      troveId: troveBId,
      debt: 1_000n * D18,
      coll: 500n * D18,
      blockNumber: 6_001,
      blockTimestamp: 495_000,
      txHash: "0xopenB",
    });

    const tx = {
      blockNumber: 6_002,
      blockTimestamp: 500_000,
      txHash: "0xsplit",
      to: "0x0000000000000000000000000000000000009999",
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        // Trove A: fully redeemed to zero (leftover coll + 1 fee stays).
        troveUpdatedEvent({
          ...tx,
          troveId: troveAId,
          debt: 0n,
          coll: 101n * D18,
          logIndex: 1,
        }),
        troveOperationEvent({
          ...tx,
          troveId: troveAId,
          operation: OP.REDEEM_COLLATERAL,
          debtChangeFromOperation: -(300n * D18),
          collChangeFromOperation: -(299n * D18),
          logIndex: 2,
        }),
        redemptionFeeEvent({ ...tx, troveId: troveAId, fee: D18, logIndex: 3 }),
        // Trove B: partial hit.
        troveUpdatedEvent({
          ...tx,
          troveId: troveBId,
          debt: 800n * D18,
          coll: 3_005n * 10n ** 17n,
          logIndex: 4,
        }),
        troveOperationEvent({
          ...tx,
          troveId: troveBId,
          operation: OP.REDEEM_COLLATERAL,
          debtChangeFromOperation: -(200n * D18),
          collChangeFromOperation: -(1_995n * 10n ** 17n),
          logIndex: 5,
        }),
        redemptionFeeEvent({
          ...tx,
          troveId: troveBId,
          fee: 5n * 10n ** 17n,
          logIndex: 6,
        }),
        redemptionEvent({
          ...tx,
          actualBoldAmount: 500n * D18,
          ethFee: 15n * 10n ** 17n,
          redemptionPrice: D18,
          logIndex: 7,
        }),
      ],
    });

    const rowA = ledgerRow(mockDb, 6_002, 2);
    const rowB = ledgerRow(mockDb, 6_002, 5);
    assert.ok(rowA, "trove A gets its own ledger row");
    assert.ok(rowB, "trove B gets its own ledger row");
    assert.equal(
      -(rowA.debtChange + rowB.debtChange),
      500n * D18,
      "per-trove rows sum to the branch Redemption's actual amount",
    );
    assert.equal(rowA.redemptionFeeCredited, D18);
    assert.equal(rowB.redemptionFeeCredited, 5n * 10n ** 17n);
    assert.equal(rowA.isRebalance, false, "user redemption");
    assert.equal(rowB.isRebalance, false);
    assert.equal(rowA.redemptionPrice, D18);
    assert.equal(rowB.redemptionPrice, D18);
    assert.equal(
      rowA.statusAfter,
      "redeemed",
      "fully-redeemed-to-zero uses the indexer vocabulary",
    );
    assert.equal(rowB.statusAfter, "active");
    assert.equal(
      rowA.icrAfterBps,
      undefined,
      "zero-debt after state has no ICR",
    );
    const troveA = mockDb.entities.Trove.get(makeTroveId(collateralId, "0xa"));
    const troveB = mockDb.entities.Trove.get(makeTroveId(collateralId, "0xb"));
    assert.equal(troveA?.lastLedgerBlock, 6_002n);
    assert.equal(troveA?.lastLedgerLogIndex, 2);
    assert.equal(troveB?.lastLedgerBlock, 6_002n);
    assert.equal(troveB?.lastLedgerLogIndex, 5);
  });

  it("liquidation rows finalize only after the same-transaction aggregate Liquidation event", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 5n;
    const troveEntityId = makeTroveId(collateralId, "0x5");
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_500n * D18,
      coll: 600n * D18,
      blockNumber: 700,
      blockTimestamp: 590_000,
      txHash: "0xopen5",
    });

    const tx = { blockNumber: 701, blockTimestamp: 600_000, txHash: "0xliq" };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({ ...tx, troveId, debt: 0n, coll: 0n, logIndex: 1 }),
        troveOperationEvent({
          ...tx,
          troveId,
          operation: OP.LIQUIDATE,
          debtChangeFromOperation: -(1_500n * D18),
          collChangeFromOperation: -(600n * D18),
          logIndex: 2,
        }),
      ],
    });
    assert.equal(
      ledgerRow(mockDb, 701, 2),
      undefined,
      "op-5 row is staged until the aggregate Liquidation event",
    );

    mockDb = await processMockEvents({
      mockDb,
      events: [
        LiquityTroveManager.Liquidation.createMockEvent({
          _debtOffsetBySP: 300n * D18,
          _debtRedistributed: 1_200n * D18,
          _boldGasCompensation: 0n,
          _collGasCompensation: 0n,
          _collSentToSP: 120n * D18,
          _collRedistributed: 480n * D18,
          _collSurplus: 0n,
          _L_ETH: 500n,
          _L_boldDebt: 700n,
          _price: D18,
          mockEventData: mockEventData({ ...tx, logIndex: 3 }),
        }),
      ],
    });
    const row = ledgerRow(mockDb, 701, 2);
    assert.ok(row, "Liquidation handler writes the final op-5 row");
    assert.equal(row.operation, OP.LIQUIDATE);
    assert.equal(row.debtChange, -(1_500n * D18));
    assert.equal(row.collChange, -(600n * D18));
    assert.equal(row.debtBefore, 1_500n * D18);
    assert.equal(row.debtAfter, 0n);
    assert.equal(row.collBefore, 600n * D18);
    assert.equal(row.collAfter, 0n);
    assert.equal(row.statusBefore, "active");
    assert.equal(row.statusAfter, "liquidated");
    assert.equal(row.icrAfterBps, undefined, "zero-debt after state — no ICR");
    assert.equal(row.priceAtEvent, undefined);
    const trove = mockDb.entities.Trove.get(troveEntityId);
    assert.equal(trove?.lastLedgerBlock, 701n);
    assert.equal(trove?.lastLedgerLogIndex, 2);
  });

  it("batch-membership rows carry a permanently-null debtBefore and get debtAfter + statusAfter from the BatchUpdated replay", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 8n;
    const batchManager = "0x00000000000000000000000000000000000000bb";
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_000n * D18,
      coll: 500n * D18,
      annualInterestRate: 5n * 10n ** 16n,
      blockNumber: 800,
      blockTimestamp: 690_000,
      txHash: "0xopen8",
    });

    const tx = { blockNumber: 801, blockTimestamp: 700_000, txHash: "0xjoin" };
    // On-chain, batched update events precede TroveOperation; this case
    // inverts the order deliberately to exercise the defensive fallback
    // where the writer must classify without a status capture.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveOperationEvent({
          ...tx,
          troveId,
          operation: OP.SET_INTEREST_BATCH_MANAGER,
          annualInterestRate: 6n * 10n ** 16n,
          logIndex: 1,
        }),
        LiquityTroveManager.BatchedTroveUpdated.createMockEvent({
          _troveId: troveId,
          _interestBatchManager: batchManager,
          _batchDebtShares: 1_000n * D18,
          _coll: 500n * D18,
          _stake: 500n * D18,
          _snapshotOfTotalCollRedist: 0n,
          _snapshotOfTotalDebtRedist: 0n,
          mockEventData: mockEventData({ ...tx, logIndex: 2 }),
        }),
      ],
    });
    assert.equal(
      ledgerRow(mockDb, 801, 1),
      undefined,
      "batch row is staged until the BatchUpdated replay",
    );
    assert.equal(
      mockDb.entities.PendingTroveLedgerEvent.get(
        pendingTroveKey(market.chainId, "0xjoin", collateralId, "0x8"),
      )?.kind,
      "batch",
    );

    mockDb = await processMockEvents({
      mockDb,
      events: [
        LiquityTroveManager.BatchUpdated.createMockEvent({
          _interestBatchManager: batchManager,
          _operation: 0n,
          _debt: 1_000n * D18,
          _coll: 500n * D18,
          _annualInterestRate: 6n * 10n ** 16n,
          _annualManagementFee: 0n,
          _totalDebtShares: 1_000n * D18,
          _debtIncreaseFromUpfrontFee: 0n,
          mockEventData: mockEventData({ ...tx, logIndex: 3 }),
        }),
      ],
    });
    const row = ledgerRow(mockDb, 801, 1);
    assert.ok(row, "BatchUpdated replay finalizes the batch row");
    assert.equal(row.operation, OP.SET_INTEREST_BATCH_MANAGER);
    assert.equal(
      row.debtBefore,
      undefined,
      "per-trove pre-op debt inside a batch is not derivable — stays null",
    );
    assert.equal(
      row.debtAfter,
      1_000n * D18,
      "debtAfter is the replayed share-derived debt",
    );
    assert.equal(row.collBefore, 500n * D18, "collateral snapshots stay set");
    assert.equal(row.collAfter, 500n * D18);
    assert.equal(row.statusBefore, "active");
    assert.equal(
      row.statusAfter,
      "active",
      "statusAfter is the replayed classification",
    );
    const trove = mockDb.entities.Trove.get(makeTroveId(collateralId, "0x8"));
    assert.equal(trove?.lastLedgerBlock, 801n, "watermark stamps at replay");
    assert.equal(trove?.lastLedgerLogIndex, 1);
  });

  it("remove-from-batch (op 9) writes a direct row with full snapshots; nothing is staged for a replay that never comes", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 12n;
    const batchManager = "0x00000000000000000000000000000000000000cc";
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_000n * D18,
      coll: 500n * D18,
      annualInterestRate: 5n * 10n ** 16n,
      blockNumber: 810,
      blockTimestamp: 690_000,
      txHash: "0xopen12",
    });

    // Join in real emission order so the trove is batch-managed.
    const joinTx = {
      blockNumber: 811,
      blockTimestamp: 700_000,
      txHash: "0xjoin12",
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        LiquityTroveManager.BatchedTroveUpdated.createMockEvent({
          _troveId: troveId,
          _interestBatchManager: batchManager,
          _batchDebtShares: 1_000n * D18,
          _coll: 500n * D18,
          _stake: 500n * D18,
          _snapshotOfTotalCollRedist: 0n,
          _snapshotOfTotalDebtRedist: 0n,
          mockEventData: mockEventData({ ...joinTx, logIndex: 1 }),
        }),
        troveOperationEvent({
          ...joinTx,
          troveId,
          operation: OP.SET_INTEREST_BATCH_MANAGER,
          annualInterestRate: 6n * 10n ** 16n,
          logIndex: 2,
        }),
        LiquityTroveManager.BatchUpdated.createMockEvent({
          _interestBatchManager: batchManager,
          _operation: 0n,
          _debt: 1_000n * D18,
          _coll: 500n * D18,
          _annualInterestRate: 6n * 10n ** 16n,
          _annualManagementFee: 0n,
          _totalDebtShares: 1_000n * D18,
          _debtIncreaseFromUpfrontFee: 0n,
          mockEventData: mockEventData({ ...joinTx, logIndex: 3 }),
        }),
      ],
    });
    assert.equal(
      mockDb.entities.Trove.get(makeTroveId(collateralId, "0xc"))
        ?.interestBatchId,
      `${collateralId}-${batchManager}`,
      "precondition: trove is batch-managed before the removal",
    );

    // Real removal order (`onRemoveFromBatch` emit site): an ordinary
    // TroveUpdated with the full individual debt, then TroveOperation(9),
    // then the batch's exit BatchUpdated — no BatchedTroveUpdated, so no
    // replay row exists for this trove.
    const exitTx = {
      blockNumber: 812,
      blockTimestamp: 710_000,
      txHash: "0xexit12",
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          ...exitTx,
          troveId,
          debt: 1_050n * D18,
          coll: 500n * D18,
          annualInterestRate: 7n * 10n ** 16n,
          logIndex: 1,
        }),
        troveOperationEvent({
          ...exitTx,
          troveId,
          operation: OP.REMOVE_FROM_BATCH,
          annualInterestRate: 7n * 10n ** 16n,
          debtIncreaseFromUpfrontFee: 2n * D18,
          logIndex: 2,
        }),
        LiquityTroveManager.BatchUpdated.createMockEvent({
          _interestBatchManager: batchManager,
          _operation: 0n,
          _debt: 0n,
          _coll: 0n,
          _annualInterestRate: 6n * 10n ** 16n,
          _annualManagementFee: 0n,
          _totalDebtShares: 0n,
          _debtIncreaseFromUpfrontFee: 0n,
          mockEventData: mockEventData({ ...exitTx, logIndex: 3 }),
        }),
      ],
    });

    const row = ledgerRow(mockDb, 812, 2);
    assert.ok(row, "op-9 row writes directly at the TroveOperation event");
    assert.equal(row.operation, OP.REMOVE_FROM_BATCH);
    assert.equal(
      row.debtAfter,
      1_050n * D18,
      "debtAfter is the TroveUpdated-carried individual debt",
    );
    assert.equal(
      row.debtBefore,
      1_048n * D18,
      "debtBefore derives backward across the upfront fee",
    );
    assert.equal(row.collBefore, 500n * D18);
    assert.equal(row.collAfter, 500n * D18);
    assert.equal(row.statusBefore, "active");
    assert.equal(row.statusAfter, "active");
    assert.equal(
      mockDb.entities.PendingTroveLedgerEvent.get(
        pendingTroveKey(market.chainId, "0xexit12", collateralId, "0xc"),
      ),
      undefined,
      "no staged batch row is left behind",
    );
    const trove = mockDb.entities.Trove.get(makeTroveId(collateralId, "0xc"));
    assert.equal(trove?.lastLedgerBlock, 812n, "watermark stamps directly");
    assert.equal(trove?.lastLedgerLogIndex, 2);
  });

  it("batched redemption rows take statusAfter and debtAfter from the replayed entity, not the stale staged classification", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 13n;
    const batchManager = "0x00000000000000000000000000000000000000dd";
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_000n * D18,
      coll: 500n * D18,
      annualInterestRate: 5n * 10n ** 16n,
      blockNumber: 820,
      blockTimestamp: 690_000,
      txHash: "0xopen13",
    });
    const joinTx = {
      blockNumber: 821,
      blockTimestamp: 700_000,
      txHash: "0xjoin13",
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        LiquityTroveManager.BatchedTroveUpdated.createMockEvent({
          _troveId: troveId,
          _interestBatchManager: batchManager,
          _batchDebtShares: 1_000n * D18,
          _coll: 500n * D18,
          _stake: 500n * D18,
          _snapshotOfTotalCollRedist: 0n,
          _snapshotOfTotalDebtRedist: 0n,
          mockEventData: mockEventData({ ...joinTx, logIndex: 1 }),
        }),
        troveOperationEvent({
          ...joinTx,
          troveId,
          operation: OP.SET_INTEREST_BATCH_MANAGER,
          annualInterestRate: 6n * 10n ** 16n,
          logIndex: 2,
        }),
        LiquityTroveManager.BatchUpdated.createMockEvent({
          _interestBatchManager: batchManager,
          _operation: 0n,
          _debt: 1_000n * D18,
          _coll: 500n * D18,
          _annualInterestRate: 6n * 10n ** 16n,
          _annualManagementFee: 0n,
          _totalDebtShares: 1_000n * D18,
          _debtIncreaseFromUpfrontFee: 0n,
          mockEventData: mockEventData({ ...joinTx, logIndex: 3 }),
        }),
      ],
    });

    // Real per-trove redemption order on a batched trove
    // (`_applySingleRedemption`): BatchedTroveUpdated → TroveOperation(6)
    // → BatchUpdated → fee, then the aggregate Redemption after the loop.
    // 950 of 1_000 debt is redeemed; the replayed share-derived debt (50)
    // sits under minDebt (100), so the replay classifies the trove zombie
    // while the staged row was classified from stale pre-replay debt.
    const redeemTx = {
      blockNumber: 822,
      blockTimestamp: 710_000,
      txHash: "0xredeem13",
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        LiquityTroveManager.BatchedTroveUpdated.createMockEvent({
          _troveId: troveId,
          _interestBatchManager: batchManager,
          _batchDebtShares: 1_000n * D18,
          _coll: 25n * D18,
          _stake: 25n * D18,
          _snapshotOfTotalCollRedist: 0n,
          _snapshotOfTotalDebtRedist: 0n,
          mockEventData: mockEventData({ ...redeemTx, logIndex: 1 }),
        }),
        troveOperationEvent({
          ...redeemTx,
          troveId,
          operation: OP.REDEEM_COLLATERAL,
          debtChangeFromOperation: -950n * D18,
          collChangeFromOperation: -475n * D18,
          logIndex: 2,
        }),
        LiquityTroveManager.BatchUpdated.createMockEvent({
          _interestBatchManager: batchManager,
          _operation: 0n,
          _debt: 50n * D18,
          _coll: 25n * D18,
          _annualInterestRate: 6n * 10n ** 16n,
          _annualManagementFee: 0n,
          _totalDebtShares: 1_000n * D18,
          _debtIncreaseFromUpfrontFee: 0n,
          mockEventData: mockEventData({ ...redeemTx, logIndex: 3 }),
        }),
        redemptionFeeEvent({
          ...redeemTx,
          troveId,
          fee: 1n * D18,
          logIndex: 4,
        }),
        redemptionEvent({
          ...redeemTx,
          actualBoldAmount: 950n * D18,
          ethFee: 1n * D18,
          redemptionPrice: 2_000n * D18,
          logIndex: 5,
        }),
      ],
    });

    const row = ledgerRow(mockDb, 822, 2);
    assert.ok(row, "aggregate Redemption finalizes the staged batched row");
    assert.equal(row.operation, OP.REDEEM_COLLATERAL);
    assert.equal(row.statusBefore, "active");
    assert.equal(
      row.statusAfter,
      "zombie",
      "statusAfter is the replayed classification, not the stale staged one",
    );
    assert.equal(
      row.debtAfter,
      50n * D18,
      "debtAfter fills from the entity's replayed share-derived debt",
    );
    assert.equal(
      row.debtBefore,
      undefined,
      "batched debtBefore stays null permanently",
    );
    assert.equal(row.collBefore, 500n * D18);
    assert.equal(row.collAfter, 25n * D18);
    assert.equal(row.redemptionPrice, 2_000n * D18);
    assert.equal(row.redemptionFeeCredited, 1n * D18);
    const trove = mockDb.entities.Trove.get(makeTroveId(collateralId, "0xd"));
    assert.equal(trove?.status, "zombie");
    assert.equal(trove?.lastLedgerBlock, 822n, "watermark stamps at finalize");
    assert.equal(trove?.lastLedgerLogIndex, 2);
  });

  it("zombie transition and revival surface as statusBefore/statusAfter flips against live SystemParams minDebt", async () => {
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 9n;
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 150n * D18,
      coll: 200n * D18,
      blockNumber: 900,
      blockTimestamp: 790_000,
      txHash: "0xopen9",
    });

    // Redemption leaves 0 < debt (50) < minDebt (100) → zombie.
    const redeemTx = {
      blockNumber: 901,
      blockTimestamp: 800_000,
      txHash: "0xzomb",
      to: market.cdpLiquidityStrategy,
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          ...redeemTx,
          troveId,
          debt: 50n * D18,
          coll: 150n * D18,
          logIndex: 1,
        }),
        troveOperationEvent({
          ...redeemTx,
          troveId,
          operation: OP.REDEEM_COLLATERAL,
          debtChangeFromOperation: -(100n * D18),
          collChangeFromOperation: -(50n * D18),
          logIndex: 2,
        }),
        redemptionFeeEvent({ ...redeemTx, troveId, fee: 0n, logIndex: 3 }),
        redemptionEvent({
          ...redeemTx,
          actualBoldAmount: 100n * D18,
          ethFee: 0n,
          redemptionPrice: D18,
          logIndex: 4,
        }),
      ],
    });
    const zombieRow = ledgerRow(mockDb, 901, 2);
    assert.ok(zombieRow, "zombie-making redemption writes a row");
    assert.equal(
      zombieRow.statusBefore,
      "active",
      "statusBefore captured before the same-tx TroveUpdated reclassified",
    );
    assert.equal(zombieRow.statusAfter, "zombie");
    assert.equal(zombieRow.redemptionFeeCredited, 0n);

    // Revival via adjustZombieTrove surfaces as op 2.
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          troveId,
          debt: 150n * D18,
          coll: 150n * D18,
          blockNumber: 902,
          blockTimestamp: 810_000,
          logIndex: 1,
          txHash: "0xrevive",
        }),
        troveOperationEvent({
          troveId,
          operation: OP.ADJUST_TROVE,
          debtChangeFromOperation: 100n * D18,
          blockNumber: 902,
          blockTimestamp: 810_000,
          logIndex: 2,
          txHash: "0xrevive",
        }),
      ],
    });
    const reviveRow = ledgerRow(mockDb, 902, 2);
    assert.ok(reviveRow, "revival writes a row");
    assert.equal(reviveRow.statusBefore, "zombie");
    assert.equal(reviveRow.statusAfter, "active");
  });

  it("live rows persist the block-close price; the event-carried redemption price still wins for ICR", async () => {
    const liveTs = Number(TROVE_LEDGER_PRICE_CUTOFF_TIMESTAMP) + 100_000;
    setHttpRpcMock({
      group: PRICE_MOCK_GROUP,
      chainId: market.chainId,
      address: market.priceFeed,
      functionName: "fetchPrice",
      result: 2n * D18,
    });
    let mockDb = MockDb.createMockDb();
    seedLoadedCollateral(mockDb);
    const troveId = 7n;
    mockDb = await openTrove(mockDb, {
      troveId,
      debt: 1_000n * D18,
      coll: 1_000n * D18,
      blockNumber: 1_000,
      blockTimestamp: liveTs,
      txHash: "0xopen7",
    });
    const openRow = ledgerRow(mockDb, 1_000, 2);
    assert.ok(openRow);
    assert.equal(
      openRow.priceAtEvent,
      2n * D18,
      "live rows record the block-close price",
    );
    assert.equal(
      openRow.icrAfterBps,
      20_000,
      "direct rows derive ICR from the block-close price",
    );

    const tx = {
      blockNumber: 1_001,
      blockTimestamp: liveTs + 10,
      txHash: "0xliveRedeem",
      to: market.cdpLiquidityStrategy,
    };
    mockDb = await processMockEvents({
      mockDb,
      events: [
        troveUpdatedEvent({
          ...tx,
          troveId,
          debt: 500n * D18,
          coll: 750n * D18,
          logIndex: 1,
        }),
        troveOperationEvent({
          ...tx,
          troveId,
          operation: OP.REDEEM_COLLATERAL,
          debtChangeFromOperation: -(500n * D18),
          collChangeFromOperation: -(250n * D18),
          logIndex: 2,
        }),
        redemptionFeeEvent({ ...tx, troveId, fee: 0n, logIndex: 3 }),
        redemptionEvent({
          ...tx,
          actualBoldAmount: 500n * D18,
          ethFee: 0n,
          redemptionPrice: 3n * D18,
          logIndex: 4,
        }),
      ],
    });
    const row = ledgerRow(mockDb, 1_001, 2);
    assert.ok(row);
    assert.equal(
      row.priceAtEvent,
      2n * D18,
      "priceAtEvent stays the block-close sample, never the event price",
    );
    assert.equal(row.redemptionPrice, 3n * D18);
    assert.equal(
      row.icrAfterBps,
      45_000,
      "ICR uses the exact event-carried price (750 × 3 / 500), not block-close",
    );
  });
});
