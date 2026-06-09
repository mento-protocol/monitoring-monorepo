import { EmbedBuilder } from "discord.js";
import { TelegramMessageBuilder } from "../event-notifications/message-builder.telegram";
import type { EventHandlerConfig } from "./event-handler-factory";

/**
 * Event type enum - all supported governance events
 */
export enum EventType {
  ProposalCreated = "ProposalCreated",
  ProposalQueued = "ProposalQueued",
  ProposalExecuted = "ProposalExecuted",
  ProposalCanceled = "ProposalCanceled",
  MedianUpdated = "MedianUpdated",
  Unknown = "Unknown",
}

/**
 * Mapping of EventType to its corresponding event interface
 * Add new events here - the QuicknodeEvent union will be auto-derived
 */
export interface EventTypeMap {
  [EventType.ProposalCreated]: ProposalCreatedEvent;
  [EventType.ProposalQueued]: ProposalQueuedEvent;
  [EventType.ProposalExecuted]: ProposalExecutedEvent;
  [EventType.ProposalCanceled]: ProposalCanceledEvent;
  [EventType.MedianUpdated]: MedianUpdatedEvent;
}

/**
 * Proposal Created Event
 */
export interface ProposalCreatedEvent {
  calldatas: `0x${string}` | readonly `0x${string}`[];
  description: string;
  endBlock: bigint;
  name: EventType.ProposalCreated;
  proposalId: bigint;
  proposer: `0x${string}`;
  signatures: string | readonly string[];
  startBlock: bigint;
  targets: `0x${string}` | readonly `0x${string}`[];
  values: bigint | readonly bigint[];
  version: number;
}

/**
 * Median Updated Event (used for health checks)
 */
export interface MedianUpdatedEvent {
  name: EventType.MedianUpdated;
  token: `0x${string}`;
  value: bigint;
}

/**
 * Proposal Queued Event
 */
export interface ProposalQueuedEvent {
  name: EventType.ProposalQueued;
  proposalId: bigint;
  eta: bigint;
}

/**
 * Proposal Executed Event
 */
export interface ProposalExecutedEvent {
  name: EventType.ProposalExecuted;
  proposalId: bigint;
}

/**
 * Proposal Canceled Event
 */
export interface ProposalCanceledEvent {
  name: EventType.ProposalCanceled;
  proposalId: bigint;
}

/**
 * Type helper to ensure all EventTypes (except Unknown) are mapped
 * This will cause a TypeScript error if you forget to add a new event to EventTypeMap
 * Intentionally unused - exists purely for compile-time validation
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ValidateEventTypeMap = {
  [K in Exclude<EventType, EventType.Unknown>]: K extends keyof EventTypeMap
    ? EventTypeMap[K]
    : never;
};

/**
 * QuickNode event payload structure
 * All events include common fields plus specific event data
 * The union is auto-derived from EventTypeMap
 */
export type QuicknodeEvent = {
  address: string;
  blockHash: string;
  blockNumber: string;
  logIndex: string;
  name: EventType;
  transactionHash: string;
  timelockId?: string;
} & EventTypeMap[keyof EventTypeMap];

/**
 * QuickNode webhook payload structure
 */
export interface QuicknodePayload {
  result: QuicknodeEvent[];
}
/**
 * Extended event configuration that includes metadata for routing and processing
 */

export interface ExtendedEventHandlerConfig<T extends QuicknodeEvent>
  extends EventHandlerConfig<T> {
  // Deduplication strategy for this event type
  deduplicationStrategy:
    | "proposalId"
    | "rateFeedId"
    | "transactionHash"
    | "custom";

  // Custom deduplication function if strategy is 'custom'
  customDeduplicationKey?: (event: T) => string;

  // Special processing flags
  isHealthCheck?: boolean;
}
/**
 * Event handler function type
 */
export type EventHandlerFunction = (
  event: QuicknodeEvent,
) => Promise<void> | void;

/**
 * Registry entry for an event handler
 */
export interface EventRegistryEntry {
  eventType: EventType;
  handler: EventHandlerFunction;
  config: ExtendedEventHandlerConfig<QuicknodeEvent>;
}
/**
 * Complete event configuration for a single event type
 */
export interface EventConfig<T extends QuicknodeEvent = QuicknodeEvent> {
  // Event identification
  eventType: EventType;

  // Validation
  validateEvent: (event: unknown) => event is T;

  // Message composition
  getDiscordMessage: (event: T) => { content: string; embed: EmbedBuilder };
  getTelegramMessage: (event: T) => TelegramMessageBuilder;

  // Display
  emoji: string;

  // Processing metadata
  deduplicationStrategy:
    | "proposalId"
    | "rateFeedId"
    | "transactionHash"
    | "custom";
  customDeduplicationKey?: (event: T) => string;
  isHealthCheck?: boolean;
}
