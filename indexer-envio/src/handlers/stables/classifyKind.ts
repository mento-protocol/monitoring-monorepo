// ---------------------------------------------------------------------------
// Stable Transfer-with-zero classifier.
//
// Maps `tx.to` to a coarse mint/burn pathway so the /stables UI can break
// down "where did this supply come from / go" without inspecting tx receipts.
//
//   RESERVE_*  — tx.to is the Mento Broker (reserve mint/burn via Broker.swap)
//   BRIDGE_*   — tx.to is a Wormhole NTT manager/helper/transceiver
//   OTHER_*    — anything else (rare: future router, EOA-initiated direct mint)
//
// Direction (MINT vs BURN) is determined by whether the Transfer's `from` is
// the zero address (mint) or `to` is the zero address (burn) — caller already
// discriminated.
// ---------------------------------------------------------------------------

import { getContractAddress } from "../../contractAddresses.js";
import { asAddress } from "../../helpers.js";
import { nttBridgeAddressesForChain } from "../../system-addresses.js";

export type V2StableSupplyChangeKind =
  | "RESERVE_MINT"
  | "RESERVE_BURN"
  | "BRIDGE_MINT"
  | "BRIDGE_BURN"
  | "OTHER_MINT"
  | "OTHER_BURN";

// Per-chain Broker address. Resolved lazily via getContractAddress so the
// classifier degrades to OTHER_* on chains where Broker isn't deployed
// (e.g. Monad), rather than throwing at module load. Map is bounded by the
// number of indexed chains (currently 5 across mainnet + testnet), so the
// unbounded-Map rule in CLAUDE.md doesn't apply meaningfully.
const _brokerCache = new Map<number, string | null>();
const getBrokerAddress = (chainId: number): string | null => {
  if (_brokerCache.has(chainId)) {
    return _brokerCache.get(chainId) ?? null;
  }
  const lowered = getContractAddress(chainId, "Broker")?.toLowerCase() ?? null;
  _brokerCache.set(chainId, lowered);
  return lowered;
};

/**
 * Classify a Transfer-with-zero event into one of the six supply-change kinds.
 *
 * `txTo` is the outer transaction's `to` field (an entry-point contract on
 * the protocol side, distinct from the Transfer's `from`/`to` which are the
 * token-side counterparties). null/undefined falls through to OTHER_*.
 */
export function classifyStableSupplyChangeKind(
  chainId: number,
  txTo: string | null | undefined,
  isMint: boolean,
): V2StableSupplyChangeKind {
  if (!txTo) return isMint ? "OTHER_MINT" : "OTHER_BURN";
  const lower = asAddress(txTo);
  const broker = getBrokerAddress(chainId);
  if (broker && lower === broker)
    return isMint ? "RESERVE_MINT" : "RESERVE_BURN";
  if (nttBridgeAddressesForChain(chainId).has(lower)) {
    return isMint ? "BRIDGE_MINT" : "BRIDGE_BURN";
  }
  return isMint ? "OTHER_MINT" : "OTHER_BURN";
}

/** @internal Test-only: reset the broker-address cache between tests. */
export function _resetBrokerAddressCacheForTest(): void {
  _brokerCache.clear();
}
