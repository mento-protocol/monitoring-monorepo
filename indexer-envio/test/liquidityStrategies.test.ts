import assert from "node:assert/strict";
import type { Pool, PoolLiquidityStrategy } from "envio";
import {
  _clearLiquidityStrategyKindIndex,
  getContractAddress,
  lookupLiquidityStrategyKind,
} from "../src/contractAddresses.ts";
import {
  poolLiquidityStrategyId,
  syncPoolLiquidityStrategy,
} from "../src/liquidityStrategies.ts";
import { makePool } from "./helpers/makePool.ts";

const CHAIN_ID = 137;
const POOL_ID = `${CHAIN_ID}-0x00000000000000000000000000000000000000aa`;
const UNKNOWN_STRATEGY = "0x00000000000000000000000000000000000000bb";

type StrategyContext = Parameters<
  typeof syncPoolLiquidityStrategy
>[0]["context"];

function makeStrategy(
  overrides: Partial<PoolLiquidityStrategy> = {},
): PoolLiquidityStrategy {
  const strategyAddress =
    overrides.strategyAddress ?? UNKNOWN_STRATEGY.toLowerCase();
  return {
    id: poolLiquidityStrategyId(POOL_ID, strategyAddress),
    chainId: CHAIN_ID,
    poolId: POOL_ID,
    strategyAddress,
    kind: "UNKNOWN",
    active: true,
    addedAtBlock: 10n,
    addedAtTimestamp: 100n,
    updatedAtBlock: 10n,
    updatedAtTimestamp: 100n,
    ...overrides,
  };
}

function makeContext(options: {
  pool?: Pool;
  strategies?: readonly PoolLiquidityStrategy[];
  isPreload?: boolean;
}) {
  const pools = new Map<string, Pool>();
  if (options.pool) pools.set(options.pool.id, options.pool);
  const strategies = new Map(
    (options.strategies ?? []).map((row) => [row.id, row]),
  );
  const poolSets: Pool[] = [];
  const strategySets: PoolLiquidityStrategy[] = [];
  let strategyQueries = 0;

  const context = {
    isPreload: options.isPreload ?? false,
    Pool: {
      get: async (id: string) => pools.get(id),
      set: (row: Pool) => {
        pools.set(row.id, row);
        poolSets.push(row);
      },
    },
    PoolLiquidityStrategy: {
      get: async (id: string) => strategies.get(id),
      getWhere: async ({ poolId }: { poolId: { _eq: string } }) => {
        strategyQueries += 1;
        return [...strategies.values()].filter(
          (row) => row.poolId === poolId._eq,
        );
      },
      set: (row: PoolLiquidityStrategy) => {
        strategies.set(row.id, row);
        strategySets.push(row);
      },
    },
  } as unknown as StrategyContext;

  return {
    context,
    pools,
    strategies,
    poolSets,
    strategySets,
    strategyQueries: () => strategyQueries,
  };
}

function poolWithRebalancer(rebalancerAddress: string): Pool {
  return makePool({
    id: POOL_ID,
    chainId: CHAIN_ID,
    rebalancerAddress,
  });
}

async function sync(
  context: StrategyContext,
  overrides: Partial<
    Omit<Parameters<typeof syncPoolLiquidityStrategy>[0], "context">
  > = {},
): Promise<void> {
  await syncPoolLiquidityStrategy({
    context,
    chainId: CHAIN_ID,
    poolId: POOL_ID,
    strategyAddress: UNKNOWN_STRATEGY,
    active: true,
    blockNumber: 20n,
    blockTimestamp: 200n,
    ...overrides,
  });
}

describe("liquidity strategy deployment metadata", () => {
  beforeEach(() => _clearLiquidityStrategyKindIndex());

  it("classifies every published strategy family used by the registry", () => {
    const polygonOpen = getContractAddress(CHAIN_ID, "OpenLiquidityStrategy");
    const polygonReserve = getContractAddress(
      CHAIN_ID,
      "ReserveLiquidityStrategy",
    );
    const celoCdp = getContractAddress(42220, "CDPLiquidityStrategy");
    assert.ok(polygonOpen);
    assert.ok(polygonReserve);
    assert.ok(celoCdp);

    assert.equal(lookupLiquidityStrategyKind(CHAIN_ID, polygonOpen), "OPEN");
    assert.equal(
      lookupLiquidityStrategyKind(CHAIN_ID, polygonReserve.toUpperCase()),
      "RESERVE",
    );
    assert.equal(lookupLiquidityStrategyKind(42220, celoCdp), "CDP");
  });

  it("returns null for unknown addresses and chains, including cached lookups", () => {
    assert.equal(lookupLiquidityStrategyKind(CHAIN_ID, UNKNOWN_STRATEGY), null);
    assert.equal(lookupLiquidityStrategyKind(CHAIN_ID, UNKNOWN_STRATEGY), null);
    assert.equal(lookupLiquidityStrategyKind(999_999, UNKNOWN_STRATEGY), null);
  });
});

describe("syncPoolLiquidityStrategy", () => {
  it("uses a collision-safe, case-normalized pool/strategy identity", () => {
    assert.equal(
      poolLiquidityStrategyId(POOL_ID, UNKNOWN_STRATEGY.toUpperCase()),
      `${POOL_ID}-${UNKNOWN_STRATEGY.toLowerCase()}`,
    );
  });

  it("preloads all reads for a removal without writing entities", async () => {
    const existing = makeStrategy();
    const state = makeContext({
      pool: poolWithRebalancer(UNKNOWN_STRATEGY),
      strategies: [existing],
      isPreload: true,
    });

    await sync(state.context, { active: false });

    assert.equal(state.strategyQueries(), 1);
    assert.deepEqual(state.strategySets, []);
    assert.deepEqual(state.poolSets, []);
  });

  it("classifies a published Polygon strategy and updates the legacy pointer", async () => {
    const reserve = getContractAddress(CHAIN_ID, "ReserveLiquidityStrategy");
    assert.ok(reserve);
    const state = makeContext({ pool: poolWithRebalancer("") });

    await sync(state.context, {
      strategyAddress: reserve.toUpperCase(),
      blockNumber: 30n,
      blockTimestamp: 300n,
    });

    const id = poolLiquidityStrategyId(POOL_ID, reserve);
    assert.deepEqual(state.strategies.get(id), {
      id,
      chainId: CHAIN_ID,
      poolId: POOL_ID,
      strategyAddress: reserve.toLowerCase(),
      kind: "RESERVE",
      active: true,
      addedAtBlock: 30n,
      addedAtTimestamp: 300n,
      updatedAtBlock: 30n,
      updatedAtTimestamp: 300n,
    });
    assert.equal(
      state.pools.get(POOL_ID)?.rebalancerAddress,
      reserve.toLowerCase(),
    );
    assert.equal(state.pools.get(POOL_ID)?.updatedAtBlock, 30n);
  });

  it("preserves the first-seen coordinates and known kind on reactivation", async () => {
    const existing = makeStrategy({
      kind: "CDP",
      active: false,
      addedAtBlock: 7n,
      addedAtTimestamp: 70n,
      updatedAtBlock: 8n,
      updatedAtTimestamp: 80n,
    });
    const state = makeContext({
      pool: poolWithRebalancer(UNKNOWN_STRATEGY.toLowerCase()),
      strategies: [existing],
    });

    await sync(state.context);

    const updated = state.strategies.get(existing.id);
    assert.equal(updated?.kind, "CDP");
    assert.equal(updated?.active, true);
    assert.equal(updated?.addedAtBlock, 7n);
    assert.equal(updated?.addedAtTimestamp, 70n);
    assert.equal(updated?.updatedAtBlock, 20n);
    assert.equal(
      state.poolSets.length,
      0,
      "unchanged pointer is not rewritten",
    );
  });

  it("honors an explicit lifecycle kind even when the pool row is absent", async () => {
    const existing = makeStrategy({ kind: "UNKNOWN" });
    const state = makeContext({ strategies: [existing] });

    await sync(state.context, { explicitKind: "OPEN" });

    assert.equal(state.strategies.get(existing.id)?.kind, "OPEN");
    assert.equal(state.poolSets.length, 0);
  });

  it("restores the newest remaining active strategy when the pointer is removed", async () => {
    const older = makeStrategy({
      strategyAddress: "0x0000000000000000000000000000000000000011",
      id: poolLiquidityStrategyId(
        POOL_ID,
        "0x0000000000000000000000000000000000000011",
      ),
      updatedAtBlock: 40n,
    });
    const newer = makeStrategy({
      strategyAddress: "0x0000000000000000000000000000000000000022",
      id: poolLiquidityStrategyId(
        POOL_ID,
        "0x0000000000000000000000000000000000000022",
      ),
      updatedAtBlock: 50n,
    });
    const inactive = makeStrategy({
      strategyAddress: "0x0000000000000000000000000000000000000033",
      id: poolLiquidityStrategyId(
        POOL_ID,
        "0x0000000000000000000000000000000000000033",
      ),
      active: false,
      updatedAtBlock: 60n,
    });
    const removed = makeStrategy({ updatedAtBlock: 70n });
    const state = makeContext({
      pool: poolWithRebalancer(UNKNOWN_STRATEGY.toUpperCase()),
      strategies: [older, newer, inactive, removed],
    });

    await sync(state.context, { active: false, blockNumber: 80n });

    assert.equal(state.strategies.get(removed.id)?.active, false);
    assert.equal(
      state.pools.get(POOL_ID)?.rebalancerAddress,
      newer.strategyAddress,
    );
    assert.equal(state.pools.get(POOL_ID)?.updatedAtBlock, 80n);
  });

  it("breaks same-block fallback ties deterministically by address", async () => {
    const highAddress = makeStrategy({
      strategyAddress: "0x0000000000000000000000000000000000000099",
      id: poolLiquidityStrategyId(
        POOL_ID,
        "0x0000000000000000000000000000000000000099",
      ),
      updatedAtBlock: 50n,
    });
    const lowAddress = makeStrategy({
      strategyAddress: "0x0000000000000000000000000000000000000011",
      id: poolLiquidityStrategyId(
        POOL_ID,
        "0x0000000000000000000000000000000000000011",
      ),
      updatedAtBlock: 50n,
    });
    const state = makeContext({
      pool: poolWithRebalancer(UNKNOWN_STRATEGY),
      strategies: [highAddress, lowAddress, makeStrategy()],
    });

    await sync(state.context, { active: false });

    assert.equal(
      state.pools.get(POOL_ID)?.rebalancerAddress,
      lowAddress.strategyAddress,
    );
  });

  it("clears the pointer when no other strategy is active", async () => {
    const removed = makeStrategy();
    const state = makeContext({
      pool: poolWithRebalancer(UNKNOWN_STRATEGY),
      strategies: [removed],
    });

    await sync(state.context, { active: false });

    assert.equal(state.pools.get(POOL_ID)?.rebalancerAddress, "");
  });

  it("does not disturb a pointer owned by a different active strategy", async () => {
    const other = "0x00000000000000000000000000000000000000cc";
    const state = makeContext({
      pool: poolWithRebalancer(other),
      strategies: [makeStrategy()],
    });

    await sync(state.context, { active: false });

    assert.equal(state.pools.get(POOL_ID)?.rebalancerAddress, other);
    assert.equal(state.poolSets.length, 0);
  });
});
