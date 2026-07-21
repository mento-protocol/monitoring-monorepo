import { describe, expect, it } from "vitest";
import {
  isMissingLiquidityStrategySchemaError,
  resolveStrategyError,
  resolveStrategyIds,
  type ActiveLiquidityStrategiesResult,
  type CdpPoolsResponse,
  type ProbedStrategies,
} from "../strategy-resolution";
import {
  CELO_NETWORK,
  makePool,
  MONAD_NETWORK,
} from "./characterization-fixtures";

const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({
  status: "fulfilled",
  value,
});

const rejected = (reason: unknown): PromiseSettledResult<never> => ({
  status: "rejected",
  reason,
});

const emptyCdp = fulfilled<CdpPoolsResponse>({ CdpPool: [] });
const emptyFallback = fulfilled<Readonly<ProbedStrategies>>({
  cdpPoolIds: new Set(),
  reservePoolIds: new Set(),
});

describe("strategy registry resolution", () => {
  it("derives every positive badge from simultaneous active registry kinds", () => {
    const pool = makePool("137-0xpool", { chainId: 137 });
    const activeStrategies = fulfilled<ActiveLiquidityStrategiesResult>({
      available: true,
      rows: [
        { poolId: pool.id, strategyAddress: "0x01", kind: "OPEN" },
        { poolId: pool.id, strategyAddress: "0x02", kind: "CDP" },
        { poolId: pool.id, strategyAddress: "0x03", kind: "RESERVE" },
        { poolId: pool.id, strategyAddress: "0x04", kind: "UNKNOWN" },
      ],
    });

    const result = resolveStrategyIds({
      network: { ...MONAD_NETWORK, chainId: 137 },
      pools: [pool],
      activeStrategiesResult: activeStrategies,
      olsResult: fulfilled({ OlsPool: [] }),
      indexedCdpPoolsResult: emptyCdp,
      fallbackStrategiesResult: emptyFallback,
    });

    expect(result.olsPoolIds).toEqual(new Set([pool.id]));
    expect(result.cdpPoolIds).toEqual(new Set([pool.id]));
    expect(result.reservePoolIds).toEqual(new Set([pool.id]));
  });

  it("treats a successful empty registry as authoritative over legacy rows", () => {
    const rebalancer = "0x00000000000000000000000000000000000000aa";
    const pool = makePool("42220-0xpool", { rebalancerAddress: rebalancer });
    const result = resolveStrategyIds({
      network: CELO_NETWORK,
      pools: [pool],
      activeStrategiesResult: fulfilled({ available: true, rows: [] }),
      olsResult: fulfilled({ OlsPool: [{ poolId: pool.id }] }),
      indexedCdpPoolsResult: fulfilled({
        CdpPool: [{ poolId: pool.id, strategyAddress: rebalancer }],
      }),
      fallbackStrategiesResult: fulfilled({
        cdpPoolIds: new Set([pool.id]),
        reservePoolIds: new Set([pool.id]),
      }),
    });

    expect(result).toEqual({
      olsPoolIds: new Set(),
      cdpPoolIds: new Set(),
      reservePoolIds: new Set(),
    });
  });

  it("uses the legacy sources only when the registry schema is unavailable", () => {
    const rebalancer = "0x00000000000000000000000000000000000000aa";
    const pool = makePool("42220-0xpool", { rebalancerAddress: rebalancer });
    const result = resolveStrategyIds({
      network: CELO_NETWORK,
      pools: [pool],
      activeStrategiesResult: fulfilled({ available: false, rows: [] }),
      olsResult: fulfilled({ OlsPool: [{ poolId: pool.id }] }),
      indexedCdpPoolsResult: fulfilled({
        CdpPool: [{ poolId: pool.id, strategyAddress: rebalancer }],
      }),
      fallbackStrategiesResult: emptyFallback,
    });

    expect(result.olsPoolIds).toEqual(new Set([pool.id]));
    expect(result.cdpPoolIds).toEqual(new Set([pool.id]));
  });

  it("keeps all badge sets empty and surfaces a registry transport error", () => {
    const error = new Error("connection reset");
    const args = {
      network: CELO_NETWORK,
      activeStrategiesResult: rejected(error),
      olsResult: fulfilled({ OlsPool: [{ poolId: "legacy" }] }),
      indexedCdpPoolsResult: emptyCdp,
      fallbackStrategiesResult: emptyFallback,
    };

    expect(
      resolveStrategyIds({ ...args, pools: [makePool("42220-0xpool")] }),
    ).toEqual({
      olsPoolIds: new Set(),
      cdpPoolIds: new Set(),
      reservePoolIds: new Set(),
    });
    expect(resolveStrategyError(args)).toBe(error);
  });

  it("only classifies PoolLiquidityStrategy validation failures as schema lag", () => {
    expect(
      isMissingLiquidityStrategySchemaError(
        new Error(
          "field 'PoolLiquidityStrategy' not found in type: 'query_root'",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingLiquidityStrategySchemaError(
        new Error('Cannot query field "PoolLiquidityStrategy" on type Query'),
      ),
    ).toBe(true);
    expect(
      isMissingLiquidityStrategySchemaError(new Error("fetch failed")),
    ).toBe(false);
    expect(
      isMissingLiquidityStrategySchemaError(
        new Error("field 'unrelated' not found in type: 'Pool'"),
      ),
    ).toBe(false);
  });
});
