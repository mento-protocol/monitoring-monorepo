/**
 * Formatters for security-related events
 */

import type { DiscordEmbedField, QuickNodeDecodedLog } from "../types";

export async function formatThresholdEvent(
  log: QuickNodeDecodedLog,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.threshold !== undefined) {
    const threshold =
      typeof log.threshold === "string"
        ? parseInt(log.threshold, 10)
        : Number(log.threshold);
    fields.push({
      name: "New Threshold",
      value: threshold.toString(),
      inline: false,
    });
  }

  return fields;
}

export async function formatFallbackHandlerEvent(
  log: QuickNodeDecodedLog,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.handler && typeof log.handler === "string") {
    fields.push({
      name: "Fallback Handler",
      value: log.handler,
      inline: false,
    });
  }

  return fields;
}

export async function formatGuardEvent(
  log: QuickNodeDecodedLog,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.guard && typeof log.guard === "string") {
    fields.push({
      name: "Guard",
      value: log.guard,
      inline: false,
    });
  }

  return fields;
}

export async function formatApproveHashEvent(
  log: QuickNodeDecodedLog,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.hash && typeof log.hash === "string") {
    fields.push({
      name: "Hash",
      value: log.hash,
      inline: false,
    });
  }

  if (log.owner && typeof log.owner === "string") {
    fields.push({
      name: "Owner",
      value: log.owner,
      inline: false,
    });
  }

  return fields;
}

export async function formatSignMsgEvent(
  log: QuickNodeDecodedLog,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.msgHash && typeof log.msgHash === "string") {
    fields.push({
      name: "Message Hash",
      value: log.msgHash,
      inline: false,
    });
  }

  return fields;
}
