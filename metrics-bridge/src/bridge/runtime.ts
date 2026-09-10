import { register } from "../metrics.js";
import { BRIDGE_POLL_INTERVAL_MS } from "./config.js";
import { createBridgeMetrics, type BridgeMetrics } from "./metrics.js";
import { observeBridgeTransfers, type BridgeRow } from "./observation.js";

export async function pollBridgeTransfers(
  metrics: BridgeMetrics,
  observe: () => Promise<BridgeRow[]> = observeBridgeTransfers,
  now: () => number = Date.now,
): Promise<void> {
  try {
    metrics.publish(await observe(), Math.floor(now() / 1000));
  } catch {
    metrics.fail();
    console.error(
      "Bridge transfer observation incomplete; retaining last complete snapshot",
    );
  }
}

export function startBridgePolling(): void {
  const metrics = createBridgeMetrics(register);
  const loop = async () => {
    await pollBridgeTransfers(metrics);
    setTimeout(() => void loop(), BRIDGE_POLL_INTERVAL_MS);
  };
  void loop();
}
