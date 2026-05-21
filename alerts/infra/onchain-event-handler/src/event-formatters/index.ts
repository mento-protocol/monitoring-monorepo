/**
 * Event formatter registry
 * Maps event names to their formatter functions
 */

import type { DiscordEmbedField, QuickNodeDecodedLog } from "../types";
import * as executionFormatters from "./execution-formatters";
import * as moduleFormatters from "./module-formatters";
import * as ownerFormatters from "./owner-formatters";
import * as securityFormatters from "./security-formatters";
import * as transactionFormatters from "./transaction-formatters";

/**
 * Event formatter function signature
 * Note: Some formatters may need additional parameters (like chainName for SafeMultiSigTransaction)
 * These are handled separately in decodeEventData
 */
type EventFormatter = (
  log: QuickNodeDecodedLog,
  chainConfig: { decimals: number; symbol: string },
  txHash?: string,
) => Promise<DiscordEmbedField[]>;

/**
 * Registry of event formatters
 */
const EVENT_FORMATTERS: Record<string, EventFormatter> = {
  // Owner management events
  AddedOwner: ownerFormatters.formatOwnerEvent,
  RemovedOwner: ownerFormatters.formatOwnerEvent,

  // Threshold changes
  ChangedThreshold: securityFormatters.formatThresholdEvent,

  // Fallback handler changes
  ChangedFallbackHandler: securityFormatters.formatFallbackHandlerEvent,

  // Guard changes
  ChangedGuard: securityFormatters.formatGuardEvent,

  // Module management
  EnabledModule: moduleFormatters.formatModuleEvent,
  DisabledModule: moduleFormatters.formatModuleEvent,

  // Execution events
  ExecutionSuccess: executionFormatters.formatExecutionEvent,
  ExecutionFailure: executionFormatters.formatExecutionEvent,

  // Approval events
  ApproveHash: securityFormatters.formatApproveHashEvent,

  // Message signing
  SignMsg: securityFormatters.formatSignMsgEvent,

  // Safe received funds
  SafeReceived: transactionFormatters.formatSafeReceivedEvent,

  // Note: SafeMultiSigTransaction is handled specially in decodeEventData
  // because it requires chainName parameter
};

/**
 * Get formatter for an event name
 */
export function getEventFormatter(eventName: string): EventFormatter | null {
  return EVENT_FORMATTERS[eventName] || null;
}
