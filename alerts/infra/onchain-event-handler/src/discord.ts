/**
 * Discord message formatting.
 *
 * Kept as a formatting adapter while the infrastructure finishes moving
 * on-chain event delivery to Slack.
 */

import { formatNotificationContent } from "./notifier";
import type { DiscordMessage, QuickNodeDecodedLog } from "./types";

/**
 * Format a Discord message from a log event.
 */
export async function formatDiscordMessage(
  eventName: string,
  log: QuickNodeDecodedLog,
  multisigKey: string,
  txHashMap: Map<string, string>,
  signal?: AbortSignal,
): Promise<DiscordMessage> {
  const content = await formatNotificationContent(
    eventName,
    log,
    multisigKey,
    txHashMap,
    signal,
  );

  return {
    embeds: [
      {
        title: content.title,
        description: content.description,
        color: content.color,
        fields: content.fields,
        timestamp: content.timestamp,
      },
    ],
  };
}
