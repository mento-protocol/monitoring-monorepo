import { isNamespacedPoolId } from "@/lib/pool-id";
import { isValidAddress } from "@/lib/validators";

export function routeCanonicalPoolId(poolId: string): string {
  if (isNamespacedPoolId(poolId) || isValidAddress(poolId)) {
    return poolId.toLowerCase();
  }
  return poolId;
}

export function isRoutablePoolId(poolId: string): boolean {
  return isNamespacedPoolId(poolId) || isValidAddress(poolId);
}
