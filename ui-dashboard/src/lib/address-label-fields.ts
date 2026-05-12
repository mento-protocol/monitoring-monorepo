import type { AddressEntry } from "./address-labels-shared";

export const LABELS_KEY = "labels";

export function encodeLabelFields(
  entries: Array<[string, AddressEntry]>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const now = new Date().toISOString();
  for (const [addr, entry] of entries) {
    const normalized: AddressEntry = {
      ...entry,
      isPublic: entry.isPublic === true,
      createdAt: entry.createdAt ?? now,
      updatedAt: entry.updatedAt ?? now,
    };
    fields[addr.toLowerCase()] = JSON.stringify(normalized);
  }
  return fields;
}
