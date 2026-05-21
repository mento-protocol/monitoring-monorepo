import {
  hgetWithLegacy,
  hgetallWithLegacy,
  hkeysWithLegacy,
} from "./intel-legacy-fallback";

export const INTEL_ENTITIES_KEY = "intel_entities";
const HASH_KEY = INTEL_ENTITIES_KEY;
const LEGACY_HASH_KEY = "arkham_entities";

// Types

type ArkhamTag = {
  id: string;
  label: string;
  rank: number;
  excludeEntities: boolean;
  disablePage: boolean;
  tagParams: unknown;
};

export type IntelEntityRecord = {
  slug: string;
  fetchedAt: string;
  name: string;
  note: string;
  id: string;
  customized: boolean;
  type: string;
  service: unknown;
  addresses: unknown;
  website: string | null;
  twitter: string | null;
  crunchbase: string | null;
  linkedin: string | null;
  populatedTags: ArkhamTag[] | null;
};

/**
 * Slug validation regex shared by the entity + entity-cps API routes.
 * Arkham slugs can contain dots (e.g. `crypto.com`) — extraction stores
 * whatever Arkham returns, so the regex has to accept them or the API
 * route 400s a record that exists in Redis.
 */
export const INTEL_ENTITY_SLUG_RE = /^[a-z0-9_.-]{1,128}$/;

export async function getIntelEntity(
  slug: string,
): Promise<IntelEntityRecord | null> {
  return hgetWithLegacy<IntelEntityRecord>(HASH_KEY, LEGACY_HASH_KEY, slug);
}

export async function getAllIntelEntities(): Promise<
  Record<string, IntelEntityRecord>
> {
  return hgetallWithLegacy<IntelEntityRecord>(HASH_KEY, LEGACY_HASH_KEY);
}

export async function hkeysIntelEntities(): Promise<string[]> {
  return hkeysWithLegacy(HASH_KEY, LEGACY_HASH_KEY);
}
