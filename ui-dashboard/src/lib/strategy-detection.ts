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
 * Fail-open policy: on RPC errors the affected pools stay out of the
 * returned sets rather than being defaulted to Reserve. Consumers should
 * treat absence from both sets as "strategy detection unavailable" and
 * avoid rendering a confident badge — see `poolStrategies()` in
 * `global-pools-table.tsx` for the UI contract.
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

// Sentry throttle: without this, a 30s poll loop × N rebalancers × M flaky
// networks would fan out to the same captureException on every cycle and
// burn quota fast. Mirrors the per-request throttle already used for
// partial-page snapshot failures in `fetch-all-networks.ts`.
/** @internal Exported so tests can advance fake timers past the window. */
export const SENTRY_THROTTLE_MS = 60_000;

const strategyTypeCache = new Map<string, CacheEntry>();
/** @internal Exported for test-scope `.clear()`. */
export const sentryLastCapturedAt = new Map<string, number>();

// Cache key includes `network.id` (not just `chainId`) because multiple
// configured networks can share a chainId with different RPC backends
// (e.g. `devnet` and `celo-mainnet` both map to 42220). Without this,
// enabling the local variant alongside prod would reuse classifications
// from whichever probed first, silently crossing deployment boundaries.
const cacheKey = (networkId: string, rebalancer: string): string =>
  `${networkId}:${rebalancer.toLowerCase()}`;

export function clearStrategyTypeCache(): void {
  strategyTypeCache.clear();
  sentryLastCapturedAt.clear();
}

function readCached(
  networkId: string,
  rebalancer: string,
): StrategyType | undefined {
  const entry = strategyTypeCache.get(cacheKey(networkId, rebalancer));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    strategyTypeCache.delete(cacheKey(networkId, rebalancer));
    return undefined;
  }
  return entry.type;
}

function writeCached(
  networkId: string,
  rebalancer: string,
  type: StrategyType,
): void {
  // Evict the oldest entry when full. Iteration order on Map is insertion
  // order, so the first key is effectively the coldest write.
  if (strategyTypeCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = strategyTypeCache.keys().next().value;
    if (oldest !== undefined) strategyTypeCache.delete(oldest);
  }
  strategyTypeCache.set(cacheKey(networkId, rebalancer), {
    type,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function captureProbeFailure(
  networkId: string,
  rebalancer: string,
  err: unknown,
): void {
  const key = `${networkId}:${rebalancer}`;
  const now = Date.now();
  const last = sentryLastCapturedAt.get(key) ?? 0;
  if (now - last < SENTRY_THROTTLE_MS) return;
  // Same soft-cap + insertion-order LRU as `strategyTypeCache`: a stream
  // of distinct failing (network, rebalancer) keys would otherwise grow
  // the map without bound in a long-lived process.
  if (sentryLastCapturedAt.size >= MAX_CACHE_ENTRIES) {
    const oldest = sentryLastCapturedAt.keys().next().value;
    if (oldest !== undefined) sentryLastCapturedAt.delete(oldest);
  }
  sentryLastCapturedAt.set(key, now);
  Sentry.captureException(err, {
    tags: {
      source: "strategy-detection",
      network: networkId,
      rebalancer,
    },
  });
}

/**
 * Strategy classifications derived from RPC probes, one Set per positively
 * identified type. A pool appearing in neither set means either:
 *   - it has no `rebalancerAddress` (no strategy attached), or
 *   - its probe errored (transport failure) or hit the timeout.
 *
 * Consumers MUST NOT default "not in either set" to "Reserve" — see the
 * module docblock for the rationale.
 */
export type ProbedStrategies = {
  cdpPoolIds: Set<string>;
  reservePoolIds: Set<string>;
};

// Frozen shared singleton for early-exit paths. Mutating the inner Sets
// would leak state across callers; `Object.freeze` forbids reassignment
// of the wrapper and documents the intent at zero runtime cost.
const EMPTY_STRATEGIES: Readonly<ProbedStrategies> = Object.freeze({
  cdpPoolIds: new Set<string>(),
  reservePoolIds: new Set<string>(),
});

/**
 * Probe every unique rebalancer contract referenced by `pools` and return
 * positive identifications only. Pools whose probe errored, timed out, or
 * returned `"unknown"` are deliberately absent from both sets so the UI
 * can render an "unavailable" state rather than a confident mis-badge.
 */
export async function detectProbedStrategies(
  network: Network,
  pools: Pool[],
): Promise<Readonly<ProbedStrategies>> {
  if (!network.rpcUrl) return EMPTY_STRATEGIES;

  const poolsByRebalancer = new Map<string, Pool[]>();
  for (const pool of pools) {
    const rebalancer = pool.rebalancerAddress;
    // `isAddress` rejects empty strings, non-hex, and wrong-length input so
    // garbage never reaches viem's RPC layer or the cache key. (Note: the
    // zero address passes this check — it would fall through to the RPC
    // probe and classify as "unknown" via revert, which is fine.)
    if (!rebalancer || !isAddress(rebalancer)) continue;
    const key = rebalancer.toLowerCase();
    const arr = poolsByRebalancer.get(key);
    if (arr) arr.push(pool);
    else poolsByRebalancer.set(key, [pool]);
  }

  if (poolsByRebalancer.size === 0) return EMPTY_STRATEGIES;

  const client = getViemClient(network.rpcUrl);
  const typeByRebalancer = new Map<string, StrategyType>();

  await Promise.all(
    Array.from(poolsByRebalancer.entries()).map(async ([rebalancer, group]) => {
      const cached = readCached(network.id, rebalancer);
      if (cached !== undefined) {
        typeByRebalancer.set(rebalancer, cached);
        return;
      }
      // A Pool.id is "{chainId}-{poolAddress}" — the RPC probe needs only
      // the address half. Any pool in the group works since getCDPConfig
      // takes the pool address purely as a CDP-specific ABI selector.
      const samplePoolAddress = group[0].id.split("-")[1];
      if (!samplePoolAddress || !isAddress(samplePoolAddress)) return;
      // Track the timeout so we can cancel it if the probe wins the race.
      // Without `clearTimeout` the timer keeps the event loop alive in a
      // long-running Node process (e.g. dev server) on every cache-miss.
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const type = await Promise.race([
          detectStrategyType(
            client,
            rebalancer as `0x${string}`,
            samplePoolAddress,
          ),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("strategy-detection: probe timed out")),
              PROBE_TIMEOUT_MS,
            );
          }),
        ]);
        writeCached(network.id, rebalancer, type);
        typeByRebalancer.set(rebalancer, type);
      } catch (err) {
        // `detectStrategyType` already handles contract-level reverts
        // internally (returning "unknown"), so any error reaching this
        // catch is a transport failure — network, 401, CORS, or timeout.
        // Throttled capture so a persistently flaky RPC can't fan out to
        // Sentry on every 30s poll cycle. Fail open at the per-rebalancer
        // level: other rebalancers keep probing; the affected pools simply
        // stay out of both returned sets so the UI renders "unavailable"
        // rather than a misleading Reserve badge.
        captureProbeFailure(network.id, rebalancer, err);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }),
  );

  const cdpPoolIds = new Set<string>();
  const reservePoolIds = new Set<string>();
  for (const [rebalancer, group] of poolsByRebalancer) {
    const type = typeByRebalancer.get(rebalancer);
    if (type === "cdp") {
      for (const pool of group) cdpPoolIds.add(pool.id);
    } else if (type === "reserve") {
      for (const pool of group) reservePoolIds.add(pool.id);
    }
    // "ols" is tracked by the indexer's OlsPool entity (authoritative) and
    // "unknown" / absent = probe failed → leave out of both sets.
  }
  return { cdpPoolIds, reservePoolIds };
}
