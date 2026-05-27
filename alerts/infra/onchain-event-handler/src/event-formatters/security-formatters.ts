/**
 * Formatters for security-related events
 */

import type { NotificationField, QuickNodeDecodedLog } from "../types";

export async function formatThresholdEvent(
  log: QuickNodeDecodedLog,
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

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
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

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
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

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
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

  // ABI field name is `approvedHash` (per safe-abi.json); QuickNode passes
  // through the ABI input name on decoded logs. Reading `log.hash` would
  // always be undefined and the embed would drop the field silently.
  const approvedHash = log.approvedHash ?? log.hash;
  if (approvedHash && typeof approvedHash === "string") {
    fields.push({
      name: "Hash",
      value: approvedHash,
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
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

  if (log.msgHash && typeof log.msgHash === "string") {
    fields.push({
      name: "Message Hash",
      value: log.msgHash,
      inline: false,
    });
  }

  return fields;
}
