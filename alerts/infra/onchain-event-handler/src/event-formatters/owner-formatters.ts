/**
 * Formatters for owner management events (AddedOwner, RemovedOwner)
 */

import type { DiscordEmbedField, QuickNodeDecodedLog } from "../types";

export async function formatOwnerEvent(
  log: QuickNodeDecodedLog,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.owner && typeof log.owner === "string") {
    fields.push({
      name: "Owner",
      value: log.owner,
      inline: false,
    });
  }

  return fields;
}
