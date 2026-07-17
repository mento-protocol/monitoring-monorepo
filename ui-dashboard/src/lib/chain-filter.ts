import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type Network,
} from "@/lib/networks";

export type ChainFilterOption = Pick<Network, "chainId" | "label">;
export type ChainFilterValue = number | null;

export function chainFilterOptions(
  networks: readonly Network[],
): ChainFilterOption[] {
  const seen = new Set<number>();
  const options: ChainFilterOption[] = [];
  for (const network of networks) {
    if (network.local || network.testnet || seen.has(network.chainId)) continue;
    seen.add(network.chainId);
    options.push({ chainId: network.chainId, label: network.label });
  }
  return options;
}

export function configuredProductionChainOptions(): ChainFilterOption[] {
  return chainFilterOptions(
    NETWORK_IDS.filter(isConfiguredNetworkId).map((id) => NETWORKS[id]),
  );
}

export function availableProductionChainOptions(
  networks: readonly Network[],
): ChainFilterOption[] {
  const loaded = chainFilterOptions(networks);
  return loaded.length > 0 ? loaded : configuredProductionChainOptions();
}

export function readChainFilter(
  params: Pick<URLSearchParams, "get">,
  options: readonly ChainFilterOption[],
): ChainFilterValue {
  const raw = params.get("chain");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const chainId = Number(raw);
  return options.some((option) => option.chainId === chainId) ? chainId : null;
}

export function activeChainIds(
  chainId: ChainFilterValue,
  options: readonly ChainFilterOption[],
): number[] {
  return chainId === null ? options.map((option) => option.chainId) : [chainId];
}

export function writeChainFilterParam(
  params: URLSearchParams,
  chainId: ChainFilterValue,
): void {
  if (chainId === null) params.delete("chain");
  else params.set("chain", String(chainId));
}
