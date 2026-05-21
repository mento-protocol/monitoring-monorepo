/**
 * Type definitions for QuickNode webhook payloads and Discord messages
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

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: DiscordEmbedField[];
  timestamp: string;
}

export interface DiscordMessage {
  embeds: DiscordEmbed[];
}

export interface ProcessedEvent {
  multisigKey: string;
  eventName: string;
  channelType: "alerts" | "events";
}

export type EventSignature = string;
export type EventName = string;
export type MultisigKey = string;
export type MultisigAddress = string;
