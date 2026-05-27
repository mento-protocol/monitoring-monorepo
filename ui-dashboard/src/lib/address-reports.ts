import { getRedis } from "./redis";
import { encodeReportFields, REPORTS_KEY } from "./address-report-fields";

// Re-export isomorphic types and helpers so callers can import from a single
// path. Mirrors the address-labels split.
export {
  type AddressReport,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeReportInput,
} from "./address-reports-shared";

import {
  upgradeReport,
  upgradeReports,
  type AddressReport,
} from "./address-reports-shared";

// Redis layout: a single `reports` hash keyed by lowercase address. Reports
// are not chain-scoped — same EVM address means same entity (same private
// key derives the same address across every chain), so a single global
// report applies wherever the address appears. Earlier per-scope storage
// caused recurring scope-mismatch bugs that the model itself doesn't
// justify (PR #330).
// Atomic conditional upsert script. Reads prior, verifies the caller's
// base-version precondition, increments version, preserves createdAt, writes.
// Atomicity guards both the no-lost-update invariant and version monotonicity
// against concurrent writers — without the script, two simultaneous saves
// could both observe v=N and both write v=N+1.
//
// KEYS[1]  = "reports"
// ARGV[1]  = address (lowercase)
// ARGV[2]  = JSON-encoded payload (body + optional title/authorEmail/source)
// ARGV[3]  = ISO timestamp for `now`
// ARGV[4]  = expected base version, or "" for create-only
//
// Returns a JSON-encoded envelope. On success, `report` is the persisted
// record. On conflict, `existingVersion` is the current stored version when
// one exists.
const UPSERT_SCRIPT = `
local key = KEYS[1]
local addr = ARGV[1]
local payload = cjson.decode(ARGV[2])
local now = ARGV[3]
local expectedVersionArg = ARGV[4]

local existing = redis.call('HGET', key, addr)
local prior = nil
if existing then
  prior = cjson.decode(existing)
end

payload.createdAt = (prior and prior.createdAt) or now
payload.updatedAt = now

-- Match upgradeReport()'s read-side version normalization before comparing
-- or incrementing. Lua's
-- 'or' short-circuits on falsy, but cjson.decode maps JSON null to
-- cjson.null (truthy in Lua) — without the type check, a stored
-- {"version": null} (which an earlier split-write path could have
-- produced for legacy/partial records) would propagate cjson.null
-- into the arithmetic and crash the EVAL. Existing partial records read as
-- version 1 in JS, so they must compare as version 1 here too.
local priorVersion = 0
if prior then
  priorVersion = prior.version
  if type(priorVersion) ~= 'number' or priorVersion <= 0 then
    priorVersion = 1
  else
    priorVersion = math.floor(priorVersion)
  end
end

if expectedVersionArg == '' then
  if prior then
    return cjson.encode({
      ok = false,
      error = 'version_conflict',
      existingVersion = priorVersion
    })
  end
else
  local expectedVersion = tonumber(expectedVersionArg)
  if (not prior) or priorVersion ~= expectedVersion then
    return cjson.encode({
      ok = false,
      error = 'version_conflict',
      existingVersion = prior and priorVersion or cjson.null
    })
  end
end

payload.version = priorVersion + 1

local encoded = cjson.encode(payload)
redis.call('HSET', key, addr, encoded)
return cjson.encode({ ok = true, report = payload })
`;

const DELETE_SCRIPT = `
local key = KEYS[1]
local addr = ARGV[1]
local expectedVersion = tonumber(ARGV[2])

local existing = redis.call('HGET', key, addr)
if not existing then
  return cjson.encode({
    ok = false,
    error = 'not_found'
  })
end

local prior = cjson.decode(existing)
-- Mirrors the priorVersion normalization in UPSERT_SCRIPT. Keep in sync.
local priorVersion = prior.version
if type(priorVersion) ~= 'number' or priorVersion <= 0 then
  priorVersion = 1
else
  priorVersion = math.floor(priorVersion)
end

if priorVersion ~= expectedVersion then
  return cjson.encode({
    ok = false,
    error = 'version_conflict',
    existingVersion = priorVersion
  })
end

redis.call('HDEL', key, addr)
return cjson.encode({ ok = true })
`;

// Data access helpers (all server-side)

export class AddressReportVersionConflictError extends Error {
  readonly existingVersion: number | null;

  constructor(existingVersion: number | null) {
    super("Address report version conflict");
    this.name = "AddressReportVersionConflictError";
    this.existingVersion = existingVersion;
  }
}

export class AddressReportNotFoundError extends Error {
  constructor() {
    super("Address report not found");
    this.name = "AddressReportNotFoundError";
  }
}

/**
 * Read the report for an address. Returns null if no report exists.
 */
export async function findReport(
  address: string,
): Promise<AddressReport | null> {
  const redis = getRedis();
  const raw = await redis.hget<Record<string, unknown>>(
    REPORTS_KEY,
    address.toLowerCase(),
  );
  return raw ? upgradeReport(raw) : null;
}

/**
 * Upsert a report for an address. Atomically increments `version` and
 * preserves `createdAt` from any prior record inside a single Lua execution
 * — concurrent writers can no longer both observe the same prior version
 * and both write `version + 1`.
 */
export async function upsertReport(
  address: string,
  payload: {
    body: string;
    title?: string | undefined;
    authorEmail?: string | undefined;
    source?: AddressReport["source"] | undefined;
    baseVersion?: number | undefined;
  },
): Promise<AddressReport> {
  const redis = getRedis();
  const lower = address.toLowerCase();
  const now = new Date().toISOString();

  // Send only user-controlled fields; the Lua script stamps createdAt /
  // updatedAt / version atomically based on the prior record.
  const partial = {
    body: payload.body,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.authorEmail ? { authorEmail: payload.authorEmail } : {}),
    ...(payload.source ? { source: payload.source } : {}),
  };

  // The Upstash SDK auto-parses JSON-shaped responses (`parseResponse` →
  // `parseRecursive`), so the script's `cjson.encode(envelope)` return value
  // arrives here as an already-deserialized object — calling JSON.parse on
  // it would coerce to "[object Object]" and throw at runtime.
  const result = (await redis.eval(
    UPSERT_SCRIPT,
    [REPORTS_KEY],
    [
      lower,
      JSON.stringify(partial),
      now,
      payload.baseVersion === undefined ? "" : String(payload.baseVersion),
    ],
  )) as Record<string, unknown>;

  if (result.ok !== true) {
    throw new AddressReportVersionConflictError(
      typeof result.existingVersion === "number"
        ? result.existingVersion
        : null,
    );
  }

  if (typeof result.report !== "object" || result.report === null) {
    throw new Error("Invalid address report upsert response");
  }

  return upgradeReport(result.report as Record<string, unknown>);
}

export async function deleteReport(
  address: string,
  baseVersion: number,
): Promise<void> {
  const redis = getRedis();
  const result = (await redis.eval(
    DELETE_SCRIPT,
    [REPORTS_KEY],
    [address.toLowerCase(), String(baseVersion)],
  )) as Record<string, unknown>;

  if (result.ok !== true) {
    if (result.error === "not_found") {
      throw new AddressReportNotFoundError();
    }
    throw new AddressReportVersionConflictError(
      typeof result.existingVersion === "number"
        ? result.existingVersion
        : null,
    );
  }
}

/**
 * Read just the addresses that have a report. Reads field names only
 * (HKEYS) — does NOT pull the 50KB report bodies the way an HGETALL would,
 * so the index endpoint stays cheap to poll on a 60s loop.
 */
export async function getReportsIndex(): Promise<{ addresses: string[] }> {
  const redis = getRedis();
  const fields = await redis.hkeys(REPORTS_KEY);
  return { addresses: (fields ?? []).map((f) => f.toLowerCase()) };
}

/**
 * Read every report as an address → report record map. HGETALL pulls the
 * full bodies, so unlike `getReportsIndex` this is bandwidth-heavy — only
 * call it from cron contexts (e.g. the daily backup) where you actually
 * need the full payloads.
 *
 * Returns an empty record (not throws) when the hash is missing or empty,
 * so a fresh Upstash with zero reports still yields a clean snapshot.
 */
export async function getAllReports(): Promise<Record<string, AddressReport>> {
  const redis = getRedis();
  const raw =
    await redis.hgetall<Record<string, Record<string, unknown>>>(REPORTS_KEY);
  if (!raw) return {};
  return upgradeReports(raw as Record<string, unknown>);
}

/**
 * Bulk-write a batch of reports as a single HSET. Preserves the snapshot's
 * stored `version` / `createdAt` / `updatedAt` verbatim so a backup
 * restore reproduces the prior state exactly — the atomic Lua upsert
 * deliberately bumps the version on every call, which is the wrong shape
 * for a restore.
 *
 * Caller is responsible for upgrading raw records via `upgradeReports`
 * before calling. No-op on an empty record.
 */
export async function importReports(
  reports: Record<string, AddressReport>,
): Promise<void> {
  const entries = Object.entries(reports);
  if (entries.length === 0) return;
  const redis = getRedis();
  await redis.hset(REPORTS_KEY, encodeReportFields(entries));
}
