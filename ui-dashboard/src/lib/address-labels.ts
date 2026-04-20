import { Redis } from "@upstash/redis";

// Re-export all isomorphic types and utilities from the shared module.
// This keeps backward-compat for existing imports from "@/lib/address-labels"
// while allowing client components to import directly from
// "@/lib/address-labels-shared" without pulling in Redis.
export {
  type AddressEntry,
  type AddressEntryRecord,
  type AddressLabelsSnapshot,
  type Scope,
  upgradeEntry,
  upgradeEntries,
  sanitizeEntry,
} from "./address-labels-shared";

import {
  upgradeEntries,
  type AddressEntry,
  type Scope,
} from "./address-labels-shared";

// Redis key helpers

const GLOBAL_KEY = "labels:global";

function labelsKey(scope: Scope): string {
  return scope === "global" ? GLOBAL_KEY : `labels:${scope}`;
}

function parseScopeFromKey(key: string): Scope | null {
  if (key === GLOBAL_KEY) return "global";
  const suffix = key.slice("labels:".length);
  // Strict decimal-only parse — matches the import-route guards so malformed
  // keys like `labels:1e3` or `labels:0x1` don't silently resolve to a valid
  // chainId and collide with real entries in `getAllLabels`.
  if (!/^\d+$/.test(suffix)) return null;
  const n = Number(suffix);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Redis client (server-side only)

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

// Paginated SCAN — returns every existing `labels:*` key.
async function listAllScopeKeys(redis: Redis): Promise<string[]> {
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
  return keys;
}

// Data access helpers (all server-side)

export async function getLabels(
  scope: Scope,
  options?: { publicOnly?: boolean },
): Promise<Record<string, AddressEntry>> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, Record<string, unknown>>>(
    labelsKey(scope),
  );
  const all = raw ? upgradeEntries(raw as Record<string, unknown>) : {};
  if (options?.publicOnly) {
    return Object.fromEntries(
      Object.entries(all).filter(([, entry]) => entry.isPublic === true),
    );
  }
  return all;
}

/**
 * Upsert an entry at the target scope.
 *
 * Uses MULTI/EXEC so HSET + HDELs all succeed or all fail together. The
 * SCAN itself is not atomic with the transaction — a new scope created
 * between SCAN and EXEC will not be cleared — but writes only go through
 * this same function so the race window is narrow to non-existent in
 * practice.
 */
export async function upsertEntry(
  scope: Scope,
  address: string,
  entry: Omit<AddressEntry, "updatedAt">,
): Promise<void> {
  const redis = getRedis();
  const value: AddressEntry = {
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  const lower = address.toLowerCase();
  const targetKey = labelsKey(scope);

  const allKeys = await listAllScopeKeys(redis);
  const otherKeys = allKeys.filter((k) => k !== targetKey);

  const tx = redis.multi();
  tx.hset(targetKey, { [lower]: value });
  for (const k of otherKeys) {
    tx.hdel(k, lower);
  }
  await tx.exec();
}

export async function deleteLabel(
  scope: Scope,
  address: string,
): Promise<void> {
  const redis = getRedis();
  await redis.hdel(labelsKey(scope), address.toLowerCase());
}

/**
 * Read every label across every scope.
 *
 * Returns { global, chains } — `global` holds cross-chain entries,
 * `chains[chainId]` holds chain-specific entries.
 */
export async function getAllLabels(): Promise<{
  global: Record<string, AddressEntry>;
  chains: Record<string, Record<string, AddressEntry>>;
}> {
  const redis = getRedis();
  const allKeys = await listAllScopeKeys(redis);

  let global: Record<string, AddressEntry> = {};
  const chains: Record<string, Record<string, AddressEntry>> = {};

  await Promise.all(
    allKeys.map(async (key) => {
      const raw =
        await redis.hgetall<Record<string, Record<string, unknown>>>(key);
      if (!raw) return;
      const entries = upgradeEntries(raw as Record<string, unknown>);
      const parsedScope = parseScopeFromKey(key);
      if (parsedScope === "global") {
        global = entries;
      } else if (typeof parsedScope === "number") {
        chains[String(parsedScope)] = entries;
      }
      // Silently skip keys that don't parse (shouldn't happen with our SCAN
      // pattern but guards against malformed keys).
    }),
  );

  return { global, chains };
}

/**
 * Import a batch of labels into a single scope.
 *
 * Uses MULTI/EXEC so HSET + HDELs all succeed or all fail together, same as
 * `upsertEntry`. See the note on its SCAN-vs-EXEC race.
 */
export async function importLabels(
  scope: Scope,
  labels: Record<string, AddressEntry>,
): Promise<void> {
  if (Object.keys(labels).length === 0) return;
  const redis = getRedis();
  const targetKey = labelsKey(scope);
  const normalised = Object.fromEntries(
    Object.entries(labels).map(([addr, entry]) => [
      addr.toLowerCase(),
      {
        ...entry,
        isPublic: entry.isPublic === true,
        updatedAt: entry.updatedAt ?? new Date().toISOString(),
      },
    ]),
  );

  const allKeys = await listAllScopeKeys(redis);
  const otherKeys = allKeys.filter((k) => k !== targetKey);
  const lowers = Object.keys(normalised);

  const tx = redis.multi();
  tx.hset(targetKey, normalised);
  if (lowers.length > 0) {
    for (const k of otherKeys) {
      tx.hdel(k, ...lowers);
    }
  }
  await tx.exec();
}
