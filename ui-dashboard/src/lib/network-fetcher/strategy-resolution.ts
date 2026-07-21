// Resolves the Open / CDP / Reserve pool-id sets and the strategy-
// classification error channel for `fetchNetworkData`. The active
// PoolLiquidityStrategy registry is authoritative; the older OLS/CDP/RPC
// sources are consulted only while that entity is absent during rollout.

import type { Network } from "@/lib/networks";
import { activeReservePoolIdsFromKnownStrategies } from "@/lib/strategy-contracts";
import { usesRuntimeStrategyProbe } from "@/lib/strategy-probe-scope";
import type { CdpPool, Pool, PoolLiquidityStrategy } from "@/lib/types";
import { toError } from "./errors";
import type { OlsPoolsResult } from "./types";

const INDEXED_CDP_POOL_CHAIN_IDS = new Set([42220]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type CdpPoolsResponse = {
  CdpPool: Pick<CdpPool, "poolId" | "strategyAddress">[];
};

export type ProbedStrategies = {
  cdpPoolIds: Set<string>;
  reservePoolIds: Set<string>;
};

export type ActiveLiquidityStrategyRow = Pick<
  PoolLiquidityStrategy,
  "poolId" | "strategyAddress" | "kind"
>;

export type ActiveLiquidityStrategiesResult = {
  rows: ActiveLiquidityStrategyRow[];
  /**
   * False only during the indexer/Hasura schema-lag window. A successful
   * query, including an empty row set, is authoritative.
   */
  available: boolean;
};

type StrategyIdsArgs = {
  network: Network;
  pools: Pool[];
  activeStrategiesResult: PromiseSettledResult<ActiveLiquidityStrategiesResult>;
  olsResult: PromiseSettledResult<OlsPoolsResult>;
  indexedCdpPoolsResult: PromiseSettledResult<CdpPoolsResponse>;
  fallbackStrategiesResult: PromiseSettledResult<Readonly<ProbedStrategies>>;
};

type StrategyErrorArgs = {
  network: Network;
  activeStrategiesResult: PromiseSettledResult<ActiveLiquidityStrategiesResult>;
  olsResult: PromiseSettledResult<OlsPoolsResult>;
  indexedCdpPoolsResult: PromiseSettledResult<CdpPoolsResponse>;
  fallbackStrategiesResult: PromiseSettledResult<Readonly<ProbedStrategies>>;
};

function emptyStrategyPoolIds(): StrategyPoolIds {
  return {
    olsPoolIds: new Set<string>(),
    cdpPoolIds: new Set<string>(),
    reservePoolIds: new Set<string>(),
  };
}

export type StrategyPoolIds = ProbedStrategies & {
  olsPoolIds: Set<string>;
};

/**
 * Narrow schema-lag detector for the new root entity. Transport failures and
 * unrelated GraphQL validation errors must remain visible as strategyError;
 * only a missing PoolLiquidityStrategy field may use legacy classification.
 */
export function isMissingLiquidityStrategySchemaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /field\s+["']?PoolLiquidityStrategy["']?\s+not found/i.test(message) ||
    /Cannot query field\s+["']?PoolLiquidityStrategy["']?/i.test(message) ||
    /PoolLiquidityStrategy[^\n]*query_root/i.test(message)
  );
}

export function usesIndexedCdpPools(
  network: Pick<Network, "chainId">,
): boolean {
  return INDEXED_CDP_POOL_CHAIN_IDS.has(network.chainId);
}

export function emptyStrategyIds(): ProbedStrategies {
  return {
    cdpPoolIds: new Set<string>(),
    reservePoolIds: new Set<string>(),
  };
}

function hasRebalancerAddress(pool: Pool): boolean {
  const rebalancer = pool.rebalancerAddress;
  return (
    rebalancer !== undefined &&
    /^0x[a-fA-F0-9]{40}$/.test(rebalancer) &&
    rebalancer.toLowerCase() !== ZERO_ADDRESS
  );
}

function activeCdpPoolIdsFromIndexedRows(
  pools: Pool[],
  cdpPools: Pick<CdpPool, "poolId" | "strategyAddress">[],
): Set<string> {
  const activeRebalancerByPoolId = new Map<string, string>();
  for (const pool of pools) {
    if (!hasRebalancerAddress(pool)) continue;
    const rebalancer = pool.rebalancerAddress;
    if (rebalancer === undefined) continue;
    activeRebalancerByPoolId.set(pool.id, rebalancer.toLowerCase());
  }

  const cdpPoolIds = new Set<string>();
  for (const cdpPool of cdpPools) {
    const activeRebalancer = activeRebalancerByPoolId.get(cdpPool.poolId);
    if (activeRebalancer === undefined) continue;
    if (cdpPool.strategyAddress?.toLowerCase() !== activeRebalancer) continue;
    cdpPoolIds.add(cdpPool.poolId);
  }
  return cdpPoolIds;
}

export function resolveStrategyIds({
  network,
  pools,
  activeStrategiesResult,
  olsResult,
  indexedCdpPoolsResult,
  fallbackStrategiesResult,
}: StrategyIdsArgs): StrategyPoolIds {
  if (activeStrategiesResult.status === "rejected") {
    return emptyStrategyPoolIds();
  }
  if (activeStrategiesResult.value.available) {
    return strategyIdsFromRegistry(activeStrategiesResult.value.rows);
  }

  const fallbackStrategies =
    fallbackStrategiesResult.status === "fulfilled"
      ? fallbackStrategiesResult.value
      : emptyStrategyIds();
  const knownReservePoolIds = activeReservePoolIdsFromKnownStrategies(
    network,
    pools,
  );

  if (!usesIndexedCdpPools(network)) {
    return {
      olsPoolIds:
        olsResult.status === "fulfilled"
          ? new Set((olsResult.value.OlsPool ?? []).map((row) => row.poolId))
          : new Set<string>(),
      cdpPoolIds: new Set<string>(),
      reservePoolIds: new Set([
        ...knownReservePoolIds,
        ...fallbackStrategies.reservePoolIds,
      ]),
    };
  }

  const cdpPoolIds =
    indexedCdpPoolsResult.status === "fulfilled"
      ? activeCdpPoolIdsFromIndexedRows(
          pools,
          indexedCdpPoolsResult.value.CdpPool ?? [],
        )
      : new Set<string>();

  return {
    olsPoolIds:
      olsResult.status === "fulfilled"
        ? new Set((olsResult.value.OlsPool ?? []).map((row) => row.poolId))
        : new Set<string>(),
    cdpPoolIds,
    // Indexed Celo has positive CDP rows and canonical contracts-derived
    // Reserve strategy addresses. Unknown active rebalancers stay unbadged
    // instead of being inferred as Reserve from the absence of an OLS/CDP row.
    reservePoolIds: knownReservePoolIds,
  };
}

function strategyIdsFromRegistry(
  rows: ActiveLiquidityStrategyRow[],
): StrategyPoolIds {
  const result = emptyStrategyPoolIds();
  for (const row of rows) {
    if (!row.poolId) continue;
    if (row.kind === "OPEN") result.olsPoolIds.add(row.poolId);
    else if (row.kind === "CDP") result.cdpPoolIds.add(row.poolId);
    else if (row.kind === "RESERVE") result.reservePoolIds.add(row.poolId);
  }
  return result;
}

export function resolveStrategyError({
  network,
  activeStrategiesResult,
  olsResult,
  indexedCdpPoolsResult,
  fallbackStrategiesResult,
}: StrategyErrorArgs): Error | null {
  if (activeStrategiesResult.status === "rejected") {
    return toError(activeStrategiesResult.reason);
  }
  if (activeStrategiesResult.value.available) return null;
  if (olsResult.status === "rejected") return toError(olsResult.reason);
  if (
    usesIndexedCdpPools(network) &&
    indexedCdpPoolsResult.status === "rejected"
  )
    return toError(indexedCdpPoolsResult.reason);
  if (
    usesRuntimeStrategyProbe(network) &&
    fallbackStrategiesResult.status === "rejected"
  )
    return toError(fallbackStrategiesResult.reason);
  return null;
}
