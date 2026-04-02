import { Redis } from "@upstash/redis";

// Re-export all isomorphic types and utilities from the shared module.
// This keeps backward-compat for existing imports from "@/lib/address-labels"
// while allowing client components to import directly from
// "@/lib/address-labels-shared" without pulling in Redis.
export {
  type AddressEntry,
  type AddressLabelEntry,
  type AddressEntryRecord,
  type AddressLabelRecord,
  type AddressLabelsSnapshot,
  upgradeEntry,
  upgradeEntries,
  sanitizeEntry,
} from "./address-labels-shared";

import { upgradeEntries, type AddressEntry } from "./address-labels-shared";

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function labelsKey(chainId: number): string {
  return `labels:${chainId}`;
}

// ---------------------------------------------------------------------------
// Redis client (server-side only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Data access helpers (all server-side)
// ---------------------------------------------------------------------------

export async function getLabels(
  chainId: number,
  options?: { publicOnly?: boolean },
): Promise<Record<string, AddressEntry>> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, Record<string, unknown>>>(
    labelsKey(chainId),
  );
  const all = raw ? upgradeEntries(raw as Record<string, unknown>) : {};
  if (options?.publicOnly) {
    return Object.fromEntries(
      Object.entries(all).filter(([, entry]) => entry.isPublic === true),
    );
  }
  return all;
}

export async function upsertEntry(
  chainId: number,
  address: string,
  entry: Omit<AddressEntry, "updatedAt">,
): Promise<void> {
  const redis = getRedis();
  const value: AddressEntry = {
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  await redis.hset(labelsKey(chainId), { [address.toLowerCase()]: value });
}

/** @deprecated Use upsertEntry instead */
export const upsertLabel = upsertEntry;

export async function deleteLabel(
  chainId: number,
  address: string,
): Promise<void> {
  const redis = getRedis();
  await redis.hdel(labelsKey(chainId), address.toLowerCase());
}

export async function getAllChainLabels(): Promise<
  Record<string, Record<string, AddressEntry>>
> {
  const redis = getRedis();

  // SCAN is cursor-based and may require multiple iterations to return all
  // keys. A single call risks producing incomplete exports.
  const allKeys: string[] = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, {
      match: "labels:*",
      count: 100,
    });
    cursor = Number(nextCursor);
    allKeys.push(...batch);
  } while (cursor !== 0);

  const result: Record<string, Record<string, AddressEntry>> = {};
  await Promise.all(
    allKeys.map(async (key) => {
      const raw =
        await redis.hgetall<Record<string, Record<string, unknown>>>(key);
      if (raw) {
        const chainId = key.replace("labels:", "");
        result[chainId] = upgradeEntries(raw as Record<string, unknown>);
      }
    }),
  );
  return result;
}

export async function importLabels(
  chainId: number,
  labels: Record<string, AddressEntry>,
): Promise<void> {
  if (Object.keys(labels).length === 0) return;
  const redis = getRedis();
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
  await redis.hset(labelsKey(chainId), normalised);
}
