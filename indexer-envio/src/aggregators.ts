import aggregatorsRaw from "../config/aggregators.json";
import { CONTRACT_NAMESPACE_BY_CHAIN } from "./contractAddresses";
import { isSystemAddress, iterateContractAddresses } from "./system-addresses";

interface AggregatorEntry {
  name: string;
  source: string;
  $note?: string;
}

/** Metadata for a cluster-prefixed aggregator name (`cluster-<deployer-prefix>`).
 *  Surfaces the deployer EOA + explorer URL so the leaderboard's UI can render
 *  an info-icon tooltip explaining the grouping signal and link to the deployer
 *  for follow-up research. Pure on-chain fact: shared deployer; no inference
 *  about the operator's identity. */
export interface ClusterMetadata {
  chainId: number;
  deployer: string;
  explorerUrl: string;
  $note?: string;
}

interface ClustersBlock {
  $comment?: string;
  [clusterName: string]: ClusterMetadata | string | undefined;
}

/** address → canonical aggregator name, per chain. */
const AGGREGATOR_BY_CHAIN: Map<number, Map<string, string>> = (() => {
  const out = new Map<number, Map<string, string>>();
  for (const [chainIdStr, perChain] of Object.entries(aggregatorsRaw)) {
    // Skip top-level metadata blocks (`$comment`, `$clusters`, future `$*`).
    // Per-chain JSON blocks are keyed by numeric chainId strings.
    if (chainIdStr.startsWith("$")) continue;
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

/** cluster name (e.g. `cluster-7dc08ec2`) → {deployer, explorerUrl, ...}. */
const CLUSTERS_BY_NAME: Map<string, ClusterMetadata> = (() => {
  const out = new Map<string, ClusterMetadata>();
  const block = (aggregatorsRaw as { $clusters?: ClustersBlock }).$clusters;
  if (!block) return out;
  for (const [name, value] of Object.entries(block)) {
    if (name.startsWith("$")) continue; // skip nested $comment
    if (typeof value !== "object" || value === null) continue;
    out.set(name, value as ClusterMetadata);
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
 * 1. Known aggregator router → its name. Includes both branded aggregators
 *    (`"squid"`, `"lifi"`, `"0x"`, `"openocean"`) AND `"cluster-<id>"` labels
 *    for multi-contract operators identified by shared deployer EOA.
 * 2. Mento `Broker` / `Router*` OR the pool's own address → `"direct"`.
 * 3. Other Mento internal contract (rebalancer, NTT manager, etc.) → `"system"`.
 * 4. Otherwise → `"unknown"`. These should be inspected periodically and either
 *    promoted to a known aggregator / cluster (add to `aggregators.json`) or
 *    left as a long tail of unlabelled custom routers / MEV bots.
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

/** Look up cluster metadata (deployer EOA + explorer URL + note) by cluster
 *  name. Used by the leaderboard's UI to render an info-icon tooltip on
 *  cluster-labeled rows. Returns `undefined` for non-cluster names like
 *  `"squid"` / `"direct"` / `"unknown"`. */
export function getClusterMetadata(
  aggregatorName: string,
): ClusterMetadata | undefined {
  return CLUSTERS_BY_NAME.get(aggregatorName);
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
export function _allClusterNames(): string[] {
  return [...CLUSTERS_BY_NAME.keys()];
}
