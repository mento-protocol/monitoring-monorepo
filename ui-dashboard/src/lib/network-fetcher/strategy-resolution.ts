// Resolves the CDP / Reserve pool-id sets and the strategy-classification
// error channel for `fetchNetworkData`. Isolated so schema-lag on the
// indexed CdpPool query, or a failed runtime strategy probe, degrades
// badges without failing the main pool list.

import type { Network } from "@/lib/networks";
import { activeReservePoolIdsFromKnownStrategies } from "@/lib/strategy-contracts";
import { usesRuntimeStrategyProbe } from "@/lib/strategy-probe-scope";
import type { CdpPool, Pool } from "@/lib/types";
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

type StrategyIdsArgs = {
  network: Network;
  pools: Pool[];
  indexedCdpPoolsResult: PromiseSettledResult<CdpPoolsResponse>;
  fallbackStrategiesResult: PromiseSettledResult<Readonly<ProbedStrategies>>;
};

type StrategyErrorArgs = {
  network: Network;
  olsResult: PromiseSettledResult<OlsPoolsResult>;
  indexedCdpPoolsResult: PromiseSettledResult<CdpPoolsResponse>;
  fallbackStrategiesResult: PromiseSettledResult<Readonly<ProbedStrategies>>;
};

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
  indexedCdpPoolsResult,
  fallbackStrategiesResult,
}: StrategyIdsArgs): ProbedStrategies {
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
    cdpPoolIds,
    // Indexed Celo has positive CDP rows and canonical contracts-derived
    // Reserve strategy addresses. Unknown active rebalancers stay unbadged
    // instead of being inferred as Reserve from the absence of an OLS/CDP row.
    reservePoolIds: knownReservePoolIds,
  };
}

export function resolveStrategyError({
  network,
  olsResult,
  indexedCdpPoolsResult,
  fallbackStrategiesResult,
}: StrategyErrorArgs): Error | null {
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
