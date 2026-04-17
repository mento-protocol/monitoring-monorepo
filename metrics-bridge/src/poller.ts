import { fetchPools } from "./graphql.js";
import { gauges, counters, updateMetrics } from "./metrics.js";
import { markHealthy } from "./server.js";
import { POLL_INTERVAL_MS } from "./config.js";

export async function poll(): Promise<void> {
  try {
    const data = await fetchPools();
    updateMetrics(data.Pool);
    gauges.bridgeLastPoll.set(Math.floor(Date.now() / 1000));
    markHealthy();
  } catch (error) {
    counters.pollErrors.inc();
    console.error("Poll failed:", error);
  }
}

async function loop(): Promise<void> {
  await poll();
  setTimeout(loop, POLL_INTERVAL_MS);
}

export function startPolling(): void {
  loop();
}
