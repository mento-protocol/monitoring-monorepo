import type { Network } from "@/lib/networks";

const RUNTIME_STRATEGY_PROBE_CHAIN_IDS = new Set([143]);

export function usesRuntimeStrategyProbe(
  network: Pick<Network, "chainId">,
): boolean {
  return RUNTIME_STRATEGY_PROBE_CHAIN_IDS.has(network.chainId);
}
