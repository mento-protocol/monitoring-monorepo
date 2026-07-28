import { hgetWithLegacy, hgetallWithLegacy } from "./intel-legacy-fallback";
import { getRedis } from "./redis";
import { MAX_SNAPSHOT_HASH_BYTES } from "./snapshot-limits";

export const INTEL_ENTITIES_KEY = "intel_entities";
const HASH_KEY = INTEL_ENTITIES_KEY;
const LEGACY_HASH_KEY = "arkham_entities";
export const INTEL_ENTITY_DIRECTORY_MAX_RECORDS = 1_000;
export const INTEL_ENTITY_DIRECTORY_MAX_BYTES = MAX_SNAPSHOT_HASH_BYTES;

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

type EntityHashField = readonly [string, string];

function selectDirectoryFields(
  intelFields: string[],
  legacyFields: string[],
): EntityHashField[] | null {
  const fieldsByCanonicalSlug = new Map<string, EntityHashField>();
  for (const field of legacyFields) {
    fieldsByCanonicalSlug.set(field.toLowerCase(), [LEGACY_HASH_KEY, field]);
  }
  for (const field of intelFields) {
    fieldsByCanonicalSlug.set(field.toLowerCase(), [HASH_KEY, field]);
  }
  if (fieldsByCanonicalSlug.size > INTEL_ENTITY_DIRECTORY_MAX_RECORDS) {
    return null;
  }
  return Array.from(fieldsByCanonicalSlug.values());
}

async function fetchDirectoryFields(
  redis: ReturnType<typeof getRedis>,
  fields: EntityHashField[],
): Promise<Record<string, IntelEntityRecord>> {
  const intelFieldsToFetch: string[] = [];
  const legacyFieldsToFetch: string[] = [];
  for (const [key, field] of fields) {
    if (key === HASH_KEY) intelFieldsToFetch.push(field);
    else legacyFieldsToFetch.push(field);
  }
  const [fromIntel, fromLegacy] = await Promise.all([
    intelFieldsToFetch.length > 0
      ? redis.hmget<Record<string, IntelEntityRecord>>(
          HASH_KEY,
          ...intelFieldsToFetch,
        )
      : {},
    legacyFieldsToFetch.length > 0
      ? redis.hmget<Record<string, IntelEntityRecord>>(
          LEGACY_HASH_KEY,
          ...legacyFieldsToFetch,
        )
      : {},
  ]);
  const entities: Record<string, IntelEntityRecord> = {};
  for (const [key, value] of Object.entries(
    (fromLegacy ?? {}) as Record<string, IntelEntityRecord>,
  )) {
    entities[key.toLowerCase()] = value;
  }
  for (const [key, value] of Object.entries(
    (fromIntel ?? {}) as Record<string, IntelEntityRecord>,
  )) {
    entities[key.toLowerCase()] = value;
  }
  return entities;
}

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
 * Admit the selected entity snapshots only while their combined Redis
 * footprint stays within the directory's explicit server-side bounds. HLEN
 * and HSTRLEN inspect metadata without transferring the stored JSON values;
 * HMGET fetches the winning current-or-legacy fields only after both checks
 * pass.
 */
export async function getIntelEntityDirectorySource(): Promise<IntelEntityDirectorySource> {
  const redis = getRedis();
  // The early-return guard is the result of these metadata reads; it cannot
  // run before them, and it keeps the much larger record fetch behind the cap.
  // react-doctor-disable-next-line react-doctor/async-defer-await
  const [intelCount, legacyCount] = await Promise.all([
    redis.hlen(HASH_KEY),
    redis.hlen(LEGACY_HASH_KEY),
  ]);
  if (
    intelCount > INTEL_ENTITY_DIRECTORY_MAX_RECORDS ||
    legacyCount > INTEL_ENTITY_DIRECTORY_MAX_RECORDS
  ) {
    return { entities: null, limited: true, reason: "record-count" };
  }

  const [intelFields, legacyFields] = await Promise.all([
    redis.hkeys(HASH_KEY),
    redis.hkeys(LEGACY_HASH_KEY),
  ]);
  const fields = selectDirectoryFields(intelFields, legacyFields);
  if (!fields) {
    return { entities: null, limited: true, reason: "record-count" };
  }

  const pipeline = redis.pipeline();
  for (const [key, field] of fields) pipeline.hstrlen(key, field);
  const sizes = fields.length === 0 ? [] : await pipeline.exec<number[]>();
  const payloadBytes = sizes.reduce((total, size) => total + size, 0);
  if (payloadBytes > INTEL_ENTITY_DIRECTORY_MAX_BYTES) {
    return { entities: null, limited: true, reason: "payload-bytes" };
  }

  return {
    entities: await fetchDirectoryFields(redis, fields),
    limited: false,
  };
}
