import aggregatorsRaw from "../config/aggregators.json";
import { CONTRACT_NAMESPACE_BY_CHAIN } from "./contractAddresses";
import { isSystemAddress, iterateContractAddresses } from "./system-addresses";

interface AggregatorEntry {
  name: string;
  source: string;
  $note?: string;
}

/** address → canonical aggregator name, per chain. */
const AGGREGATOR_BY_CHAIN: Map<number, Map<string, string>> = (() => {
  const out = new Map<number, Map<string, string>>();
  for (const [chainIdStr, perChain] of Object.entries(aggregatorsRaw)) {
    if (chainIdStr.startsWith("$")) continue; // skip $comment
    const chainId = Number(chainIdStr);
    if (Number.isNaN(chainId)) continue;
    const inner = new Map<string, string>();
    for (const [addr, entry] of Object.entries(
      perChain as Record<string, AggregatorEntry>,
    )) {
      if (addr.startsWith("$")) continue;
      inner.set(addr.toLowerCase(), entry.name);
    }
    out.set(chainId, inner);
  }
  return out;
})();

/**
 * "Direct entry" contracts — the Mento UI / SDK / native router path that
 * users hit when swapping without a third-party aggregator. Per chain:
 * - Celo: `Broker` + `Router`
 * - Monad: `Routerv300` (no Broker on Monad)
 *
 * Plus: a swap whose `tx.to` equals its own pool contract is also "direct"
 * (no router mediation at all). That check is handled at the call site
 * since pool addresses are dynamic and not in `contracts.json`.
 */
const DIRECT_ENTRY_BY_CHAIN: Map<number, Set<string>> = (() => {
  const out = new Map<number, Set<string>>();
  // Match by name — `contracts.json` is the source of truth for these
  // canonical addresses. Patterns cover both Celo's "Broker" / "Router" and
  // Monad's "Routerv300" / future versioned router contracts.
  const directNamePatterns = /^(Broker|Router(v\d+)?)$/;
  // Same handlers run against mainnet AND testnet yamls; cover every
  // indexed chain so testnet Broker/Router calls don't fall through to
  // "unknown".
  for (const chainId of Object.keys(CONTRACT_NAMESPACE_BY_CHAIN).map(Number)) {
    const set = new Set<string>();
    for (const entry of iterateContractAddresses(chainId)) {
      if (directNamePatterns.test(entry.rawName)) {
        set.add(entry.address);
      }
    }
    out.set(chainId, set);
  }
  return out;
})();

/**
 * Classify a swap's `tx.to` (entry-point contract) into a canonical bucket
 * for the leaderboard's aggregator-flow analysis.
 *
 * Resolution order (most specific wins):
 * 1. Known aggregator router → its name (e.g. `"squid"`, `"lifi"`, `"0x"`).
 * 2. Mento `Broker` / `Router*` OR the pool's own address → `"direct"`.
 * 3. Other Mento internal contract (rebalancer, NTT manager, etc.) → `"system"`.
 * 4. Otherwise → `"unknown"`. These should be inspected periodically and either
 *    promoted to a known aggregator (add to `aggregators.json`) or left as a
 *    long tail of unlabelled custom routers / MEV bots.
 *
 * Pass `poolAddress` (the swap's underlying pool contract) so direct-to-pool
 * swaps without router mediation are classified as `"direct"`, not `"unknown"`.
 */
export function classifyAggregator(
  chainId: number,
  txTo: string,
  poolAddress?: string,
): string {
  if (!txTo) return "unknown";
  const lower = txTo.toLowerCase();

  const aggName = AGGREGATOR_BY_CHAIN.get(chainId)?.get(lower);
  if (aggName) return aggName;

  if (DIRECT_ENTRY_BY_CHAIN.get(chainId)?.has(lower)) return "direct";
  if (poolAddress && lower === poolAddress.toLowerCase()) return "direct";

  if (isSystemAddress(chainId, lower)) return "system";

  return "unknown";
}

/** Test-only accessors. */
export function _aggregatorAddressesForChain(
  chainId: number,
): Map<string, string> {
  return AGGREGATOR_BY_CHAIN.get(chainId) ?? new Map();
}
export function _directEntriesForChain(chainId: number): Set<string> {
  return DIRECT_ENTRY_BY_CHAIN.get(chainId) ?? new Set();
}
