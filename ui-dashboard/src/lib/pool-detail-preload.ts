import { preloadGQL } from "@/lib/graphql";
import { normalizePoolIdForChain } from "@/lib/format";
import {
  configuredNetworkIdForChainId,
  NETWORKS,
  type Network,
} from "@/lib/networks";
import {
  POOL_DETAIL_WITH_HEALTH,
  type PoolDetailResponse,
} from "@/lib/queries";

export function preloadPoolDetail(network: Network, id: string): void {
  // Pool routes resolve their NetworkProvider from the pool's chain ID. Mirror
  // that configured-only resolution here so the speculative SWR key and the
  // request endpoint are the ones the destination consumes after navigation.
  // The caller's network remains the fallback for an otherwise unroutable
  // chain and can still be used independently for row display metadata.
  const routeNetworkId = configuredNetworkIdForChainId(network.chainId);
  const routeNetwork = routeNetworkId ? NETWORKS[routeNetworkId] : network;
  const normalizedId = normalizePoolIdForChain(id, routeNetwork.chainId);
  preloadGQL<PoolDetailResponse>(routeNetwork, POOL_DETAIL_WITH_HEALTH, {
    id: normalizedId,
    chainId: routeNetwork.chainId,
  });
}
