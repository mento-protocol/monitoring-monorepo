/**
 * Shared viem PublicClient cache.
 *
 * Both rebalance-check.ts and protocol-fees.ts need a cached viem client
 * per RPC URL. This module provides a single shared cache so the same
 * URL always returns the same client instance.
 */

import { createPublicClient, http, parseAbi, type PublicClient } from "viem";

// ---------------------------------------------------------------------------
// Client cache — keyed by RPC URL (typically 1-2 entries per network)
// ---------------------------------------------------------------------------

const clientCache = new Map<string, PublicClient>();

export function getViemClient(rpcUrl: string): PublicClient {
  let client = clientCache.get(rpcUrl);
  if (client) return client;
  client = createPublicClient({ transport: http(rpcUrl) });
  clientCache.set(rpcUrl, client);
  return client;
}

// ---------------------------------------------------------------------------
// Shared ERC20 ABI fragments
// ---------------------------------------------------------------------------

export const ERC20_ABI = parseAbi([
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
]);
