import { getRedis } from "./redis";

export const INTEL_ENTITIES_KEY = "intel_entities";
const HASH_KEY = INTEL_ENTITIES_KEY;

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

/** Slug validation regex shared by the entity + entity-cps API routes. */
export const INTEL_ENTITY_SLUG_RE = /^[a-z0-9_-]{1,128}$/;

export async function getIntelEntity(
  slug: string,
): Promise<IntelEntityRecord | null> {
  const redis = getRedis();
  return redis.hget<IntelEntityRecord>(HASH_KEY, slug);
}

export async function getAllIntelEntities(): Promise<
  Record<string, IntelEntityRecord>
> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, IntelEntityRecord>>(HASH_KEY);
  return raw ?? {};
}

export async function hkeysIntelEntities(): Promise<string[]> {
  const redis = getRedis();
  return redis.hkeys(HASH_KEY);
}
