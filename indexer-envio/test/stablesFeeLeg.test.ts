import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { YIELD_SPLIT_ADDRESS } from "../src/feeToken.ts";
import { makePoolId } from "../src/helpers.ts";
import { handleYieldSplitInflow } from "../src/handlers/stables/feeLeg.ts";
import {
  LIQUITY_MARKETS,
  makeCollateralId,
} from "../src/handlers/liquity/config.ts";
import { borrowingRevenueDailySnapshotId } from "../src/handlers/liquity/borrowingRevenue.ts";
import { dayBucket } from "../src/helpers.ts";

const CELO = 42220;
const ZERO = "0x0000000000000000000000000000000000000000";
const CUSD = "0x765de816845861e75a25fca122bb6898b8b1282a"; // registry symbol USDm (pegged)
const POOL_ADDR = "0x0feba760d93423d127de1b6abecdb60e5253228d";
const RANDOM_EOA = "0x1111111111111111111111111111111111111111";

const GBPM_MARKET = LIQUITY_MARKETS.find(
  (m) => m.chainId === CELO && m.symbol === "GBPm",
);
if (!GBPM_MARKET) throw new Error("GBPm market missing from LIQUITY_MARKETS");

type Row = Record<string, unknown>;

/** Map-backed mock with the store shape handleYieldSplitInflow touches. */
function makeMockContext(opts: {
  isPreload?: boolean;
  pools?: ReadonlyArray<{ id: string; source: string }>;
}) {
  const stores = {
    Pool: new Map<string, Row>(),
    ProtocolFeeTransfer: new Map<string, Row>(),
    PoolDailyFeeSnapshot: new Map<string, Row>(),
    LiquityCollateral: new Map<string, Row>(),
    LiquityInstance: new Map<string, Row>(),
    LiquityBorrowingRevenueDailySnapshot: new Map<string, Row>(),
  };
  for (const pool of opts.pools ?? []) stores.Pool.set(pool.id, pool);
  const entity = (name: keyof typeof stores) => ({
    get: async (id: string) => stores[name].get(id),
    set: (row: { id: string }) => {
      stores[name].set(row.id, row);
    },
  });
  return {
    stores,
    context: {
      isPreload: opts.isPreload ?? false,
      Pool: entity("Pool"),
      ProtocolFeeTransfer: entity("ProtocolFeeTransfer"),
      PoolDailyFeeSnapshot: entity("PoolDailyFeeSnapshot"),
      LiquityCollateral: entity("LiquityCollateral"),
      LiquityInstance: entity("LiquityInstance"),
      LiquityBorrowingRevenueDailySnapshot: entity(
        "LiquityBorrowingRevenueDailySnapshot",
      ),
    },
  };
}

const TS = 1_765_000_000; // fixed block timestamp
const BLOCK = 69_000_000;

function makeTransferEvent(args: {
  from: string;
  to?: string;
  token?: string;
  value?: bigint;
  logIndex?: number;
}) {
  return {
    chainId: CELO,
    srcAddress: args.token ?? CUSD,
    logIndex: args.logIndex ?? 7,
    params: {
      from: args.from,
      to: args.to ?? YIELD_SPLIT_ADDRESS,
      value: args.value ?? 123n * 10n ** 18n,
    },
    block: { number: BLOCK, timestamp: TS },
    transaction: { hash: "0xabc" },
  };
}

describe("handleYieldSplitInflow — swap-fee legs paid in Mento stables", () => {
  it("records a pool→Safe cUSD transfer as a protocol fee (pegged path)", async () => {
    const poolId = makePoolId(CELO, POOL_ADDR);
    const { context, stores } = makeMockContext({
      pools: [{ id: poolId, source: "fpmm" }],
    });
    await handleYieldSplitInflow({
      event: makeTransferEvent({ from: POOL_ADDR }),
      context: context as never,
    });

    assert.equal(stores.ProtocolFeeTransfer.size, 1);
    const transfer = [...stores.ProtocolFeeTransfer.values()][0] as {
      tokenSymbol: string;
      tokenDecimals: number;
      from: string;
    };
    assert.equal(transfer.tokenSymbol, "USDm");
    assert.equal(transfer.tokenDecimals, 18);
    assert.equal(transfer.from, POOL_ADDR);

    assert.equal(stores.PoolDailyFeeSnapshot.size, 1);
    const snapshot = [...stores.PoolDailyFeeSnapshot.values()][0] as {
      feesUsdWei: bigint;
      allPegged: boolean;
      transferCount: number;
    };
    // USDm is USD-pegged → contributes to feesUsdWei directly.
    assert.equal(snapshot.feesUsdWei, 123n * 10n ** 18n);
    assert.equal(snapshot.allPegged, true);
    assert.equal(snapshot.transferCount, 1);
  });

  it("records a pool→Safe GBPm transfer via the lock/mint NTT registry (FX path)", async () => {
    const poolId = makePoolId(CELO, POOL_ADDR);
    const { context, stores } = makeMockContext({
      pools: [{ id: poolId, source: "fpmm" }],
    });
    await handleYieldSplitInflow({
      event: makeTransferEvent({
        from: POOL_ADDR,
        token: GBPM_MARKET.debtToken,
      }),
      context: context as never,
    });

    const transfer = [...stores.ProtocolFeeTransfer.values()][0] as {
      tokenSymbol: string;
    };
    assert.equal(transfer.tokenSymbol, "GBPm");
    const snapshot = [...stores.PoolDailyFeeSnapshot.values()][0] as {
      feesUsdWei: bigint;
      allPegged: boolean;
    };
    // GBPm is FX-priced dashboard-side; the indexer leaves feesUsdWei at 0.
    assert.equal(snapshot.feesUsdWei, 0n);
    assert.equal(snapshot.allPegged, false);
  });

  it("skips transfers from senders that are not indexed pools", async () => {
    const { context, stores } = makeMockContext({ pools: [] });
    await handleYieldSplitInflow({
      event: makeTransferEvent({ from: RANDOM_EOA }),
      context: context as never,
    });
    assert.equal(stores.ProtocolFeeTransfer.size, 0);
    assert.equal(stores.PoolDailyFeeSnapshot.size, 0);
  });

  it("skips transfers from non-FPMM/virtual pool rows", async () => {
    const poolId = makePoolId(CELO, POOL_ADDR);
    const { context, stores } = makeMockContext({
      pools: [{ id: poolId, source: "bipool" }],
    });
    await handleYieldSplitInflow({
      event: makeTransferEvent({ from: POOL_ADDR }),
      context: context as never,
    });
    assert.equal(stores.ProtocolFeeTransfer.size, 0);
    assert.equal(stores.PoolDailyFeeSnapshot.size, 0);
  });

  it("is replay-idempotent: a re-delivered event does not double-count the snapshot", async () => {
    const poolId = makePoolId(CELO, POOL_ADDR);
    const { context, stores } = makeMockContext({
      pools: [{ id: poolId, source: "fpmm" }],
    });
    const event = makeTransferEvent({ from: POOL_ADDR });
    await handleYieldSplitInflow({ event, context: context as never });
    await handleYieldSplitInflow({ event, context: context as never });

    assert.equal(stores.ProtocolFeeTransfer.size, 1);
    const snapshot = [...stores.PoolDailyFeeSnapshot.values()][0] as {
      feesUsdWei: bigint;
      transferCount: number;
    };
    assert.equal(snapshot.feesUsdWei, 123n * 10n ** 18n);
    assert.equal(snapshot.transferCount, 1);
  });

  it("ignores transfers whose recipient is not the yield-split Safe", async () => {
    const poolId = makePoolId(CELO, POOL_ADDR);
    const { context, stores } = makeMockContext({
      pools: [{ id: poolId, source: "fpmm" }],
    });
    await handleYieldSplitInflow({
      event: makeTransferEvent({ from: POOL_ADDR, to: RANDOM_EOA }),
      context: context as never,
    });
    assert.equal(stores.ProtocolFeeTransfer.size, 0);
  });

  it("preload phase only warms reads, never writes", async () => {
    const poolId = makePoolId(CELO, POOL_ADDR);
    const { context, stores } = makeMockContext({
      isPreload: true,
      pools: [{ id: poolId, source: "fpmm" }],
    });
    await handleYieldSplitInflow({
      event: makeTransferEvent({ from: POOL_ADDR }),
      context: context as never,
    });
    assert.equal(stores.ProtocolFeeTransfer.size, 0);
    assert.equal(stores.PoolDailyFeeSnapshot.size, 0);
  });
});

describe("handleYieldSplitInflow — collected borrowing revenue (0x0 → Safe mints)", () => {
  it("rolls a debt-token mint into instance cum + daily snapshot.collected", async () => {
    const { context, stores } = makeMockContext({});
    const minted = 50n * 10n ** 18n;
    await handleYieldSplitInflow({
      event: makeTransferEvent({
        from: ZERO,
        token: GBPM_MARKET.debtToken,
        value: minted,
      }),
      context: context as never,
    });

    const collateralId = makeCollateralId(GBPM_MARKET);
    const instance = stores.LiquityInstance.get(collateralId) as {
      borrowingFeeCollectedCum: bigint;
    };
    assert.equal(instance.borrowingFeeCollectedCum, minted);

    const snapshotId = borrowingRevenueDailySnapshotId(
      collateralId,
      dayBucket(BigInt(TS)),
    );
    const snapshot = stores.LiquityBorrowingRevenueDailySnapshot.get(
      snapshotId,
    ) as { collected: bigint; upfrontFee: bigint; accruedInterest: bigint };
    assert.equal(snapshot.collected, minted);
    assert.equal(snapshot.upfrontFee, 0n);
    assert.equal(snapshot.accruedInterest, 0n);
  });

  it("accumulates repeated mints across the same day bucket", async () => {
    const { context, stores } = makeMockContext({});
    const mint = (value: bigint, logIndex: number) =>
      handleYieldSplitInflow({
        event: makeTransferEvent({
          from: ZERO,
          token: GBPM_MARKET.debtToken,
          value,
          logIndex,
        }),
        context: context as never,
      });
    await mint(10n * 10n ** 18n, 1);
    await mint(15n * 10n ** 18n, 2);

    const collateralId = makeCollateralId(GBPM_MARKET);
    const instance = stores.LiquityInstance.get(collateralId) as {
      borrowingFeeCollectedCum: bigint;
    };
    assert.equal(instance.borrowingFeeCollectedCum, 25n * 10n ** 18n);
  });

  it("ignores mints to the Safe in non-CDP tokens (supply path owns them)", async () => {
    const { context, stores } = makeMockContext({});
    await handleYieldSplitInflow({
      event: makeTransferEvent({ from: ZERO, token: CUSD }),
      context: context as never,
    });
    assert.equal(stores.LiquityInstance.size, 0);
    assert.equal(stores.LiquityBorrowingRevenueDailySnapshot.size, 0);
  });

  it("preload phase warms reads without creating instance rows", async () => {
    const { context, stores } = makeMockContext({ isPreload: true });
    await handleYieldSplitInflow({
      event: makeTransferEvent({ from: ZERO, token: GBPM_MARKET.debtToken }),
      context: context as never,
    });
    assert.equal(stores.LiquityInstance.size, 0);
    assert.equal(stores.LiquityBorrowingRevenueDailySnapshot.size, 0);
  });
});
