import { Redis } from "@upstash/redis";

// Re-export all isomorphic types and utilities from the shared module.
// This keeps backward-compat for existing imports from "@/lib/address-labels"
// while allowing client components to import directly from
// "@/lib/address-labels-shared" without pulling in Redis.
export {
  type AddressEntry,
  type AddressEntryRecord,
  type AddressLabelsSnapshot,
  type ImportedCounts,
  ARKHAM_TAG,
  MINIPAY_SOURCE,
  derivePreservedSource,
  isArkhamSourced,
  isMiniPaySourced,
  upgradeEntry,
  upgradeEntries,
  sanitizeEntry,
} from "./address-labels-shared";

import {
  upgradeEntry,
  upgradeEntries,
  type AddressEntry,
} from "./address-labels-shared";

// Single `labels` hash keyed by lowercase address — same EVM address means
// same entity, so a single label applies wherever the address appears.
const LABELS_KEY = "labels";
const LEGACY_KEY_PATTERN = /^labels:(global|\d+)$/;

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash Redis not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  return new Redis({ url, token });
}

// Data access helpers (all server-side)

export async function getLabels(): Promise<Record<string, AddressEntry>> {
  const redis = getRedis();
  const raw =
    await redis.hgetall<Record<string, Record<string, unknown>>>(LABELS_KEY);
  return raw ? upgradeEntries(raw as Record<string, unknown>) : {};
}

/**
 * Read a single address entry. Cheaper than `getLabels()` for the common
 * "look up prior entry to preserve provenance/createdAt" pattern in the
 * PUT handler — one HGET vs HGETALL of the entire hash.
 */
export async function getLabel(address: string): Promise<AddressEntry | null> {
  const redis = getRedis();
  const raw = await redis.hget<Record<string, unknown>>(
    LABELS_KEY,
    address.toLowerCase(),
  );
  return raw ? upgradeEntry(raw) : null;
}

export async function upsertEntry(
  address: string,
  entry: Omit<AddressEntry, "updatedAt">,
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  const value: AddressEntry = {
    ...entry,
    // Preserve caller-supplied createdAt (read from prior entry); fall back
    // to `now` for first-time writes.
    createdAt: entry.createdAt ?? now,
    updatedAt: now,
  };
  const lower = address.toLowerCase();
  await redis.hset(LABELS_KEY, { [lower]: JSON.stringify(value) });
}

export async function deleteLabel(address: string): Promise<void> {
  const redis = getRedis();
  await redis.hdel(LABELS_KEY, address.toLowerCase());
}

/**
 * Bulk import a batch of labels. Same shape as `upsertEntry` but as a single
 * HSET call so an N-entry import is one round trip.
 */
export async function importLabels(
  labels: Record<string, AddressEntry>,
): Promise<void> {
  const entries = Object.entries(labels);
  if (entries.length === 0) return;
  const redis = getRedis();

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

  await redis.hset(LABELS_KEY, fields);
}

/**
 * Read multiple address entries in one round trip. Returns a sparse array
 * aligned with `addresses` — null at indexes where no entry exists. Used
 * by the migration route to verify a write without re-reading the entire
 * flat hash.
 */
export async function getLabelsByAddress(
  addresses: string[],
): Promise<Array<AddressEntry | null>> {
  if (addresses.length === 0) return [];
  const redis = getRedis();
  const lowered = addresses.map((a) => a.toLowerCase());
  const raw = await redis.hmget<Record<string, Record<string, unknown>>>(
    LABELS_KEY,
    ...lowered,
  );
  if (!raw) return addresses.map(() => null);
  return lowered.map((addr) => {
    const entry = raw[addr];
    return entry ? upgradeEntry(entry) : null;
  });
}

// Migration helpers — used by `/api/address-labels/migrate-flat` to merge
// per-chain + legacy global entries into the flat `labels` hash. NOT used
// by runtime CRUD.

async function scanLegacyKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, {
      match: "labels:*",
      count: 100,
    });
    cursor = Number(nextCursor);
    keys.push(...batch);
  } while (cursor !== 0);
  // Match `labels:global` or `labels:{number}`; the new flat `labels` key
  // (no colon) doesn't match the SCAN pattern but filter explicitly anyway.
  return keys.filter((k) => LEGACY_KEY_PATTERN.test(k));
}

/**
 * Read every legacy scope key (`labels:global` + `labels:{chainId}`) currently
 * in Redis. Returns both the per-scope snapshots and the raw key list so the
 * caller can pass it to `dropLegacyScopes` without a second SCAN.
 */
export async function readLegacyScopes(): Promise<{
  legacyKeys: string[];
  scopes: Array<{ key: string; entries: Record<string, AddressEntry> }>;
}> {
  const redis = getRedis();
  const legacyKeys = await scanLegacyKeys(redis);

  const scopes = await Promise.all(
    legacyKeys.map(async (key) => {
      const raw =
        await redis.hgetall<Record<string, Record<string, unknown>>>(key);
      const entries = raw ? upgradeEntries(raw as Record<string, unknown>) : {};
      return { key, entries };
    }),
  );

  return { legacyKeys, scopes };
}

/**
 * Delete the legacy per-scope hashes after the merge is verified. Pass the
 * `legacyKeys` returned by `readLegacyScopes` to skip a redundant SCAN.
 * Idempotent — DEL on missing keys is a no-op.
 */
export async function dropLegacyScopes(legacyKeys: string[]): Promise<void> {
  if (legacyKeys.length === 0) return;
  const redis = getRedis();
  await redis.del(...legacyKeys);
}
