/**
 * Per-chain viem PublicClient cache for the rebalance-reason probe.
 *
 * The metrics-bridge process probes the FPMM rebalance pipeline via
 * `eth_call`, which is NOT supported by Envio's HyperRPC — every chain must
 * resolve to a full-node RPC (forno.celo.org, rpc2.monad.xyz, etc.).
 * Mirrors the constraint documented in
 * `indexer-envio/src/rpc.ts:286-301` ("Defaults MUST be full-node RPCs").
 *
 * RPC URL resolution per chain:
 *   1. `RPC_URL_<chainId>` env var (per-chain override)
 *   2. Hardcoded full-node default
 */

import { createPublicClient, http, type PublicClient } from "viem";

type RpcConfig = { default: string; envVar: string };

/**
 * Defaults intentionally point at full-node RPCs. HyperRPC endpoints
 * (`*.rpc.hypersync.xyz`) do NOT serve `eth_call` and will fail every probe.
 * Add new chains here AND in `RPC_URL_<chainId>` env-var docs.
 */
const RPC_CONFIG_BY_CHAIN: Record<number, RpcConfig> = {
  42220: { default: "https://forno.celo.org", envVar: "RPC_URL_42220" },
  11142220: {
    default: "https://forno.celo-sepolia.celo-testnet.org",
    envVar: "RPC_URL_11142220",
  },
  143: { default: "https://rpc2.monad.xyz", envVar: "RPC_URL_143" },
  10143: {
    default: "https://10143.rpc.hypersync.xyz",
    envVar: "RPC_URL_10143",
  },
};

const clientCache = new Map<number, PublicClient>();
const warnedUnknownChains = new Set<number>();

/**
 * Returns a viem PublicClient for the given chain, or `null` if the chain
 * isn't known to metrics-bridge yet. Caller should treat null as "skip
 * probe for this pool" — never as an error.
 *
 * Logs once per unknown chain so a missing entry is visible in Cloud Run
 * logs without spamming on every poll cycle.
 */
export function getRpcClient(chainId: number): PublicClient | null {
  const cached = clientCache.get(chainId);
  if (cached) return cached;

  const config = RPC_CONFIG_BY_CHAIN[chainId];
  if (!config) {
    if (!warnedUnknownChains.has(chainId)) {
      warnedUnknownChains.add(chainId);
      console.warn(
        `[metrics-bridge] no RPC config for chainId=${chainId}; rebalance probe disabled for this chain. Add an entry to RPC_CONFIG_BY_CHAIN in metrics-bridge/src/rpc.ts.`,
      );
    }
    return null;
  }

  const url = process.env[config.envVar] || config.default;
  const client = createPublicClient({ transport: http(url) });
  clientCache.set(chainId, client);
  return client;
}

/** @internal Test-only: reset client cache + warn-once dedup. */
export function _resetRpcClientsForTests(): void {
  clientCache.clear();
  warnedUnknownChains.clear();
}
