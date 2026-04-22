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

// Lua script that atomically writes a batch of (address, value) pairs to a
// target scope and HDELs the same addresses from every other `labels:*`
// scope. The enumeration of "other" scopes happens inside the script's
// atomic window, closing the race window that a separate SCAN → MULTI
// opens: two concurrent writers creating first-time entries for the same
// address on different chain scopes cannot both miss each other's new key.
//
// Contract:
//   KEYS[1]    = target scope key (`labels:global` or `labels:{chainId}`)
//   ARGV[1]    = decimal count N of (address, value) pairs
//   ARGV[2..]  = address, JSON-value, address, JSON-value, … (2N strings)
//
// Returns the number of pairs written (for assertions/logging).
const STRICT_EITHER_OR_SCRIPT = `
local targetKey = KEYS[1]
local count = tonumber(ARGV[1])
if count == nil or count <= 0 then return 0 end

local addrs = {}
local hsetArgs = { targetKey }
for i = 0, count - 1 do
  local addr = ARGV[2 + i * 2]
  local value = ARGV[3 + i * 2]
  addrs[#addrs + 1] = addr
  hsetArgs[#hsetArgs + 1] = addr
  hsetArgs[#hsetArgs + 1] = value
end
redis.call('HSET', unpack(hsetArgs))

-- KEYS 'labels:*' is O(total-keys-in-db); labels keyspace is tiny (one per
-- scope) so this is acceptable and avoids Lua-side SCAN pagination.
local otherKeys = redis.call('KEYS', 'labels:*')
for _, k in ipairs(otherKeys) do
  if k ~= targetKey then
    redis.call('HDEL', k, unpack(addrs))
  end
end

return count
`;

// Data access helpers (all server-side)

export async function getLabels(
  scope: Scope,
): Promise<Record<string, AddressEntry>> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, Record<string, unknown>>>(
    labelsKey(scope),
  );
  return raw ? upgradeEntries(raw as Record<string, unknown>) : {};
}

/**
 * Upsert an entry at the target scope.
 *
 * Executes HSET + HDEL-from-every-other-scope as a single atomic Lua script
 * on the Redis server. This closes the race where two concurrent writers
 * creating first-time entries for the same address on different chain
 * scopes would each miss the other's new key via a separate SCAN.
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

  await redis.eval(
    STRICT_EITHER_OR_SCRIPT,
    [targetKey],
    ["1", lower, JSON.stringify(value)],
  );
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
 * Uses the same atomic Lua script as `upsertEntry` so a batch write +
 * cross-scope HDEL completes with strict either/or guarantees even under
 * concurrent writers.
 */
export async function importLabels(
  scope: Scope,
  labels: Record<string, AddressEntry>,
): Promise<void> {
  const entries = Object.entries(labels);
  if (entries.length === 0) return;
  const redis = getRedis();
  const targetKey = labelsKey(scope);

  const args: string[] = [String(entries.length)];
  for (const [addr, entry] of entries) {
    const normalized: AddressEntry = {
      ...entry,
      isPublic: entry.isPublic === true,
      updatedAt: entry.updatedAt ?? new Date().toISOString(),
    };
    args.push(addr.toLowerCase(), JSON.stringify(normalized));
  }

  await redis.eval(STRICT_EITHER_OR_SCRIPT, [targetKey], args);
}
