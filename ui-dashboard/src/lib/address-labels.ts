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
  mergeEntries,
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
const REPLACE_HASH_SCRIPT = `
local key = KEYS[1]
redis.call('DEL', key)
for i = 1, #ARGV, 2 do
  redis.call('HSET', key, ARGV[i], ARGV[i + 1])
end
return 1
`;

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

/**
 * Read every label as a flat address → entry map.
 */
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
  const lower = address.toLowerCase();
  const flat = await redis.hget<Record<string, unknown>>(LABELS_KEY, lower);
  if (flat) return upgradeEntry(flat);
  return null;
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
  const lower = address.toLowerCase();
  await redis.hdel(LABELS_KEY, lower);
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
  const fields = encodeLabelFields(entries);
  await redis.hset(LABELS_KEY, fields);
}

/**
 * Replace the entire flat label hash with the provided snapshot payload.
 * Trusted Blob restores use this instead of importLabels' merge semantics so
 * labels absent from the selected snapshot do not survive the restore.
 */
export async function replaceLabels(
  labels: Record<string, AddressEntry>,
): Promise<void> {
  const entries = Object.entries(labels);
  const redis = getRedis();
  const fields = entries.length > 0 ? encodeLabelFields(entries) : {};
  await redis.eval(REPLACE_HASH_SCRIPT, [LABELS_KEY], flattenFields(fields));
}

function encodeLabelFields(
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

function flattenFields(fields: Record<string, string>): string[] {
  return Object.entries(fields).flatMap(([field, value]) => [field, value]);
}
