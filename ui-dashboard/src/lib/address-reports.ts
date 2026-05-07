import { Redis } from "@upstash/redis";
import { NETWORKS } from "@/lib/networks";
import type { Scope } from "@/lib/address-labels-shared";

// Re-export isomorphic types and helpers so callers can import from a single
// path. Mirrors the address-labels split.
export {
  type AddressReport,
  type AddressReportRecord,
  type AddressReportsIndex,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeReportInput,
  upgradeReport,
  upgradeReports,
} from "./address-reports-shared";

import {
  upgradeReport,
  type AddressReport,
  type AddressReportsIndex,
} from "./address-reports-shared";

// Redis key helpers

const GLOBAL_KEY = "reports:global";

function reportsKey(scope: Scope): string {
  return scope === "global" ? GLOBAL_KEY : `reports:${scope}`;
}

// Static list of every scope key we may ever write to, derived from NETWORKS.
// The strict-either-or Lua script iterates this deterministic key list so two
// concurrent writers see the same set and the cross-scope HDEL stays
// race-safe (Redis serializes Lua executions; HDEL on the target is filtered
// inside the script).
const ALL_REPORT_SCOPE_KEYS: readonly string[] = Object.freeze([
  GLOBAL_KEY,
  ...Array.from(
    new Set(Object.values(NETWORKS).map((n) => `reports:${n.chainId}`)),
  ),
]);

// Set of supported chainIds — orphan keys (e.g. `reports:99999` from legacy /
// manual writes, or a future config drift) are filtered out so callers never
// receive a scope they can't subsequently update via the strict-either-or
// route.
const SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set(
  Object.values(NETWORKS).map((n) => n.chainId),
);

function parseScopeFromKey(key: string): Scope | null {
  if (key === GLOBAL_KEY) return "global";
  const suffix = key.slice("reports:".length);
  if (!/^\d+$/.test(suffix)) return null;
  const n = Number(suffix);
  if (!Number.isInteger(n) || n <= 0) return null;
  return SUPPORTED_CHAIN_IDS.has(n) ? n : null;
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

// Atomic upsert script.
//
// KEYS[1]   = target scope key (`reports:global` or `reports:{chainId}`)
// KEYS[2..] = every OTHER potentially-existent scope key (script filters out
//             KEYS[1] itself so HDEL on the target is a no-op).
// ARGV[1]   = address (lowercase)
// ARGV[2]   = JSON-encoded payload (body + optional title/authorEmail/source)
// ARGV[3]   = ISO timestamp for `now`
//
// Reads the prior record (across every scope, since strict-either-or guarantees
// at most one) inside the script so version increments and createdAt
// preservation are race-free under concurrent writers — the prior version
// is read in the same atomic execution that writes the new one. Returns the
// JSON-encoded persisted record so the caller knows the assigned version.
const UPSERT_SCRIPT = `
local targetKey = KEYS[1]
local addr = ARGV[1]
local payload = cjson.decode(ARGV[2])
local now = ARGV[3]

local prior = nil
for i = 1, #KEYS do
  local existing = redis.call('HGET', KEYS[i], addr)
  if existing then
    prior = cjson.decode(existing)
    break
  end
end

payload.createdAt = (prior and prior.createdAt) or now
payload.updatedAt = now
payload.version = ((prior and prior.version) or 0) + 1

local encoded = cjson.encode(payload)
redis.call('HSET', targetKey, addr, encoded)

for i = 2, #KEYS do
  if KEYS[i] ~= targetKey then
    redis.call('HDEL', KEYS[i], addr)
  end
end

return encoded
`;

// Data access helpers (all server-side)

export async function getReport(
  scope: Scope,
  address: string,
): Promise<AddressReport | null> {
  const redis = getRedis();
  const raw = await redis.hget<Record<string, unknown>>(
    reportsKey(scope),
    address.toLowerCase(),
  );
  return raw ? upgradeReport(raw) : null;
}

/**
 * Read the report for an address across every scope (strict either/or means
 * at most one will be present). Returns the first match or null.
 *
 * Issues all per-scope HGETs in parallel — sequential reads added 150–400 ms
 * to every modal open and every save (5 RTTs × Upstash REST latency).
 */
export async function findReport(
  address: string,
): Promise<{ scope: Scope; report: AddressReport } | null> {
  const redis = getRedis();
  const lower = address.toLowerCase();
  const results = await Promise.all(
    ALL_REPORT_SCOPE_KEYS.map(async (key) => {
      const raw = await redis.hget<Record<string, unknown>>(key, lower);
      if (!raw) return null;
      const scope = parseScopeFromKey(key);
      if (scope === null) return null;
      return { scope, report: upgradeReport(raw) };
    }),
  );
  return (
    results.find(
      (r): r is { scope: Scope; report: AddressReport } => r !== null,
    ) ?? null
  );
}

/**
 * Upsert a report at the target scope. Atomically increments `version` and
 * preserves `createdAt` from any prior record (across every scope) inside
 * a single Lua execution — concurrent writers can no longer both observe
 * the same prior version and both write `version + 1`.
 *
 * Strict-either-or is preserved by HDEL'ing the address from every other
 * scope in the same atomic block.
 */
export async function upsertReport(
  scope: Scope,
  address: string,
  payload: {
    body: string;
    title?: string;
    authorEmail?: string;
    source?: AddressReport["source"];
  },
): Promise<AddressReport> {
  const redis = getRedis();
  const lower = address.toLowerCase();
  const targetKey = reportsKey(scope);
  const now = new Date().toISOString();

  // Send only user-controlled fields; the Lua script stamps createdAt /
  // updatedAt / version atomically based on the prior record.
  const partial = {
    body: payload.body,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.authorEmail ? { authorEmail: payload.authorEmail } : {}),
    ...(payload.source ? { source: payload.source } : {}),
  };

  const encoded = (await redis.eval(
    UPSERT_SCRIPT,
    [targetKey, ...ALL_REPORT_SCOPE_KEYS],
    [lower, JSON.stringify(partial), now],
  )) as string;

  return upgradeReport(JSON.parse(encoded) as Record<string, unknown>);
}

export async function deleteReport(
  scope: Scope,
  address: string,
): Promise<void> {
  const redis = getRedis();
  await redis.hdel(reportsKey(scope), address.toLowerCase());
}

/**
 * Read just the addresses that have a report at each scope. Reads field
 * names only (HKEYS) — does NOT pull the 50KB report bodies the way an
 * HGETALL would, so the index endpoint stays cheap to poll on a 60s loop.
 */
export async function getReportsIndex(): Promise<AddressReportsIndex> {
  const redis = getRedis();
  const result: AddressReportsIndex = { global: [], chains: {} };

  await Promise.all(
    ALL_REPORT_SCOPE_KEYS.map(async (key) => {
      const fields = await redis.hkeys(key);
      if (!fields || fields.length === 0) return;
      const parsedScope = parseScopeFromKey(key);
      if (parsedScope === null) return;
      const lower = fields.map((f) => f.toLowerCase());
      if (parsedScope === "global") {
        result.global = lower;
      } else {
        result.chains[String(parsedScope)] = lower;
      }
    }),
  );

  return result;
}
