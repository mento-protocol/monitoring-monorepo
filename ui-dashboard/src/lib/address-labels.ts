import { getRedis } from "./redis";
import { encodeLabelFields, LABELS_KEY } from "./address-label-fields";

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

const HSET_IF_ABSENT_SCRIPT = `
local written = 0
for i = 1, #ARGV, 2 do
  local field = ARGV[i]
  local value = ARGV[i + 1]
  if redis.call("HGET", KEYS[1], field) == false then
    redis.call("HSET", KEYS[1], field, value)
    written = written + 1
  end
end
return written
`;

/**
 * Insert labels only for addresses that are still unlabeled at write time.
 * Used by background provenance jobs where the pre-filter read can race with
 * a user/manual label write.
 */
export async function importLabelsIfAbsent(
  labels: Record<string, AddressEntry>,
): Promise<number> {
  const entries = Object.entries(labels);
  if (entries.length === 0) return 0;

  const redis = getRedis();
  const fields = encodeLabelFields(entries);
  const argv = Object.entries(fields).flatMap(([field, value]) => [
    field,
    value,
  ]);
  const written = await redis.eval(HSET_IF_ABSENT_SCRIPT, [LABELS_KEY], argv);
  return Number(written);
}
