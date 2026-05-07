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
  isArkhamSourced,
  isMiniPaySourced,
  upgradeEntry,
  upgradeEntries,
  sanitizeEntry,
} from "./address-labels-shared";

import { upgradeEntries, type AddressEntry } from "./address-labels-shared";

// Redis layout: a single `labels` hash keyed by lowercase address. Labels
// are not chain-scoped — same EVM address means same entity (same private
// key derives the same address across every chain), so a single label
// applies wherever the address appears. Earlier per-scope storage caused
// recurring scope-mismatch bugs that the model itself doesn't justify
// (mirrors the reports refactor on PR #330).
const LABELS_KEY = "labels";

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
 * Upsert a label entry for an address. Single-key write; no scope iteration,
 * no cross-scope HDEL — the per-scope architecture was rolled back, so the
 * write is just an HSET.
 */
export async function upsertEntry(
  address: string,
  entry: Omit<AddressEntry, "updatedAt">,
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  const value: AddressEntry = {
    ...entry,
    // Preserve caller-supplied createdAt (read from prior entry); fall back
    // to `now` for first-time writes. Callers that want history preserved
    // must read the prior entry and forward its createdAt — the route
    // helpers in `route.ts` and `arkham/enrich/route.ts` already do this.
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

// Migration helpers — used by `/api/address-labels/migrate-flat` to merge
// per-chain + legacy global entries into the flat `labels` hash. NOT used
// by runtime CRUD.

/**
 * Read every legacy scope key (`labels:global` + `labels:{chainId}`) currently
 * in Redis. Used only by the migration route. Returns the raw per-scope
 * snapshots so the migration can decide how to resolve conflicts.
 */
export async function readLegacyScopes(): Promise<{
  scopes: Array<{
    key: string;
    entries: Record<string, AddressEntry>;
  }>;
}> {
  const redis = getRedis();
  // Paginated SCAN — old codepath had a static NETWORKS-derived list;
  // for the migration we want EVERY existing key matching the legacy
  // pattern, in case some chain isn't in NETWORKS anymore.
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

  // Filter to the legacy shape: `labels:global` or `labels:{number}`. Skip
  // the new flat `labels` key (no colon).
  const legacyKeys = keys.filter((k) => /^labels:(global|\d+)$/.test(k));

  const scopes = await Promise.all(
    legacyKeys.map(async (key) => {
      const raw =
        await redis.hgetall<Record<string, Record<string, unknown>>>(key);
      const entries = raw ? upgradeEntries(raw as Record<string, unknown>) : {};
      return { key, entries };
    }),
  );

  return { scopes };
}

/**
 * Delete the legacy per-scope hashes after the merge is verified. Idempotent
 * (HDEL is a no-op on missing keys via the SCAN-then-DEL pattern).
 */
export async function dropLegacyScopes(): Promise<void> {
  const redis = getRedis();
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

  const legacyKeys = keys.filter((k) => /^labels:(global|\d+)$/.test(k));
  for (const key of legacyKeys) {
    await redis.del(key);
  }
}
