import assert from "node:assert/strict";
import { createTestIndexer } from "envio";
import { makePool } from "./helpers/makePool.js";
import { makePoolId } from "../src/helpers.js";
import {
  _setMockReserves,
  _clearMockReserves,
  _clearMockRebalancingStates,
  _setMockRebalanceIncentiveAtBlock,
  _clearMockRebalanceIncentivesAtBlock,
} from "../src/rpc.js";

// Real Celo mainnet addresses — resolvable via KNOWN_TOKEN_META so
// computeRebalanceUsd's symbol lookup succeeds.
const CHAIN_CELO = 42220;
const POOL = "0x00000000000000000000000000000000000000aa";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a"; // 18dp, pegged
const CELO = "0x471ece3750da237f93b8e339c536989b8978a438"; // 18dp, NOT pegged
const STRATEGY = "0x0000000000000000000000000000000000000099";
const TX_FROM = "0x000000000000000000000000000000000000ca11";

type TestIndexer = ReturnType<typeof createTestIndexer>;

function seedRebalanceablePool(
  ti: TestIndexer,
  options: {
    rebalanceReward: number;
    reserves0: bigint;
    reserves1: bigint;
    token0?: string;
    token1?: string;
    token0Decimals?: number;
    token1Decimals?: number;
  },
): void {
  ti.Pool.set(
    makePool({
      id: makePoolId(CHAIN_CELO, POOL),
      chainId: CHAIN_CELO,
      token0: options.token0 ?? USDM,
      token1: options.token1 ?? CELO,
      token0Decimals: options.token0Decimals ?? 18,
      token1Decimals: options.token1Decimals ?? 18,
      reserves0: options.reserves0,
      reserves1: options.reserves1,
      rebalanceReward: options.rebalanceReward,
      oraclePrice: 1_000_000_000_000_000_000_000_000n,
      invertRateFeed: false,
      invertRateFeedKnown: true,
      source: "fpmm_update_reserves",
    }),
  );
}

async function processRebalanced(
  ti: TestIndexer,
  args: {
    blockNumber: number;
    logIndex?: number;
    priceDifferenceBefore: bigint;
    priceDifferenceAfter: bigint;
  },
): Promise<void> {
  await ti.process({
    chains: {
      [CHAIN_CELO]: {
        startBlock: args.blockNumber,
        simulate: [
          {
            contract: "FPMM",
            event: "Rebalanced",
            params: {
              sender: STRATEGY as `0x${string}`,
              priceDifferenceBefore: args.priceDifferenceBefore,
              priceDifferenceAfter: args.priceDifferenceAfter,
            },
            block: { number: args.blockNumber, timestamp: 1_700_010_000 },
            transaction: {
              hash: `0x${"ab".repeat(32)}` as `0x${string}`,
              from: TX_FROM as `0x${string}`,
            },
            srcAddress: POOL as `0x${string}`,
            logIndex: args.logIndex ?? 5,
          },
        ],
      },
    },
  });
}

describe("FPMM.Rebalanced handler — USD profit fields", () => {
  beforeEach(() => {
    _clearMockReserves();
    _clearMockRebalancingStates();
    _clearMockRebalanceIncentivesAtBlock();
  });

  afterAll(() => {
    _clearMockReserves();
    _clearMockRebalancingStates();
    _clearMockRebalanceIncentivesAtBlock();
  });

  it("stamps amount deltas + USD fields from block-scoped incentive read", async () => {
    const ti = createTestIndexer();
    // Pool reserves AFTER the rebalance: pool received 1000 USDM, gave away 500 CELO.
    seedRebalanceablePool(ti, {
      rebalanceReward: 999, // would be wrong if used — block-scoped read should win
      reserves0: 101_000n * 10n ** 18n,
      reserves1: 49_500n * 10n ** 18n,
    });
    // Pre-rebalance reserves at blockNumber - 1.
    _setMockReserves(CHAIN_CELO, POOL, {
      reserve0: 100_000n * 10n ** 18n,
      reserve1: 50_000n * 10n ** 18n,
    });
    // Block-scoped incentive: 25 bps. Distinct from Pool.rebalanceReward=999
    // so we can prove the handler used the block-scoped value.
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, 25);

    await processRebalanced(ti, {
      blockNumber: 601,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
    });

    const id = `${CHAIN_CELO}_601_5`;
    const rebalance = await ti.RebalanceEvent.get(id);
    assert.ok(rebalance, "RebalanceEvent must be persisted");
    assert.equal(rebalance.amount0Delta, 1_000n * 10n ** 18n);
    assert.equal(rebalance.amount1Delta, -500n * 10n ** 18n);
    assert.equal(
      rebalance.rewardBps,
      25,
      "rewardBps must come from block-scoped read, not Pool.rebalanceReward",
    );
    assert.equal(rebalance.notionalUsd, "1000.0000");
    assert.equal(rebalance.rewardUsd, "2.5000");
  });

  it("short-circuits the incentive RPC when Pool.rebalanceReward = -2 sentinel", async () => {
    const ti = createTestIndexer();
    seedRebalanceablePool(ti, {
      rebalanceReward: -2, // getter missing on this contract
      reserves0: 101_000n * 10n ** 18n,
      reserves1: 49_500n * 10n ** 18n,
    });
    _setMockReserves(CHAIN_CELO, POOL, {
      reserve0: 100_000n * 10n ** 18n,
      reserve1: 50_000n * 10n ** 18n,
    });
    // If the handler did call the RPC, this mock would override to a non-zero
    // value. The assertion below proves the call was skipped.
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, 999);

    await processRebalanced(ti, {
      blockNumber: 602,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
    });

    const rebalance = await ti.RebalanceEvent.get(`${CHAIN_CELO}_602_5`);
    assert.ok(rebalance);
    assert.equal(
      rebalance.rewardBps,
      0,
      "-2 sentinel must normalize to 0, not the RPC mock value",
    );
    assert.equal(rebalance.rewardUsd, "0.0000");
    assert.equal(rebalance.notionalUsd, "1000.0000");
  });

  it("stamps rewardUsd = '' when block-scoped incentive RPC fails (preserves notional, no fallback)", async () => {
    const ti = createTestIndexer();
    seedRebalanceablePool(ti, {
      rebalanceReward: 50, // NOT -2 — handler will attempt the RPC
      reserves0: 101_000n * 10n ** 18n,
      reserves1: 49_500n * 10n ** 18n,
    });
    _setMockReserves(CHAIN_CELO, POOL, {
      reserve0: 100_000n * 10n ** 18n,
      reserve1: 50_000n * 10n ** 18n,
    });
    // Simulate block-scoped RPC failure → null. We must NOT (a) fall back to
    // Pool.rebalanceReward (`latest`-seeded by upsertPool's self-heal) nor
    // (b) coerce to 0 (would render as "$0.00", indistinguishable from a
    // real zero-incentive rebalance). Instead, stamp "" so the UI shows "—".
    // Notional is reserves-derived and stays valid.
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, null);

    await processRebalanced(ti, {
      blockNumber: 603,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
    });

    const rebalance = await ti.RebalanceEvent.get(`${CHAIN_CELO}_603_5`);
    assert.ok(rebalance);
    assert.equal(
      rebalance.rewardBps,
      0,
      "RPC failure must NOT fall back to potentially-stale Pool.rebalanceReward",
    );
    assert.equal(
      rebalance.rewardUsd,
      "",
      "RPC failure must produce '' sentinel (unknown), not '0.0000' (real zero)",
    );
    assert.equal(
      rebalance.notionalUsd,
      "1000.0000",
      "Notional is reserves-derived and stays valid even when incentive RPC fails",
    );
  });

  it("zero deltas (RPC fallback for pre-reserves) → '' sentinel for both USD fields", async () => {
    const ti = createTestIndexer();
    seedRebalanceablePool(ti, {
      rebalanceReward: 25,
      reserves0: 100_000n * 10n ** 18n,
      reserves1: 50_000n * 10n ** 18n,
    });
    // Simulate fetchReserves(blockNumber - 1) failure → null.
    _setMockReserves(CHAIN_CELO, POOL, null);
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, 25);

    await processRebalanced(ti, {
      blockNumber: 604,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
    });

    const rebalance = await ti.RebalanceEvent.get(`${CHAIN_CELO}_604_5`);
    assert.ok(rebalance);
    assert.equal(rebalance.amount0Delta, 0n);
    assert.equal(rebalance.amount1Delta, 0n);
    assert.equal(rebalance.notionalUsd, "");
    assert.equal(rebalance.rewardUsd, "");
  });
});
