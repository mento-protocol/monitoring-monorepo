/**
 * Formatters for owner management events (AddedOwner, RemovedOwner)
 */

import type { NotificationField, QuickNodeDecodedLog } from "../types";

export async function formatOwnerEvent(
  log: QuickNodeDecodedLog,
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

  if (log.owner && typeof log.owner === "string") {
    fields.push({
      name: "Owner",
      value: log.owner,
      inline: false,
    });
  }

  return fields;
}
