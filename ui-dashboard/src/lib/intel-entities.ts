import { hgetWithLegacy, hgetallWithLegacy } from "./intel-legacy-fallback";
import { getRedis } from "./redis";

export const INTEL_ENTITIES_KEY = "intel_entities";
const HASH_KEY = INTEL_ENTITIES_KEY;
const LEGACY_HASH_KEY = "arkham_entities";
export const INTEL_ENTITY_DIRECTORY_MAX_RECORDS = 1_000;
export const INTEL_ENTITY_DIRECTORY_MAX_BYTES = 2 * 1024 * 1024;

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

export type IntelEntityDirectorySource =
  | {
      entities: Record<string, IntelEntityRecord>;
      limited: false;
    }
  | {
      entities: null;
      limited: true;
      reason: "record-count" | "payload-bytes";
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

/**
 * Admit the full entity snapshots only while their combined Redis footprint
 * stays within the directory's explicit server-side bounds. HLEN and HSTRLEN
 * inspect metadata without transferring the stored JSON values; HGETALL runs
 * only after both the record-count and payload-byte checks pass.
 */
export async function getIntelEntityDirectorySource(): Promise<IntelEntityDirectorySource> {
  const redis = getRedis();
  // The early-return guard is the result of these metadata reads; it cannot
  // run before them, and it keeps the much larger HGETALL behind the cap.
  // react-doctor-disable-next-line react-doctor/async-defer-await
  const [intelCount, legacyCount] = await Promise.all([
    redis.hlen(HASH_KEY),
    redis.hlen(LEGACY_HASH_KEY),
  ]);
  if (intelCount + legacyCount > INTEL_ENTITY_DIRECTORY_MAX_RECORDS) {
    return { entities: null, limited: true, reason: "record-count" };
  }

  const [intelFields, legacyFields] = await Promise.all([
    redis.hkeys(HASH_KEY),
    redis.hkeys(LEGACY_HASH_KEY),
  ]);
  const fields = [
    ...intelFields.map((field) => [HASH_KEY, field] as const),
    ...legacyFields.map((field) => [LEGACY_HASH_KEY, field] as const),
  ];
  const pipeline = redis.pipeline();
  for (const [key, field] of fields) pipeline.hstrlen(key, field);
  const sizes = fields.length === 0 ? [] : await pipeline.exec<number[]>();
  const payloadBytes = sizes.reduce((total, size) => total + size, 0);
  if (payloadBytes > INTEL_ENTITY_DIRECTORY_MAX_BYTES) {
    return { entities: null, limited: true, reason: "payload-bytes" };
  }

  return { entities: await getAllIntelEntities(), limited: false };
}
