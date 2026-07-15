import { preloadGQL } from "@/lib/graphql";
import { normalizePoolIdForChain } from "@/lib/format";
import type { Network } from "@/lib/networks";
import {
  POOL_DETAIL_WITH_HEALTH,
  type PoolDetailResponse,
} from "@/lib/queries";

export function preloadPoolDetail(network: Network, id: string): void {
  const normalizedId = normalizePoolIdForChain(id, network.chainId);
  preloadGQL<PoolDetailResponse>(network, POOL_DETAIL_WITH_HEALTH, {
    id: normalizedId,
    chainId: network.chainId,
  });
}
