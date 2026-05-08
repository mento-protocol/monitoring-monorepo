import { Redis } from "@upstash/redis";
import { NETWORKS } from "@/lib/networks";

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

// Deterministic legacy-key list for the migration + transition dual-read.
// SCAN MATCH labels:* would walk the whole Upstash keyspace (16M+ keys for
// minipay:users:*) and time out the migration route. Build the list from
// NETWORKS' chainIds + retired ones so we never miss a hash.
const RETIRED_CHAIN_IDS = [
  // Hosted celo-baklava + celo-alfajores pre-Sepolia retirement; included
  // defensively so an old `labels:{chainId}` hash from before the testnet
  // swap still lands in the migration.
  44787, // alfajores
  62320, // baklava
];
const KNOWN_LEGACY_KEYS: readonly string[] = (() => {
  const chainIds = new Set<number>(RETIRED_CHAIN_IDS);
  for (const net of Object.values(NETWORKS)) chainIds.add(net.chainId);
  return ["labels:global", ...[...chainIds].map((id) => `labels:${id}`)];
})();

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
 *
 * Dual-reads the legacy per-scope hashes too, merging with `flat-wins` on
 * conflict. This makes the deploy-then-run-migration sequence safe: between
 * the deploy and the one-shot `/api/address-labels/migrate-flat` call,
 * existing data still surfaces in the UI, exports, and cron filters.
 *
 * After the migration drops the legacy keys, those reads return empty and
 * the merge is effectively flat-only. Plan to remove the legacy half of the
 * read in a follow-up once production is fully migrated (tracked in
 * BACKLOG.md).
 */
export async function getLabels(): Promise<Record<string, AddressEntry>> {
  const redis = getRedis();
  const [flatRaw, ...legacyRaws] = await Promise.all([
    redis.hgetall<Record<string, Record<string, unknown>>>(LABELS_KEY),
    ...KNOWN_LEGACY_KEYS.map((key) =>
      redis.hgetall<Record<string, Record<string, unknown>>>(key),
    ),
  ]);

  const merged: Record<string, AddressEntry> = {};
  for (const raw of legacyRaws) {
    if (!raw) continue;
    Object.assign(merged, upgradeEntries(raw as Record<string, unknown>));
  }
  // Flat wins on conflict — the migration writes resolved entries here, so
  // post-migration the flat hash is authoritative.
  if (flatRaw) {
    Object.assign(merged, upgradeEntries(flatRaw as Record<string, unknown>));
  }
  return merged;
}

/**
 * Flat-only read — bypasses the legacy dual-read in `getLabels()`. Used by
 * the migration route to detect user edits made via the UI during the
 * deploy → migrate-flat window so they survive the merge instead of being
 * clobbered by stale legacy data.
 */
export async function getFlatLabels(): Promise<Record<string, AddressEntry>> {
  const redis = getRedis();
  const raw =
    await redis.hgetall<Record<string, Record<string, unknown>>>(LABELS_KEY);
  return raw ? upgradeEntries(raw as Record<string, unknown>) : {};
}

/**
 * Read a single address entry. Cheaper than `getLabels()` for the common
 * "look up prior entry to preserve provenance/createdAt" pattern in the
 * PUT handler — one HGET vs HGETALL of the entire hash.
 *
 * Falls back to the legacy scopes when the address isn't in the flat hash
 * yet, so PUT-on-an-already-labelled-address keeps Arkham/MiniPay source
 * across the migration window.
 */
export async function getLabel(address: string): Promise<AddressEntry | null> {
  const redis = getRedis();
  const lower = address.toLowerCase();
  const flat = await redis.hget<Record<string, unknown>>(LABELS_KEY, lower);
  if (flat) return upgradeEntry(flat);
  // HMGET across legacy keys via Promise.all of HGETs (Upstash REST has no
  // multi-key HMGET). One round trip per legacy key but they're a small,
  // bounded set.
  const legacy = await Promise.all(
    KNOWN_LEGACY_KEYS.map((k) => redis.hget<Record<string, unknown>>(k, lower)),
  );
  for (const entry of legacy) {
    if (entry) return upgradeEntry(entry);
  }
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
  // Delete from the flat hash AND from every legacy scope. Without the
  // legacy half, a delete during the deploy → migration window would only
  // remove the flat copy; the legacy scope still has the entry, so the
  // dual-read in `getLabels()` resurrects it on the next refetch and the
  // migration later copies it back into the flat hash. After the migration
  // drops the legacy keys, the legacy HDELs are no-ops.
  await Promise.all([
    redis.hdel(LABELS_KEY, lower),
    ...KNOWN_LEGACY_KEYS.map((key) => redis.hdel(key, lower)),
  ]);
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
 * Read multiple address entries from the flat hash in one HMGET. Used by
 * the migration route to verify a write without re-reading the full hash.
 * Returns a sparse array aligned with `addresses` — null at indexes where
 * no entry exists.
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

/**
 * Read every legacy scope hash from the deterministic key list. Returns the
 * raw key list alongside the per-scope entries so the caller can pass it
 * back to `dropLegacyScopes` without a second round of lookups.
 */
export async function readLegacyScopes(): Promise<{
  legacyKeys: string[];
  scopes: Array<{ key: string; entries: Record<string, AddressEntry> }>;
}> {
  const redis = getRedis();

  const raws = await Promise.all(
    KNOWN_LEGACY_KEYS.map((key) =>
      redis.hgetall<Record<string, Record<string, unknown>>>(key),
    ),
  );

  const scopes: Array<{ key: string; entries: Record<string, AddressEntry> }> =
    [];
  const legacyKeys: string[] = [];
  for (let i = 0; i < KNOWN_LEGACY_KEYS.length; i++) {
    const raw = raws[i];
    if (!raw || Object.keys(raw).length === 0) continue;
    const key = KNOWN_LEGACY_KEYS[i];
    legacyKeys.push(key);
    scopes.push({
      key,
      entries: upgradeEntries(raw as Record<string, unknown>),
    });
  }

  return { legacyKeys, scopes };
}

/**
 * Delete the legacy per-scope hashes. Pass the `legacyKeys` returned by
 * `readLegacyScopes` (only the hashes that actually existed). Idempotent —
 * DEL on missing keys is a no-op.
 */
export async function dropLegacyScopes(legacyKeys: string[]): Promise<void> {
  if (legacyKeys.length === 0) return;
  const redis = getRedis();
  await redis.del(...legacyKeys);
}
