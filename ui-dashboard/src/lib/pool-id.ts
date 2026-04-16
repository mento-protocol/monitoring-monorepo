/**
 * Pool ID utilities for the Mento multichain dashboard.
 *
 * Pool IDs are stored in the indexer in a namespaced format:
 *   `{chainId}-{address}` (e.g. "42220-0x02fa2625825192...")
 *
 * This ensures pool records from different chains never collide in the shared
 * Hasura endpoint. All functions here operate on this format.
 *
 * Security posture: chainId scoping is application-layer only.
 * The Hasura endpoint serves public blockchain data; there is no row-level
 * security. Pool IDs namespace data by chain in the application, which is
 * sufficient since all indexed data is publicly observable on-chain anyway.
 * See: https://github.com/mento-protocol/monitoring-monorepo/pull/111
 */

import { isValidAddress } from "@/lib/validators";

/**
 * Returns true if the value matches the `{chainId}-{0x...}` namespaced format.
 *
 * @example isNamespacedPoolId("42220-0x02fa...")  // true
 * @example isNamespacedPoolId("0x02fa...")         // false
 */
export function isNamespacedPoolId(value: string): boolean {
  return /^\d+-0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Extracts the numeric chainId prefix from a namespaced pool ID.
 * Returns null if the value is not a valid namespaced pool ID.
 *
 * @example extractChainIdFromPoolId("42220-0x02fa...")  // 42220
 * @example extractChainIdFromPoolId("0x02fa...")        // null
 */
export function extractChainIdFromPoolId(value: string): number | null {
  if (!isNamespacedPoolId(value)) return null;
  const [chainId] = value.split("-", 1);
  return Number(chainId);
}

/**
 * Normalizes a raw pool ID input against the active chain.
 *
 * - Valid address ("0x..."): prefixes with chainId → "42220-0x..."
 * - Already namespaced ("42220-0x..."): lowercases and returns as-is
 * - Invalid input: returned unchanged (passthrough is intentional — callers
 *   guard before this call or rely on the not-found redirect that a garbage
 *   pool ID naturally produces when queried)
 *
 * @example normalizePoolIdForChain("0x02fa...", 42220)       // "42220-0x02fa..."
 * @example normalizePoolIdForChain("42220-0x02FA...", 42220) // "42220-0x02fa..."
 * @example normalizePoolIdForChain("garbage", 42220)         // "garbage" (passthrough)
 */
export function normalizePoolIdForChain(
  value: string,
  chainId: number,
): string {
  if (isNamespacedPoolId(value)) return value.toLowerCase();
  if (isValidAddress(value)) return `${chainId}-${value.toLowerCase()}`;
  // Invalid input: return unchanged. Callers either pre-validate (pools page
  // filter) or rely on the resulting not-found redirect (pool detail page URL).
  return value;
}

/**
 * Strips the "{chainId}-" prefix from a namespaced pool ID so callers receive
 * a raw 0x address (e.g. for AddressLink, explorer URLs, or eth_call).
 * Non-namespaced inputs pass through unchanged.
 *
 * @example stripChainIdFromPoolId("42220-0x02fa...")  // "0x02fa..."
 * @example stripChainIdFromPoolId("0x02fa...")        // "0x02fa..."
 */
export function stripChainIdFromPoolId(value: string): string {
  if (!isNamespacedPoolId(value)) return value;
  return value.split("-").slice(1).join("-");
}
