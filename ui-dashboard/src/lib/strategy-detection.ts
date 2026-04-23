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
 *
 * TODO(cdp-indexer): move CDP strategy tracking into the indexer, parallel
 * to the `OlsPool` entity in `indexer-envio/schema.graphql`. That lets the
 * dashboard derive `cdpPoolIds` from a single GraphQL query (same as OLS)
 * and removes the runtime RPC dependency this module introduces. Until
 * that lands, this is a UI-layer stopgap.
 */

import * as Sentry from "@sentry/nextjs";
import { isAddress } from "viem";
import { detectStrategyType, type StrategyType } from "@/lib/rebalance-check";
import type { Network } from "@/lib/networks";
import { getViemClient } from "@/lib/rpc-client";
import type { Pool } from "@/lib/types";

type CacheEntry = {
  type: StrategyType;
  expiresAt: number;
};

const CACHE_TTL_MS = 60 * 60 * 1000;

// Soft cap so a malformed indexer response (thousands of distinct bogus
// rebalancer strings) can't grow the Map without bound across the TTL
// window. Scale in practice is ~3 unique strategy contracts per chain —
// 256 leaves ample headroom while keeping the per-process footprint tiny.
const MAX_CACHE_ENTRIES = 256;

// Per-rebalancer probe budget. `fetch-all-networks.ts` gives every request
// ~5s total, and detection runs alongside the other GraphQL queries there.
// Viem's http() default timeout is 10s, which would blow the outer budget
// on the first wedged RPC, so we cap each probe chain here to a fraction.
const PROBE_TIMEOUT_MS = 3000;

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
  // Evict the oldest entry when full. Iteration order on Map is insertion
  // order, so the first key is effectively the coldest write.
  if (strategyTypeCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = strategyTypeCache.keys().next().value;
    if (oldest !== undefined) strategyTypeCache.delete(oldest);
  }
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
    // `isAddress` rejects empty strings, non-hex, wrong-length, and the
    // zero address (via checksum validation). Treat anything malformed as
    // "no strategy attached" rather than letting garbage reach viem's RPC
    // layer or the cache key.
    if (!rebalancer || !isAddress(rebalancer)) continue;
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
      if (!samplePoolAddress || !isAddress(samplePoolAddress)) return;
      try {
        const type = await Promise.race([
          detectStrategyType(
            client,
            rebalancer as `0x${string}`,
            samplePoolAddress,
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("strategy-detection: probe timed out")),
              PROBE_TIMEOUT_MS,
            ),
          ),
        ]);
        writeCached(network.chainId, rebalancer, type);
        typeByRebalancer.set(rebalancer, type);
      } catch (err) {
        // `detectStrategyType` already handles contract-level reverts
        // internally (returning "unknown"), so any error reaching this
        // catch is a transport failure — network, 401, CORS, or timeout.
        // Log to Sentry for visibility, then fail open at the per-rebalancer
        // level: other rebalancers in this network continue probing and
        // the affected pools just stay on the "Reserve" fallback until the
        // next successful poll.
        //
        // We deliberately do NOT re-throw. Throwing would reject the
        // surrounding `Promise.all`, which would blank out `cdpPoolIds`
        // for the entire network — degrading every CDP pool to "Reserve"
        // over a single rebalancer's transport hiccup. The narrower
        // per-rebalancer swallow keeps the blast radius tight.
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
