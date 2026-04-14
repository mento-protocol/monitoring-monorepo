"use client";

import useSWR from "swr";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { type RebalanceCheckResult } from "@/lib/rebalance-check";
import { computeHealthStatus } from "@/lib/health";
import { isNamespacedPoolId } from "@/lib/pool-id";

/**
 * Hook that checks whether a rebalance is currently feasible for a pool.
 *
 * Only fires the RPC simulation when ALL of these are true:
 * - Pool is FPMM (not virtual)
 * - Pool has a rebalancer address
 * - Pool health is WARN or CRITICAL (i.e. it needs a rebalance)
 * - Price deviation >= rebalance threshold (actually out of balance)
 *
 * The actual eth_call happens on the server (/api/rebalance-check) so public
 * RPC rate limits are shared across users via a short-lived cache, instead of
 * burned per browser tab. Returns null when the check is skipped (pool is
 * healthy / not applicable).
 */
export function useRebalanceCheck(
  pool: Pool | null,
  network: Network,
): {
  data: RebalanceCheckResult | null;
  isLoading: boolean;
  error: Error | undefined;
} {
  const shouldCheck = shouldRunCheck(pool, network.chainId);
  const key = shouldCheck
    ? `/api/rebalance-check?network=${encodeURIComponent(network.id)}&pool=${encodeURIComponent(poolContractAddress(pool!.id))}&strategy=${encodeURIComponent(pool!.rebalancerAddress!)}`
    : null;

  const { data, error, isLoading } = useSWR<RebalanceCheckResult | null>(
    key,
    fetchRebalanceCheck,
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      dedupingInterval: 15_000,
      shouldRetryOnError: false,
    },
  );

  return {
    data: data ?? null,
    isLoading: shouldCheck && isLoading,
    error,
  };
}

async function fetchRebalanceCheck(url: string): Promise<RebalanceCheckResult> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Rebalance check failed (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as RebalanceCheckResult;
}

// Strip the "{chainId}-" prefix from a namespaced pool ID so the server gets
// a raw 0x address for eth_call. Plain addresses pass through unchanged.
function poolContractAddress(poolId: string): string {
  if (!isNamespacedPoolId(poolId)) return poolId;
  return poolId.split("-").slice(1).join("-");
}

function shouldRunCheck(pool: Pool | null, chainId?: number): boolean {
  if (!pool) return false;
  if (pool.source?.includes("virtual")) return false;
  if (!pool.rebalancerAddress) return false;

  // Pass chainId so chain-aware staleness thresholds are used (e.g. Monad = 360s)
  const health = computeHealthStatus(pool, chainId);
  // WEEKEND = expected oracle staleness during FX market closure, not actionable
  if (health === "OK" || health === "N/A" || health === "WEEKEND") return false;

  // Only check if deviation is at or above threshold (pool actually needs rebalancing).
  // Use the same fallback as computeHealthStatus (10000 bps) when threshold is missing.
  const diff = Number(pool.priceDifference ?? "0");
  const threshold =
    (pool.rebalanceThreshold ?? 0) > 0 ? pool.rebalanceThreshold! : 10000;
  if (diff < threshold) return false;

  return true;
}
