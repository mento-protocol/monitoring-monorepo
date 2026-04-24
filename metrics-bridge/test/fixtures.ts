import type { Registry } from "prom-client";
import type { PoolRow, BridgePoolsResponse } from "../src/types.js";

export function makePool(overrides: Partial<PoolRow> = {}): PoolRow {
  return {
    // Default pool: GBPm/USDm on Celo mainnet. token0/token1 are the real
    // contract addresses so `poolName()` derives the same label
    // ("GBPm/USDm") the old hand-rolled POOL_PAIR_LABELS map produced.
    id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
    chainId: 42220,
    token0: "0x765de816845861e75a25fca122bb6898b8b1282a",
    token1: "0xccf663b1ff11028f0b19058d0f7b674004a40746",
    source: "fpmm_factory",
    healthStatus: "OK",
    oracleOk: true,
    oracleTimestamp: "1713200000",
    oracleExpiry: "300",
    lastDeviationRatio: "0.420000",
    deviationBreachStartedAt: "0",
    limitStatus: "OK",
    limitPressure0: "0.1230",
    limitPressure1: "0.0050",
    lastRebalancedAt: "1713199000",
    lastEffectivenessRatio: "0.5000",
    rebalanceLivenessStatus: "ACTIVE",
    hasHealthData: true,
    lpFee: 5,
    protocolFee: 5,
    lastOracleJumpBps: "3.0000",
    lastOracleJumpAt: "1713200000",
    ...overrides,
  };
}

export function makePoolResponse(
  pools: PoolRow[] = [makePool()],
): BridgePoolsResponse {
  return { Pool: pools };
}

export async function getGaugeValue(
  reg: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const metrics = await reg.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === name);
  if (!metric || !("values" in metric)) return undefined;
  const values = metric.values as Array<{
    labels: Record<string, string>;
    value: number;
  }>;
  if (Object.keys(labels).length === 0) return values[0]?.value;
  return values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  )?.value;
}

export const tick = () => new Promise((r) => setTimeout(r, 10));
