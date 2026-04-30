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
  ARKHAM_TAG,
  MINIPAY_SOURCE,
  isArkhamSourced,
  isMiniPaySourced,
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
// target scope and (optionally) HDELs the same addresses from every other
// `labels:*` scope.
//
// The enumeration of "other" scopes happens INSIDE the script's atomic
// window — a separate client-side SCAN → EVAL would re-open the race
// window where two concurrent writers each compute their `otherKeys` list
// before either commits, miss each other's new scope, and leave the same
// address in two scopes (violating the strict either/or invariant).
//
// Contract:
//   KEYS[1]    = target scope key (`labels:global` or `labels:{chainId}`)
//   ARGV[1]    = decimal count N of (address, value) pairs
//   ARGV[2]    = "1" (run cross-scope HDEL) | "0" (skip — caller asserts
//                addresses are fresh in every scope)
//   ARGV[3..]  = address, JSON-value, address, JSON-value, … (2N strings)
//
// The `crossScopeHdel: false` path exists because `KEYS 'labels:*'` is
// O(total-keys-in-db). After PR #258 sharded `minipay:users` into 16 SETs
// with ~1M members each (16M+ Redis members), the post-HSET KEYS scan
// pushes script execution past Upstash's 250 ms per-script Lua timeout —
// even though the labels keyspace itself is still tiny (~3 keys).
//
// Cron-driven writes (`/api/minipay/tag?mode=new`, `/api/arkham/enrich`)
// already filter out any address present in any scope before writing,
// making the cross-scope HDEL provably a no-op. They opt out via "0".
// User-driven writes (PUT, mode=refresh) keep the default "1" because
// users *do* move entries between scopes via the editor.
//
// Returns the number of pairs written (for assertions/logging).
const STRICT_EITHER_OR_SCRIPT = `
local targetKey = KEYS[1]
local count = tonumber(ARGV[1])
if count == nil or count <= 0 then return 0 end
local crossScopeHdel = ARGV[2] == '1'

local addrs = {}
local hsetArgs = { targetKey }
for i = 0, count - 1 do
  local addr = ARGV[3 + i * 2]
  local value = ARGV[4 + i * 2]
  addrs[#addrs + 1] = addr
  hsetArgs[#hsetArgs + 1] = addr
  hsetArgs[#hsetArgs + 1] = value
end
redis.call('HSET', unpack(hsetArgs))

if crossScopeHdel then
  -- KEYS 'labels:*' is O(total-keys-in-db). Acceptable for low-frequency
  -- user-driven writes; cron callers opt out via crossScopeHdel = '0'.
  local otherKeys = redis.call('KEYS', 'labels:*')
  for _, k in ipairs(otherKeys) do
    if k ~= targetKey then
      redis.call('HDEL', k, unpack(addrs))
    end
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
  const targetKey = labelsKey(scope);

  // User-driven write: cross-scope HDEL must run inside the script for
  // race-free semantics (the user may be moving an entry between scopes).
  await redis.eval(
    STRICT_EITHER_OR_SCRIPT,
    [targetKey],
    ["1", "1", lower, JSON.stringify(value)],
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
 * Uses the same atomic Lua script as `upsertEntry`. Set
 * `crossScopeHdel: false` when the caller has independently established
 * that none of the addresses live in any other scope (e.g. cron writes
 * that already filter against `getAllLabels()`). Skipping the in-script
 * `KEYS 'labels:*'` scan avoids tripping Upstash's per-script Lua timeout
 * once the database keyspace grows large — see STRICT_EITHER_OR_SCRIPT.
 *
 * Default `true` preserves the strict either/or invariant for callers
 * (e.g. user-driven `import`) that may move addresses between scopes.
 */
export async function importLabels(
  scope: Scope,
  labels: Record<string, AddressEntry>,
  options: { crossScopeHdel?: boolean } = {},
): Promise<void> {
  const entries = Object.entries(labels);
  if (entries.length === 0) return;
  const redis = getRedis();
  const targetKey = labelsKey(scope);

  const crossScopeHdel = options.crossScopeHdel === false ? "0" : "1";
  const args: string[] = [String(entries.length), crossScopeHdel];
  const now = new Date().toISOString();
  for (const [addr, entry] of entries) {
    const normalized: AddressEntry = {
      ...entry,
      isPublic: entry.isPublic === true,
      createdAt: entry.createdAt ?? now,
      updatedAt: entry.updatedAt ?? now,
    };
    args.push(addr.toLowerCase(), JSON.stringify(normalized));
  }

  await redis.eval(STRICT_EITHER_OR_SCRIPT, [targetKey], args);
}
