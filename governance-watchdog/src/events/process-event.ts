import { eventRegistry } from "./registry";
import { EventType, QuicknodeEvent } from "./types.js";

/**
 * MentoGovernor contract address on Celo mainnet.
 * Used to guard against false notifications from other contracts that emit
 * the same OpenZeppelin Governor event signatures (ProposalCreated, etc.).
 *
 * Note: QuickNode's evmAbiFilter `contracts` field is currently silently
 * ignored by the API — all address filtering must happen here in the handler.
 *
 * ⚠️  If the governor contract is ever redeployed, update this constant AND
 * the contracts field in infra/quicknode-filter-functions/governor.js.
 */
const MENTO_GOVERNOR_ADDRESS =
  "0x47036d78bb3169b4f5560dd77bf93f4412a59852".toLowerCase();

/**
 * Governance event types that must originate from the MentoGovernor contract.
 */
const GOVERNOR_EVENT_TYPES = new Set<EventType>([
  EventType.ProposalCreated,
  EventType.ProposalQueued,
  EventType.ProposalExecuted,
  EventType.ProposalCanceled,
]);

/**
 * Process an event using the registry
 */
export async function processEvent(event: QuicknodeEvent): Promise<void> {
  // Guard: governance events must originate from the MentoGovernor contract.
  // Other contracts on Celo emit identical OZ Governor event signatures; without
  // this check, those would produce false notifications.
  if (GOVERNOR_EVENT_TYPES.has(event.name)) {
    if (event.address.toLowerCase() !== MENTO_GOVERNOR_ADDRESS) {
      console.log(
        `[processEvent] Skipping ${event.name} from non-governor address ${event.address}`,
      );
      return;
    }
  }

  // Handle special cases first
  if (event.name === EventType.MedianUpdated) {
    const healthCheckHandler = eventRegistry.getSpecialHandler("healthCheck");
    if (healthCheckHandler) {
      if (process.env.DEBUG) {
        console.log(`[DEBUG] Health check event: ${event.name}`);
      }
      void healthCheckHandler(event);
      return;
    }
  }

  // Handle regular events
  const handler = eventRegistry.getHandler(event.name);
  if (handler) {
    await handler(event);
  } else {
    console.log(`No handler registered for event type: ${event.name}`);
  }
}
