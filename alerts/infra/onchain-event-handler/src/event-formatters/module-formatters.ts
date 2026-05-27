/**
 * Formatters for module management events (EnabledModule, DisabledModule)
 */

import type { NotificationField, QuickNodeDecodedLog } from "../types";

export async function formatModuleEvent(
  log: QuickNodeDecodedLog,
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

  if (log.module && typeof log.module === "string") {
    fields.push({
      name: "Module",
      value: log.module,
      inline: false,
    });
  }

  return fields;
}
