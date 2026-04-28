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
 *   2. Hardcoded full-node default — only present when a known full-node
 *      RPC exists for the chain. Chains without a known full-node default
 *      (e.g. Monad testnet 10143) require an explicit env var; without
 *      one, `getRpcClient` returns `null` and the probe runner skips
 *      pools on that chain gracefully.
 */

import { createPublicClient, http, type PublicClient } from "viem";

type RpcConfig = { default?: string; envVar: string };

/**
 * Per-chain config. `default` is intentionally only set for chains where a
 * known public full-node RPC exists. HyperRPC endpoints (`*.rpc.hypersync.xyz`)
 * do NOT serve `eth_call` and will fail every probe, so they are NEVER used
 * as a default — that's why Monad testnet (10143) has no default and must be
 * explicitly overridden via `RPC_URL_10143`.
 *
 * Verified defaults (2026-04-28):
 *   - 42220 (Celo mainnet): forno.celo.org — full-node, supports eth_call.
 *   - 11142220 (Celo Sepolia): forno.celo-sepolia.celo-testnet.org — full-node.
 *   - 143 (Monad mainnet): rpc2.monad.xyz — full-node, supports eth_call.
 *   - 10143 (Monad testnet): NO public full-node default known — env var required.
 *
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
    // No public full-node default — `https://10143.rpc.hypersync.xyz` is
    // HyperRPC and does not serve eth_call. Operators must set RPC_URL_10143
    // to a full-node endpoint to enable the probe on Monad testnet.
    envVar: "RPC_URL_10143",
  },
};

const clientCache = new Map<number, PublicClient>();
const warnedUnknownChains = new Set<number>();
const warnedMissingUrl = new Set<number>();

/**
 * Returns a viem PublicClient for the given chain, or `null` if:
 *   - the chain isn't known to metrics-bridge yet, or
 *   - the chain is known but has no default RPC and the env-var override
 *     wasn't set (e.g. Monad testnet 10143 without RPC_URL_10143).
 *
 * Caller should treat null as "skip probe for this pool" — never as an error.
 *
 * Logs once per unknown chain / missing-URL chain so the gap is visible in
 * Cloud Run logs without spamming on every poll cycle.
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
  if (!url) {
    if (!warnedMissingUrl.has(chainId)) {
      warnedMissingUrl.add(chainId);
      console.warn(
        `[metrics-bridge] no RPC URL for chainId=${chainId}: set ${config.envVar} to a full-node RPC (HyperRPC does not serve eth_call); rebalance probe disabled for this chain.`,
      );
    }
    return null;
  }
  const client = createPublicClient({ transport: http(url) });
  clientCache.set(chainId, client);
  return client;
}

/** @internal Test-only: reset client cache + warn-once dedup. */
export function _resetRpcClientsForTests(): void {
  clientCache.clear();
  warnedUnknownChains.clear();
  warnedMissingUrl.clear();
}
