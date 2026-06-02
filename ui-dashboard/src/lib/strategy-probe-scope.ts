import type { Network } from "@/lib/networks";

// Runtime probes are only a fallback for positive non-CDP strategy labels.
// CDP badges are Celo-only and come from indexed CdpPool rows.
const RUNTIME_STRATEGY_PROBE_CHAIN_IDS = new Set([143]);

export function usesRuntimeStrategyProbe(
  network: Pick<Network, "chainId">,
): boolean {
  return RUNTIME_STRATEGY_PROBE_CHAIN_IDS.has(network.chainId);
}
