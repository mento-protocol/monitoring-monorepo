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

function entityTagLabels(entity: IntelEntityRecord): string[] {
  const labels: string[] = [];
  for (const tag of entity.populatedTags ?? []) {
    const legacyTag = tag as typeof tag & {
      name?: string;
      slug?: string;
    };
    const label =
      legacyTag.label?.trim() ||
      legacyTag.name?.trim() ||
      legacyTag.slug?.trim();
    if (label) labels.push(label);
  }
  return labels;
}

export function buildEntityDirectoryItems(
  entities: Record<string, IntelEntityRecord>,
): EntityDirectoryItem[] {
  return Object.entries(entities)
    .map(([key, entity]) => {
      const slug = entity.slug?.trim() || key;
      const name = entity.name?.trim() || slug;
      const type = entity.type?.trim() || null;
      const tags = entityTagLabels(entity);
      const addresses = parseEntityAddresses(entity.addresses);

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
