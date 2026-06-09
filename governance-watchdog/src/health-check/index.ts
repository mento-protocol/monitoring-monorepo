import assert from "assert";
import { QuicknodeEvent } from "../events/types.js";
import isHealthCheckEvent from "./is-health-check-event";

// CELO/cUSD rate feed address - only log health checks for this feed
const CELO_CUSD_RATE_FEED_ADDRESS =
  "0x765de816845861e75a25fca122bb6898b8b1282a".toLowerCase();

export default function handleHealthCheckEvent(event: QuicknodeEvent) {
  assert(isHealthCheckEvent(event), "Expected MedianUpdated event");

  // Only log health check for cUSD token
  if (event.token.toLowerCase() === CELO_CUSD_RATE_FEED_ADDRESS) {
    console.info("[HealthCheck]: Block", event.blockNumber);
  }
  // Silently ignore health checks for other tokens
}
