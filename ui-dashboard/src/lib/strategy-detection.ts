/**
 * Batch strategy-type detection for the global pools table.
 *
 * The indexer tracks OLS registrations in a dedicated entity, but CDP pools
 * are indistinguishable from Reserve pools at the GraphQL layer — both just
 * expose `rebalancerAddress`. To surface the "CDP" strategy badge we probe
 * each unique rebalancer contract via RPC using the same detection logic as
 * `rebalance-check.ts` (getCDPConfig / reserve / getPools selector probes).
 *
 * Probes are grouped by unique rebalancer address and cached at module scope
 * so the cost amortizes to ~1 RPC call per deployed strategy contract per
 * TTL window, regardless of how many pools use it.
 */

import * as Sentry from "@sentry/nextjs";
import { detectStrategyType, type StrategyType } from "@/lib/rebalance-check";
import type { Network } from "@/lib/networks";
import { getViemClient } from "@/lib/rpc-client";
import type { Pool } from "@/lib/types";

type CacheEntry = {
  type: StrategyType;
  expiresAt: number;
};

const CACHE_TTL_MS = 60 * 60 * 1000;

const strategyTypeCache = new Map<string, CacheEntry>();

const cacheKey = (chainId: number, rebalancer: string): string =>
  `${chainId}:${rebalancer.toLowerCase()}`;

export function clearStrategyTypeCache(): void {
  strategyTypeCache.clear();
}

function readCached(
  chainId: number,
  rebalancer: string,
): StrategyType | undefined {
  const entry = strategyTypeCache.get(cacheKey(chainId, rebalancer));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    strategyTypeCache.delete(cacheKey(chainId, rebalancer));
    return undefined;
  }
  return entry.type;
}

function writeCached(
  chainId: number,
  rebalancer: string,
  type: StrategyType,
): void {
  strategyTypeCache.set(cacheKey(chainId, rebalancer), {
    type,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Detect pools whose rebalancer contract is a CDPLiquidityStrategy.
 *
 * Returns the subset of `poolIds` (matching `Pool.id`) that use a CDP
 * strategy. Pools without a rebalancer are skipped. Fails open: on RPC
 * errors (network down, missing env var, …) the returned set stays empty
 * so the pools page still renders — the badge just won't appear until
 * the next poll succeeds.
 */
export async function detectCdpPoolIds(
  network: Network,
  pools: Pool[],
): Promise<Set<string>> {
  if (!network.rpcUrl) return new Set();

  const poolsByRebalancer = new Map<string, Pool[]>();
  for (const pool of pools) {
    const rebalancer = pool.rebalancerAddress;
    if (!rebalancer || rebalancer === "") continue;
    const key = rebalancer.toLowerCase();
    const arr = poolsByRebalancer.get(key);
    if (arr) arr.push(pool);
    else poolsByRebalancer.set(key, [pool]);
  }

  if (poolsByRebalancer.size === 0) return new Set();

  const client = getViemClient(network.rpcUrl);
  const typeByRebalancer = new Map<string, StrategyType>();

  await Promise.all(
    Array.from(poolsByRebalancer.entries()).map(async ([rebalancer, group]) => {
      const cached = readCached(network.chainId, rebalancer);
      if (cached !== undefined) {
        typeByRebalancer.set(rebalancer, cached);
        return;
      }
      // A Pool.id is "{chainId}-{poolAddress}" — the RPC probe needs only
      // the address half. Any pool in the group works since getCDPConfig
      // takes the pool address purely as a CDP-specific ABI selector.
      const samplePoolAddress = group[0].id.split("-")[1];
      try {
        const type = await detectStrategyType(
          client,
          rebalancer as `0x${string}`,
          samplePoolAddress as `0x${string}`,
        );
        writeCached(network.chainId, rebalancer, type);
        typeByRebalancer.set(rebalancer, type);
      } catch (err) {
        Sentry.captureException(err, {
          tags: {
            source: "strategy-detection",
            network: network.id,
            rebalancer,
          },
        });
      }
    }),
  );

  const cdpPoolIds = new Set<string>();
  for (const [rebalancer, group] of poolsByRebalancer) {
    if (typeByRebalancer.get(rebalancer) !== "cdp") continue;
    for (const pool of group) cdpPoolIds.add(pool.id);
  }
  return cdpPoolIds;
}
