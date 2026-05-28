/**
 * Type definitions for QuickNode webhook payloads and notification messages
 */

export interface QuickNodeDecodedLog {
  address: string;
  name: string; // Decoded event name (e.g., "ExecutionSuccess", "AddedOwner")
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  logIndex: string;
  // Decoded event parameters (varies by event type)
  [key: string]: unknown;
}

export interface QuickNodeWebhookPayload {
  result: QuickNodeDecodedLog[];
}

export interface NotificationField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface NotificationContent {
  title: string;
  description: string;
  color: number;
  fields: NotificationField[];
  // QuickNode decoded logs do not include block time; this is formatter dispatch time.
  timestamp: string;
}

export interface ProcessedEvent {
  multisigKey: string;
  eventName: string;
  channelType: "alerts" | "events";
}

export type EventSignature = string;
export type EventName = string;
export type MultisigKey = string;
