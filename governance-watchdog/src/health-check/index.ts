import assert from "assert";
import { QuicknodeEvent } from "../events/types.js";
import isHealthCheckEvent from "./is-health-check-event.js";

/**
 * SortedOracles contract address on Celo mainnet — the only contract whose
 * MedianUpdated events count as health checks. Any contract can emit the same
 * event signature, and QuickNode's evmAbiFilter `contracts` field is silently
 * ignored by the API (see events/process-event.ts), so without this guard a
 * third-party contract could keep the health-check alert green even if the
 * real SortedOracles webhook stopped delivering.
 *
 * ⚠️  If SortedOracles is ever redeployed, update this constant AND the
 * contracts field in infra/quicknode-filter-functions/sorted-oracles.js.
 */
const SORTED_ORACLES_ADDRESS =
  "0xefb84935239dacdecf7c5ba76d8de40b077b7b33".toLowerCase();

// CELO/cUSD rate feed address - only log health checks for this feed
const CELO_CUSD_RATE_FEED_ADDRESS =
  "0x765de816845861e75a25fca122bb6898b8b1282a".toLowerCase();

export default function handleHealthCheckEvent(event: QuicknodeEvent) {
  assert(isHealthCheckEvent(event), "Expected MedianUpdated event");

  // Only trust MedianUpdated events emitted by the real SortedOracles contract
  if (event.address.toLowerCase() !== SORTED_ORACLES_ADDRESS) {
    return;
  }

  // Only log health check for cUSD token
  if (event.token.toLowerCase() === CELO_CUSD_RATE_FEED_ADDRESS) {
    console.info("[HealthCheck]: Block", event.blockNumber);
  }
  // Silently ignore health checks for other tokens
}
