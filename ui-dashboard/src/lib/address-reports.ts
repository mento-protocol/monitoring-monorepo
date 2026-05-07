import { Redis } from "@upstash/redis";
import { NETWORKS } from "@/lib/networks";
import type { Scope } from "@/lib/address-labels-shared";

// Re-export isomorphic types and helpers so callers can import from a single
// path. Mirrors the address-labels split.
export {
  type AddressReport,
  type AddressReportRecord,
  type AddressReportSummary,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeReportInput,
  upgradeReport,
  upgradeReports,
  reportToSummary,
} from "./address-reports-shared";

import {
  upgradeReports,
  reportToSummary,
  type AddressReport,
  type AddressReportSummary,
} from "./address-reports-shared";

// Redis key helpers

const GLOBAL_KEY = "reports:global";

function reportsKey(scope: Scope): string {
  return scope === "global" ? GLOBAL_KEY : `reports:${scope}`;
}

// Static list of every scope key we may ever write to. Same derivation as
// `address-labels.ts` ALL_LABEL_SCOPE_KEYS — derived from NETWORKS so the
// strict-either-or Lua script can iterate a deterministic key list and stay
// race-safe under concurrent writers (every concurrent writer derives the
// same list; Redis serializes Lua executions; HDEL on the target is filtered
// inside the script).
const ALL_REPORT_SCOPE_KEYS: readonly string[] = Object.freeze([
  GLOBAL_KEY,
  ...Array.from(
    new Set(Object.values(NETWORKS).map((n) => `reports:${n.chainId}`)),
  ),
]);

function parseScopeFromKey(key: string): Scope | null {
  if (key === GLOBAL_KEY) return "global";
  const suffix = key.slice("reports:".length);
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

async function listAllScopeKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, {
      match: "reports:*",
      count: 100,
    });
    cursor = Number(nextCursor);
    keys.push(...batch);
  } while (cursor !== 0);
  return keys;
}

// Strict-either-or Lua script — same shape as address-labels' version, but
// receives the report-scope key list via KEYS[1..N].
//
// KEYS[1]    = target scope key (`reports:global` or `reports:{chainId}`)
// KEYS[2..]  = every OTHER potentially-existent scope key (script filters
//              out KEYS[1] itself so HDEL on the target is a no-op).
// ARGV[1]    = address (lowercase)
// ARGV[2]    = JSON-encoded AddressReport
const STRICT_EITHER_OR_SCRIPT = `
local targetKey = KEYS[1]
local addr = ARGV[1]
local value = ARGV[2]

redis.call('HSET', targetKey, addr, value)

for i = 2, #KEYS do
  local k = KEYS[i]
  if k ~= targetKey then
    redis.call('HDEL', k, addr)
  end
end

return 1
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
  if (!raw) return null;
  return upgradeReports({ x: raw }).x ?? null;
}

/**
 * Read the report for an address across every scope (strict either/or means
 * at most one will be present). Returns the first match or null.
 */
export async function findReport(
  address: string,
): Promise<{ scope: Scope; report: AddressReport } | null> {
  const redis = getRedis();
  const lower = address.toLowerCase();
  const allKeys = await listAllScopeKeys(redis);
  for (const key of allKeys) {
    const raw = await redis.hget<Record<string, unknown>>(key, lower);
    if (raw) {
      const parsedScope = parseScopeFromKey(key);
      if (parsedScope === null) continue;
      const report = upgradeReports({ x: raw }).x;
      if (report) return { scope: parsedScope, report };
    }
  }
  return null;
}

/**
 * Upsert a report at the target scope. Increments version monotonically and
 * preserves createdAt across edits (read-modify-write at the route level —
 * concurrent writers race benignly: last-writer wins, version still
 * advances).
 *
 * The Lua script atomically HSETs to the target scope and HDELs from every
 * other scope, preserving the strict either/or invariant under concurrent
 * scope-change writes.
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

  // Read prior across every scope so a scope move (global ↔ chain) preserves
  // createdAt and bumps version monotonically. Strict either/or guarantees at
  // most one prior row.
  const prior = await findReport(address);
  const now = new Date().toISOString();
  const next: AddressReport = {
    body: payload.body,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.authorEmail ? { authorEmail: payload.authorEmail } : {}),
    ...(payload.source ? { source: payload.source } : {}),
    createdAt: prior?.report.createdAt ?? now,
    updatedAt: now,
    version: (prior?.report.version ?? 0) + 1,
  };

  await redis.eval(
    STRICT_EITHER_OR_SCRIPT,
    [targetKey, ...ALL_REPORT_SCOPE_KEYS],
    [lower, JSON.stringify(next)],
  );

  return next;
}

export async function deleteReport(
  scope: Scope,
  address: string,
): Promise<void> {
  const redis = getRedis();
  await redis.hdel(reportsKey(scope), address.toLowerCase());
}

/**
 * Read every report metadata across every scope — body excluded. Used by the
 * index endpoint that powers the 📄 indicator in the address book.
 */
export async function getReportSummaries(): Promise<{
  global: AddressReportSummary[];
  chains: Record<string, AddressReportSummary[]>;
}> {
  const redis = getRedis();
  const allKeys = await listAllScopeKeys(redis);

  const globalSummaries: AddressReportSummary[] = [];
  const chainSummaries: Record<string, AddressReportSummary[]> = {};

  await Promise.all(
    allKeys.map(async (key) => {
      const raw =
        await redis.hgetall<Record<string, Record<string, unknown>>>(key);
      if (!raw) return;
      const reports = upgradeReports(raw as Record<string, unknown>);
      const parsedScope = parseScopeFromKey(key);
      if (parsedScope === null) return;
      const list = Object.entries(reports).map(([addr, r]) =>
        reportToSummary(r, addr, parsedScope),
      );
      if (parsedScope === "global") {
        globalSummaries.push(...list);
      } else {
        chainSummaries[String(parsedScope)] = list;
      }
    }),
  );

  return { global: globalSummaries, chains: chainSummaries };
}
