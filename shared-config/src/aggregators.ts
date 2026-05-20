// Canonical aggregator/router registry — chain → address → {name, source}.
// Source of truth for both the indexer's swap classifier and any UI / forensic
// tooling that needs to look up an aggregator by name or address. The
// `indexer-envio/config/aggregators.json` file is a vendored copy of this
// (indexer builds outside the pnpm workspace); a parity test in
// `indexer-envio/test/aggregators-parity.test.ts` keeps the two in lockstep.

import aggregatorsJson from "../aggregators.json" with { type: "json" };

type RawClusterMetadata = {
  chainId: number;
  deployer: string;
  explorerUrl: string;
  $note?: string;
};

type RawAggregatorEntry = {
  name: string;
  source?: string;
  $note?: string;
};

export type AggregatorClusterMetadata = {
  chainId: number;
  deployer: string;
  explorerUrl: string;
  note?: string;
};

// The JSON mixes per-chain blocks with `$comment` / `$clusters` keys at the
// top level, and `$clusters` itself mixes the cluster entries with a nested
// `$comment`. TypeScript can't express that heterogeneous shape cleanly, so
// we go through `unknown` once and validate the slices we use at runtime.
const ROOT = aggregatorsJson as unknown as Record<string, unknown>;

// Per-chain `Map<lowercaseAddress, aggregatorName>` derived from the JSON.
// Built once at module load so consumers can do constant-time lookups.
const ADDRESSES_BY_CHAIN: Map<number, Map<string, string>> = (() => {
  const out = new Map<number, Map<string, string>>();
  for (const [key, value] of Object.entries(ROOT)) {
    if (key.startsWith("$")) continue; // skip $comment, $clusters
    const chainId = Number(key);
    if (!Number.isFinite(chainId)) continue;
    const inner = new Map<string, string>();
    for (const [addr, entry] of Object.entries(
      value as Record<string, RawAggregatorEntry>,
    )) {
      // Per-chain blocks only ever hold address-keyed entries — `$comment`
      // / `$clusters` live at the top level, not inside a chain block — so
      // no `$`-prefix filter is needed here.
      inner.set(addr.toLowerCase(), entry.name);
    }
    out.set(chainId, inner);
  }
  return out;
})();

// Exposed for unit tests so we can exercise the "missing/malformed
// $clusters" branch without mocking the JSON import. The module's own
// CLUSTERS map is built by calling this with `ROOT.$clusters`.
export function _buildClusterMap(
  raw: unknown,
): Record<string, RawClusterMetadata> {
  const out: Record<string, RawClusterMetadata> = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (name.startsWith("$")) continue;
    if (value == null || typeof value !== "object") continue;
    out[name] = value as RawClusterMetadata;
  }
  return out;
}

const CLUSTERS: Record<string, RawClusterMetadata> = _buildClusterMap(
  ROOT.$clusters,
);

/** Aggregator name (e.g. "squid") for a given (chainId, address), or null
 *  when the address isn't a known aggregator on that chain. */
export function getAggregatorName(
  chainId: number,
  address: string,
): string | null {
  return ADDRESSES_BY_CHAIN.get(chainId)?.get(address.toLowerCase()) ?? null;
}

/** First registered address for a given (chainId, aggregator name), or null
 *  when no entry matches. Use this when test fixtures or scripts need the
 *  canonical address for a known aggregator — keeps the address literal in
 *  one place. Returns the first match if a name has multiple addresses on
 *  the same chain (e.g. openocean's per-leg executor). */
export function getAggregatorAddress(
  chainId: number,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [addr, entryName] of ADDRESSES_BY_CHAIN.get(chainId) ?? []) {
    if (entryName.toLowerCase() === lower) return addr;
  }
  return null;
}

/** All `(address → aggregatorName)` entries for a chain, in insertion order
 *  (matches JSON key order). Use this to enumerate or filter aggregators —
 *  e.g. dashboard widgets, forensic scripts, monitoring jobs. */
export function aggregatorsByChain(
  chainId: number,
): ReadonlyMap<string, string> {
  return ADDRESSES_BY_CHAIN.get(chainId) ?? new Map<string, string>();
}

export function getClusterMetadata(
  aggregatorName: string,
): AggregatorClusterMetadata | undefined {
  const meta = CLUSTERS[aggregatorName];
  if (!meta) return undefined;
  return {
    chainId: meta.chainId,
    deployer: meta.deployer,
    explorerUrl: meta.explorerUrl,
    ...(meta.$note !== undefined && { note: meta.$note }),
  };
}

export function clusterNames(): string[] {
  return Object.keys(CLUSTERS).sort();
}
