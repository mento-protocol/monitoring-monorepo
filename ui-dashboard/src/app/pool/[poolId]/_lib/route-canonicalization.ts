import { isNamespacedPoolId, normalizePoolIdForChain } from "@/lib/pool-id";
import { isValidAddress } from "@/lib/validators";

export function parseRouteChainId(
  value: string | string[] | undefined,
): number | null {
  const chainId = Array.isArray(value) ? value[0] : value;
  if (!chainId || !/^\d+$/.test(chainId)) return null;
  const parsed = Number(chainId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function routeCanonicalPoolId(
  poolId: string,
  chainId: number | null,
): string {
  if (isNamespacedPoolId(poolId)) return poolId.toLowerCase();
  if (isValidAddress(poolId) && chainId !== null) {
    return normalizePoolIdForChain(poolId, chainId);
  }
  return poolId;
}

export function isRoutablePoolId(poolId: string): boolean {
  return isNamespacedPoolId(poolId);
}
