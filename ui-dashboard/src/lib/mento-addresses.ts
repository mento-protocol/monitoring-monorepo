// Swap classification — derived from @mento-protocol/contracts (single source of truth)
// Chain IDs: Celo Mainnet=42220, Celo Sepolia=11142220, Monad Mainnet=143, Monad Testnet=10143

import contractsData from "@mento-protocol/contracts/contracts.json";
import DEPLOYMENT_NAMESPACES from "@mento-protocol/monitoring-config/deployment-namespaces.json";

type ContractEntry = { address: string };
type ContractsJson = Record<
  string,
  Record<string, Record<string, ContractEntry>>
>;

const CHAIN_NAMESPACES: Record<number, string> = {
  42220: DEPLOYMENT_NAMESPACES["42220"],
  11142220: DEPLOYMENT_NAMESPACES["11142220"],
  143: DEPLOYMENT_NAMESPACES["143"],
  10143: DEPLOYMENT_NAMESPACES["10143"],
};

function getContractsByName(
  chainId: number,
  namePredicate: (name: string) => boolean,
): Set<string> {
  const ns = CHAIN_NAMESPACES[chainId];
  if (!ns) return new Set();
  const contracts =
    (contractsData as ContractsJson)[String(chainId)]?.[ns] ?? {};
  return new Set(
    Object.entries(contracts)
      .filter(([name]) => namePredicate(name))
      .map(([, entry]) => entry.address.toLowerCase()),
  );
}

const ROUTER_NAME = (name: string) =>
  name === "Router" || name === "MentoRouter" || name === "Routerv300";

const STRATEGY_NAME = (name: string) =>
  name.includes("Strategy") || name.includes("LiquidityStrategy");

function buildAddressMap(
  namePredicate: (name: string) => boolean,
): Record<number, Set<string>> {
  return Object.fromEntries(
    Object.keys(CHAIN_NAMESPACES).map((id) => [
      Number(id),
      getContractsByName(Number(id), namePredicate),
    ]),
  );
}

export const ROUTER_ADDRESSES: Record<number, Set<string>> = buildAddressMap(
  ROUTER_NAME,
);

export const STRATEGY_ADDRESSES: Record<number, Set<string>> = buildAddressMap(
  STRATEGY_NAME,
);

export type SwapKind = "trade" | "lp_swap" | "direct";

export function classifySwap(sender: string, chainId: number): SwapKind {
  const s = sender.toLowerCase();
  if (ROUTER_ADDRESSES[chainId]?.has(s)) return "trade";
  if (STRATEGY_ADDRESSES[chainId]?.has(s)) return "lp_swap";
  return "direct";
}

export function isTradeSwap(kind: SwapKind): boolean {
  return kind !== "lp_swap";
}
