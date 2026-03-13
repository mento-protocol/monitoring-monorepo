"use client";

import useSWR from "swr";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import {
  checkRebalanceStatus,
  type RebalanceCheckResult,
} from "@/lib/rebalance-check";
import { computeHealthStatus } from "@/lib/health";

/**
 * Hook that checks whether a rebalance is currently feasible for a pool.
 *
 * Only fires the RPC simulation when ALL of these are true:
 * - Pool is FPMM (not virtual)
 * - Pool has a rebalancer address
 * - Pool health is WARN or CRITICAL (i.e. it needs a rebalance)
 * - Price deviation >= rebalance threshold (actually out of balance)
 *
 * Returns null when the check is skipped (pool is healthy / not applicable).
 */
export function useRebalanceCheck(
  pool: Pool | null,
  network: Network,
): {
  data: RebalanceCheckResult | null;
  isLoading: boolean;
  error: Error | undefined;
} {
  const shouldCheck = shouldRunCheck(pool) && !!network.rpcUrl;
  const key = shouldCheck
    ? `rebalance-check:${network.id}:${pool!.id}:${pool!.rebalancerAddress}`
    : null;

  const { data, error, isLoading } = useSWR<RebalanceCheckResult | null>(
    key,
    () =>
      checkRebalanceStatus(pool!.id, pool!.rebalancerAddress!, network.rpcUrl!),
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

function shouldRunCheck(pool: Pool | null): boolean {
  if (!pool) return false;
  if (pool.source?.includes("virtual")) return false;
  if (!pool.rebalancerAddress) return false;

  const health = computeHealthStatus(pool);
  if (health === "OK" || health === "N/A") return false;

  // Only check if deviation is at or above threshold (pool actually needs rebalancing)
  const diff = Number(pool.priceDifference ?? "0");
  const threshold = pool.rebalanceThreshold ?? 0;
  if (threshold <= 0 || diff < threshold) return false;

  return true;
}
