import type { IntelEntityRecord } from "@/lib/intel-entities";
import { parseEntityAddresses } from "./entity-addresses";

export const ENTITY_ADDRESS_SEARCH_LIMIT = 50;

export type EntityDirectoryItem = {
  slug: string;
  name: string;
  type: string | null;
  addressCount: number;
  tags: string[];
  searchText: string;
};

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function entityTagLabels(populatedTags: unknown): string[] {
  if (!Array.isArray(populatedTags)) return [];
  const labels: string[] = [];
  for (const tag of populatedTags) {
    if (typeof tag !== "object" || tag === null) continue;
    const legacyTag = tag as Record<string, unknown>;
    const label =
      trimmedString(legacyTag.label) ||
      trimmedString(legacyTag.name) ||
      trimmedString(legacyTag.slug);
    if (label) labels.push(label);
  }
  return labels;
}

export function buildEntityDirectoryItems(
  entities: Record<string, IntelEntityRecord>,
): EntityDirectoryItem[] {
  return Object.entries(entities)
    .map(([key, entity]) => {
      const record =
        typeof entity === "object" && entity !== null
          ? (entity as Partial<IntelEntityRecord>)
          : {};
      const slug = trimmedString(record.slug) || key;
      const name = trimmedString(record.name) || slug;
      const type = trimmedString(record.type) || null;
      const tags = entityTagLabels(record.populatedTags);
      const addresses = parseEntityAddresses(record.addresses);

      return {
        slug,
        name,
        type,
        addressCount: addresses.length,
        tags,
        searchText: [
          name,
          slug,
          type ?? "",
          ...tags,
          ...addresses
            .slice(0, ENTITY_ADDRESS_SEARCH_LIMIT)
            .map((entry) => entry.address),
        ]
          .join("\n")
          .toLowerCase(),
      };
    })
    .sort((a, b) => {
      const nameComparison = a.name.localeCompare(b.name);
      return nameComparison || a.slug.localeCompare(b.slug);
    });
}
