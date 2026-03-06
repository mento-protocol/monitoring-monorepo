import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddressLabelEntry = {
  label: string;
  category?: string;
  notes?: string;
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
): Promise<Record<string, AddressLabelEntry>> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, AddressLabelEntry>>(
    labelsKey(chainId),
  );
  return raw ?? {};
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
  // Scan for all labels:* keys to collect every chain's data
  const [, keys] = await redis.scan(0, { match: "labels:*", count: 100 });
  const result: Record<string, Record<string, AddressLabelEntry>> = {};
  await Promise.all(
    keys.map(async (key) => {
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
  // Normalise addresses to lowercase and ensure updatedAt is set
  const normalised = Object.fromEntries(
    Object.entries(labels).map(([addr, entry]) => [
      addr.toLowerCase(),
      { ...entry, updatedAt: entry.updatedAt ?? new Date().toISOString() },
    ]),
  );
  await redis.hset(labelsKey(chainId), normalised);
}
