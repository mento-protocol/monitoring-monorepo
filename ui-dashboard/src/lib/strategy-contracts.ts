import { contractEntries } from "@mento-protocol/monitoring-config/tokens";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

const RESERVE_LIQUIDITY_STRATEGY_PREFIX = "ReserveLiquidityStrategy";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const reserveStrategyAddressCache = new Map<number, Set<string>>();

function reserveStrategyAddresses(chainId: number): Set<string> {
  const cached = reserveStrategyAddressCache.get(chainId);
  if (cached !== undefined) return new Set(cached);

  const addresses = new Set<string>();
  for (const entry of contractEntries(chainId)) {
    if (
      entry.type === "contract" &&
      entry.rawName.startsWith(RESERVE_LIQUIDITY_STRATEGY_PREFIX)
    ) {
      addresses.add(entry.address.toLowerCase());
    }
  }

  reserveStrategyAddressCache.set(chainId, addresses);
  return new Set(addresses);
}

function activeRebalancerAddress(pool: Pool): string | null {
  const rebalancer = pool.rebalancerAddress;
  if (
    rebalancer === undefined ||
    !/^0x[a-fA-F0-9]{40}$/.test(rebalancer) ||
    rebalancer.toLowerCase() === ZERO_ADDRESS
  ) {
    return null;
  }
  return rebalancer.toLowerCase();
}

export function activeReservePoolIdsFromKnownStrategies(
  network: Pick<Network, "chainId">,
  pools: Pool[],
): Set<string> {
  const reserveStrategies = reserveStrategyAddresses(network.chainId);
  if (reserveStrategies.size === 0) return new Set<string>();

  const reservePoolIds = new Set<string>();
  for (const pool of pools) {
    const rebalancer = activeRebalancerAddress(pool);
    if (rebalancer !== null && reserveStrategies.has(rebalancer)) {
      reservePoolIds.add(pool.id);
    }
  }
  return reservePoolIds;
}
