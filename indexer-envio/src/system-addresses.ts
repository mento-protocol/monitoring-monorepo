import _contractsJson from "@mento-protocol/contracts/contracts.json" with { type: "json" };
import nttAddressesRaw from "../config/nttAddresses.json" with { type: "json" };
import protocolActorsRaw from "../config/protocolActors.json" with { type: "json" };
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

interface ProtocolActorEntry {
  chainId: number;
  address: string;
  label?: string;
  category?: string;
}
const PROTOCOL_ACTOR_ENTRIES: ProtocolActorEntry[] = (
  protocolActorsRaw as {
    entries: ProtocolActorEntry[];
  }
).entries;

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
// Per-chain NTT-bridge address index. Built first so it can be reused by
// both `STATIC_SYSTEM_ADDRESSES_BY_CHAIN` (union into the system set) and
// `nttBridgeAddressesForChain` (exposed for the V2 stable `classifyKind`
// helper). Single source of truth — a third caller would import the same
// helper, not re-parse NTT_ENTRIES.
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

const STATIC_SYSTEM_ADDRESSES_BY_CHAIN: Map<number, Set<string>> = (() => {
  const out = new Map<number, Set<string>>();

  // Collect from `@mento-protocol/contracts` for every indexed chain
  // (mainnet + testnet). Same handlers run against both yamls.
  for (const chainId of ALL_INDEXED_CHAIN_IDS) {
    const set = new Set<string>();
    for (const entry of iterateContractAddresses(chainId)) {
      set.add(entry.address);
    }
    // Union in the NTT addresses built above (helper, nttManagerProxy,
    // transceiverProxy) — same addresses, single iteration point.
    const nttSet = NTT_ADDRESSES_BY_CHAIN.get(chainId);
    if (nttSet) for (const addr of nttSet) set.add(addr);
    out.set(chainId, set);
  }

  return out;
})();

const USER_ENTRY_POINT_ADDRESSES_BY_CHAIN: Map<number, Set<string>> = (() => {
  const out = new Map<number, Set<string>>();
  const userEntryPointNamePatterns = /^(Broker|Router(v\d+)?)$/;
  for (const chainId of ALL_INDEXED_CHAIN_IDS) {
    const set = new Set<string>();
    for (const entry of iterateContractAddresses(chainId)) {
      if (userEntryPointNamePatterns.test(entry.rawName)) {
        set.add(entry.address);
      }
    }
    out.set(chainId, set);
  }
  return out;
})();

const MANUAL_PROTOCOL_ACTORS_BY_CHAIN: Map<number, Set<string>> = (() => {
  const out = new Map<number, Set<string>>();
  for (const entry of PROTOCOL_ACTOR_ENTRIES) {
    let set = out.get(entry.chainId);
    if (!set) {
      set = new Set<string>();
      out.set(entry.chainId, set);
    }
    set.add(entry.address.toLowerCase());
  }
  return out;
})();

/**
 * Returns true if `addr` is a Mento internal address — used to hide
 * rebalancer / treasury / bridge flows from the user-facing volume
 * table by default (with a UI toggle to show them separately).
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

/**
 * Returns true when the transaction entry point itself proves the swap was
 * initiated by protocol automation. This is intentionally narrower than
 * `isSystemAddress`: the static system set includes user-facing Broker/Router
 * contracts, and OR-checking those direct entry points would hide normal users
 * routing through the Mento UI. Dynamic pool rebalancers, manual overrides,
 * and non-user-facing static contracts are safe tx.to filters because those
 * contracts are protocol-controlled actors.
 */
export function isProtocolActorEntryPoint(
  chainId: number,
  addr: string,
  pool?: { rebalancerAddress: string },
): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  if (
    pool?.rebalancerAddress &&
    pool.rebalancerAddress.toLowerCase() === lower
  ) {
    return true;
  }
  if (
    STATIC_SYSTEM_ADDRESSES_BY_CHAIN.get(chainId)?.has(lower) &&
    !USER_ENTRY_POINT_ADDRESSES_BY_CHAIN.get(chainId)?.has(lower)
  ) {
    return true;
  }
  return MANUAL_PROTOCOL_ACTORS_BY_CHAIN.get(chainId)?.has(lower) ?? false;
}

/** Test-only: expose the static set for assertions. */
export function _staticSystemAddressesForChain(chainId: number): Set<string> {
  return STATIC_SYSTEM_ADDRESSES_BY_CHAIN.get(chainId) ?? new Set();
}

/** Returns the set of NTT-bridge addresses for the given chain (helpers,
 *  managers, transceivers). Used by V2 stable handler's tx.to-based
 *  classification to tag mints/burns as BRIDGE_*. Returns an empty Set when
 *  the chain has no NTT entries. */
export function nttBridgeAddressesForChain(chainId: number): Set<string> {
  return NTT_ADDRESSES_BY_CHAIN.get(chainId) ?? new Set();
}
