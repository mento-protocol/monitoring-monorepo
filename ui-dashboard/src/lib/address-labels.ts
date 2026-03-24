import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddressLabelEntry = {
  label: string;
  category?: string;
  notes?: string;
  isPublic?: boolean;
  updatedAt: string;
};

/** Full record as returned from the API -- includes the address itself. */
export type AddressLabelRecord = AddressLabelEntry & {
  address: string;
};

/** Shape of a full export/backup snapshot. */
export type AddressLabelsSnapshot = {
  exportedAt: string;
  /** chainId → address (lower) → entry */
  chains: Record<string, Record<string, AddressLabelEntry>>;
};

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function labelsKey(chainId: number): string {
  return `labels:${chainId}`;
}

// ---------------------------------------------------------------------------
// Redis client (server-side only)
// ---------------------------------------------------------------------------

export function getRedis(): Redis {
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
): Promise<Record<string, AddressLabelEntry>> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, AddressLabelEntry>>(
    labelsKey(chainId),
  );
  const all = raw ?? {};
  if (options?.publicOnly) {
    return Object.fromEntries(
      Object.entries(all).filter(([, entry]) => entry.isPublic === true),
    );
  }
  return all;
}

export async function upsertLabel(
  chainId: number,
  address: string,
  entry: Omit<AddressLabelEntry, "updatedAt">,
): Promise<void> {
  const redis = getRedis();
  const value: AddressLabelEntry = {
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  await redis.hset(labelsKey(chainId), { [address.toLowerCase()]: value });
}

export async function deleteLabel(
  chainId: number,
  address: string,
): Promise<void> {
  const redis = getRedis();
  await redis.hdel(labelsKey(chainId), address.toLowerCase());
}

export async function getAllChainLabels(): Promise<
  Record<string, Record<string, AddressLabelEntry>>
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

  const result: Record<string, Record<string, AddressLabelEntry>> = {};
  await Promise.all(
    allKeys.map(async (key) => {
      const raw = await redis.hgetall<Record<string, AddressLabelEntry>>(key);
      if (raw) {
        const chainId = key.replace("labels:", "");
        result[chainId] = raw;
      }
    }),
  );
  return result;
}

export async function importLabels(
  chainId: number,
  labels: Record<string, AddressLabelEntry>,
): Promise<void> {
  if (Object.keys(labels).length === 0) return;
  const redis = getRedis();
  // Normalise addresses to lowercase, ensure updatedAt is set, and enforce
  // strict boolean for isPublic (reject truthy strings like "yes").
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
