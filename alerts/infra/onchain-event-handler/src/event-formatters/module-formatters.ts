/**
 * Formatters for module management events (EnabledModule, DisabledModule)
 */

import type { DiscordEmbedField, QuickNodeDecodedLog } from "../types";

export async function formatModuleEvent(
  log: QuickNodeDecodedLog,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.module && typeof log.module === "string") {
    fields.push({
      name: "Module",
      value: log.module,
      inline: false,
    });
  }

  return fields;
}
