import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddressEntry = {
  name: string;
  tags: string[];
  notes?: string;
  isPublic?: boolean;
  updatedAt: string;
};

/** @deprecated Use AddressEntry instead */
export type AddressLabelEntry = AddressEntry;

/** Full record as returned from the API -- includes the address itself. */
export type AddressEntryRecord = AddressEntry & {
  address: string;
};

/** @deprecated Use AddressEntryRecord instead */
export type AddressLabelRecord = AddressEntryRecord;

/** Shape of a full export/backup snapshot. */
export type AddressLabelsSnapshot = {
  exportedAt: string;
  /** chainId → address (lower) → entry */
  chains: Record<string, Record<string, AddressEntry>>;
};

// ---------------------------------------------------------------------------
// Backward-compat: auto-upgrade legacy entries on read
// ---------------------------------------------------------------------------

/**
 * If a Redis entry has `label` but no `name`, auto-upgrade to the new schema.
 * This handles both partially-migrated Redis data and stale SWR cache entries.
 */
export function upgradeEntry(raw: Record<string, unknown>): AddressEntry {
  const entry = raw as Record<string, unknown>;

  // Already in v2 format
  if (typeof entry.name === "string") {
    return {
      name: entry.name,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      notes: typeof entry.notes === "string" ? entry.notes : undefined,
      isPublic: entry.isPublic === true ? true : undefined,
      updatedAt:
        typeof entry.updatedAt === "string"
          ? entry.updatedAt
          : new Date().toISOString(),
    };
  }

  // Legacy v1 format: { label, category?, ... }
  if (typeof entry.label === "string") {
    const tags: string[] = [];
    if (typeof entry.category === "string" && entry.category.trim()) {
      tags.push(entry.category.trim());
    }
    return {
      name: entry.label,
      tags,
      notes: typeof entry.notes === "string" ? entry.notes : undefined,
      isPublic: entry.isPublic === true ? true : undefined,
      updatedAt:
        typeof entry.updatedAt === "string"
          ? entry.updatedAt
          : new Date().toISOString(),
    };
  }

  // Fallback: unknown shape — return minimal valid entry
  return {
    name: "",
    tags: [],
    notes: typeof entry.notes === "string" ? entry.notes : undefined,
    isPublic: entry.isPublic === true ? true : undefined,
    updatedAt:
      typeof entry.updatedAt === "string"
        ? entry.updatedAt
        : new Date().toISOString(),
  };
}

export function upgradeEntries(
  raw: Record<string, unknown>,
): Record<string, AddressEntry> {
  const result: Record<string, AddressEntry> = {};
  for (const [address, entry] of Object.entries(raw)) {
    if (typeof entry === "object" && entry !== null) {
      result[address] = upgradeEntry(entry as Record<string, unknown>);
    }
  }
  return result;
}

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
