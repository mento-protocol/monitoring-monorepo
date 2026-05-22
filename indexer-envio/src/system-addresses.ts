import _contractsJson from "@mento-protocol/contracts/contracts.json" with { type: "json" };
import nttAddressesRaw from "../config/nttAddresses.json" with { type: "json" };
import {
  CONTRACT_NAMESPACE_BY_CHAIN,
  type ContractsJson,
} from "./contractAddresses.js";

interface NttEntry {
  chainId: number;
  helper: string;
  nttManagerProxy: string;
  transceiverProxy: string;
}
const NTT_ENTRIES: NttEntry[] = (nttAddressesRaw as { entries: NttEntry[] })
  .entries;

/** Iterate every "contract" type entry in @mento-protocol/contracts for the
 *  given chain. Returns lowercased addresses paired with their raw name (so
 *  callers can also build name-pattern filters, e.g. "is this a Router?").
 *  Also exported for `aggregators.ts` which uses the same iteration to
 *  identify Mento direct-entry routers. */
export function iterateContractAddresses(
  chainId: number,
): Array<{ address: string; rawName: string }> {
  const ns = CONTRACT_NAMESPACE_BY_CHAIN[String(chainId)];
  if (!ns) return [];
  const entries = (_contractsJson as ContractsJson)[String(chainId)]?.[ns];
  if (!entries) return [];
  const out: Array<{ address: string; rawName: string }> = [];
  for (const [rawName, info] of Object.entries(entries)) {
    if (info.type === "contract") {
      out.push({ address: info.address.toLowerCase(), rawName });
    }
  }
  return out;
}

/** Every chainId we know how to look up — covers mainnet + testnet so the
 *  same handlers compiled against `config.multichain.testnet.yaml` get
 *  correct system-address coverage on Alfajores (11142220) and Monad
 *  testnet (10143). Source of truth: `config/deployment-namespaces.json`. */
const ALL_INDEXED_CHAIN_IDS: number[] = Object.keys(
  CONTRACT_NAMESPACE_BY_CHAIN,
).map(Number);

/**
 * Per-chain set of "Mento system" addresses. Includes:
 * - Every contract entry from `@mento-protocol/contracts` (Broker, Reserve,
 *   BiPoolManager, Router, FactoryRegistry, governance multisigs, etc.).
 *   Most are contracts that won't appear as a `tx.from` caller, but the few
 *   EOA-controlled ones (e.g. MigrationMultisig signer, Mento ops EOAs that
 *   may be implementation contracts in the registry) are filtered cheaply.
 * - Wormhole-NTT helper / nttManager / transceiver proxies from
 *   `config/nttAddresses.json` for cross-chain liquidity flows.
 *
 * Per-pool rebalancer EOAs are NOT in this static set — they're stored on
 * `Pool.rebalancerAddress` and checked dynamically in `isSystemAddress(...)`
 * via the optional `pool` argument.
 */
const STATIC_SYSTEM_ADDRESSES_BY_CHAIN: Map<number, Set<string>> = (() => {
  const out = new Map<number, Set<string>>();

  // Collect from `@mento-protocol/contracts` for every indexed chain
  // (mainnet + testnet). Same handlers run against both yamls.
  for (const chainId of ALL_INDEXED_CHAIN_IDS) {
    const set = new Set<string>();
    for (const entry of iterateContractAddresses(chainId)) {
      set.add(entry.address);
    }
    out.set(chainId, set);
  }

  // Add NTT proxies / helpers / managers per chain.
  for (const ntt of NTT_ENTRIES) {
    const set = out.get(ntt.chainId);
    if (!set) continue;
    set.add(ntt.helper.toLowerCase());
    set.add(ntt.nttManagerProxy.toLowerCase());
    set.add(ntt.transceiverProxy.toLowerCase());
  }

  return out;
})();

/**
 * Returns true if `addr` is a Mento internal address — used to hide
 * rebalancer / treasury / bridge flows from the user-facing volume
 * leaderboard by default (with a UI toggle to show them separately).
 *
 * Pass `pool` when the address is being classified in a swap context: the
 * pool's `rebalancerAddress` is the dynamic per-pool EOA that wouldn't be
 * in the static contracts.json set.
 */
export function isSystemAddress(
  chainId: number,
  addr: string,
  pool?: { rebalancerAddress: string },
): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  if (STATIC_SYSTEM_ADDRESSES_BY_CHAIN.get(chainId)?.has(lower)) return true;
  if (
    pool?.rebalancerAddress &&
    pool.rebalancerAddress.toLowerCase() === lower
  ) {
    return true;
  }
  return false;
}

/** Test-only: expose the static set for assertions. */
export function _staticSystemAddressesForChain(chainId: number): Set<string> {
  return STATIC_SYSTEM_ADDRESSES_BY_CHAIN.get(chainId) ?? new Set();
}

// Per-chain NTT-bridge address index. Builds once at module load from the
// same NTT entries that feed STATIC_SYSTEM_ADDRESSES_BY_CHAIN above. The
// V2 stable `classifyKind` helper uses this to discriminate BRIDGE_* from
// other system Mints/burns — avoiding a second copy of the NTT JSON parse.
const NTT_ADDRESSES_BY_CHAIN: Map<number, Set<string>> = (() => {
  const out = new Map<number, Set<string>>();
  for (const ntt of NTT_ENTRIES) {
    let set = out.get(ntt.chainId);
    if (!set) {
      set = new Set<string>();
      out.set(ntt.chainId, set);
    }
    set.add(ntt.helper.toLowerCase());
    set.add(ntt.nttManagerProxy.toLowerCase());
    set.add(ntt.transceiverProxy.toLowerCase());
  }
  return out;
})();

/** Returns the set of NTT-bridge addresses for the given chain (helpers,
 *  managers, transceivers). Used by V2 stable handler's tx.to-based
 *  classification to tag mints/burns as BRIDGE_*. Returns an empty Set when
 *  the chain has no NTT entries. */
export function nttBridgeAddressesForChain(chainId: number): Set<string> {
  return NTT_ADDRESSES_BY_CHAIN.get(chainId) ?? new Set();
}
