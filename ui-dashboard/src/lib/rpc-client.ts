/**
 * Shared viem PublicClient cache.
 *
 * Both rebalance-check.ts and protocol-fees.ts need a cached viem client
 * per RPC URL. This module provides a single shared cache so the same
 * URL always returns the same client instance.
 */

import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { ERC20_ABI_SOURCES } from "@mento-protocol/monitoring-config/erc20-abi";

// Client cache — keyed by RPC URL + transport timeout (typically 1-2 entries
// per network). Without the timeout in the key, callers that need a tighter
// per-request deadline would silently inherit whichever timeout landed
// first.

const clientCache = new Map<string, PublicClient>();

export function getViemClient(
  rpcUrl: string,
  opts: { timeoutMs?: number } = {},
): PublicClient {
  const key = `${rpcUrl}|${opts.timeoutMs ?? 0}`;
  let client = clientCache.get(key);
  if (client) return client;
  client = createPublicClient({
    transport: http(rpcUrl, { timeout: opts.timeoutMs }),
  });
  clientCache.set(key, client);
  return client;
}

/**
 * Shared ERC20 ABI — source list lives in
 * `@mento-protocol/monitoring-config/erc20-abi` (shared with the
 * metrics-bridge probe). Re-exported as a parsed (viem-typed) ABI so
 * existing dashboard call sites keep importing from one place.
 */
export const ERC20_ABI = parseAbi(ERC20_ABI_SOURCES);
