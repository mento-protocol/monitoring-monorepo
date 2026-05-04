import _contractsJson from "@mento-protocol/contracts/contracts.json";
import nttAddressesRaw from "../config/nttAddresses.json";
import {
  CONTRACT_NAMESPACE_BY_CHAIN,
  type ContractsJson,
} from "./contractAddresses";

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
 *  callers can also build name-pattern filters, e.g. "is this a Router?"). */
function iterateContractAddresses(
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

/** Test-only helper exposed for `aggregators.ts` (which needs the same
 *  contracts.json iteration to identify Mento direct-entry routers). */
export function _iterateContractAddresses(
  chainId: number,
): Array<{ address: string; rawName: string }> {
  return iterateContractAddresses(chainId);
}

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

  // Collect from `@mento-protocol/contracts` for both mainnets we index.
  for (const chainId of [42220, 143]) {
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
