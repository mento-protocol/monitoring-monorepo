import { isConfiguredNetworkId, networkIdForChainId } from "@/lib/networks";
import {
  extractChainIdFromPoolId,
  isNamespacedPoolId,
  normalizePoolIdForChain,
  stripChainIdFromPoolId,
} from "@/lib/pool-id";
import { isValidAddress } from "@/lib/validators";

function isRoutableChainId(chainId: number): boolean {
  const networkId = networkIdForChainId(chainId);
  return networkId !== null && isConfiguredNetworkId(networkId);
}

export function parseRouteChainId(
  value: string | string[] | undefined,
): number | null {
  const chainId = Array.isArray(value) ? value[0] : value;
  if (!chainId || !/^\d+$/.test(chainId)) return null;
  const parsed = Number(chainId);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return isRoutableChainId(parsed) ? parsed : null;
}

export function routeCanonicalPoolId(
  poolId: string,
  chainId: number | null,
): string {
  if (isNamespacedPoolId(poolId)) {
    const routeChainId = extractChainIdFromPoolId(poolId);
    if (routeChainId !== null) {
      return normalizePoolIdForChain(
        stripChainIdFromPoolId(poolId),
        routeChainId,
      );
    }
    return poolId.toLowerCase();
  }
  if (isValidAddress(poolId) && chainId !== null) {
    return normalizePoolIdForChain(poolId, chainId);
  }
  return poolId;
}

export function isRoutablePoolId(poolId: string): boolean {
  const chainId = extractChainIdFromPoolId(poolId);
  return chainId !== null && isRoutableChainId(chainId);
}
