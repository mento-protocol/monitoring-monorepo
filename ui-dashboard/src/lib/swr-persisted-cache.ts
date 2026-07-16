import { unstable_serialize, type Key, type State } from "swr";
import { clientEnv } from "@/env";
import type { TradingLimitsQuery } from "@/lib/__generated__/graphql";

/**
 * Persistent SWR is deliberately fail-closed. `TradingLimits` is the only
 * admitted operation because it is a small, current per-pool configuration
 * read (normally two token rows), has no SSR `fallbackData`, and powers the
 * client-only Limits tab. History/list queries, SSR-covered reads, and every
 * auth key remain memory-only unless this exact allowlist is reviewed again.
 */
export const PERSISTED_SWR_OPERATION_NAMES = ["TradingLimits"] as const;

export const SWR_PERSISTED_CACHE_SCHEMA_VERSION = 1;
export const SWR_PERSISTED_CACHE_STORAGE_KEY =
  "mento-monitoring:swr-persisted-cache";
export const SWR_PERSISTED_CACHE_MAX_AGE_MS = 30 * 60_000;
export const SWR_PERSISTED_CACHE_MAX_BYTES = 128 * 1024;

const MAX_ENTRY_BYTES = 24 * 1024;
const MAX_ENTRIES = 8;
const WRITE_DEBOUNCE_MS = 250;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const allowedOperations = new Set<string>(PERSISTED_SWR_OPERATION_NAMES);

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type PersistedCacheEntry = {
  data: unknown;
  key: string;
  updatedAt: number;
};

type PersistedCacheRecord = {
  buildSalt: string;
  entries: PersistedCacheEntry[];
  savedAt: number;
  schemaVersion: number;
};

export type PersistedSWRCacheController = {
  cache: Map<string, State<unknown>>;
  /** Attach best-effort page-lifecycle flushes. Returns an idempotent cleanup. */
  attachLifecycleFlushes: () => () => void;
  /**
   * Consume storage entries staged during client construction. The provider
   * activates them after React hydration so the first client render still
   * matches SSR output.
   */
  consumeHydratedEntries: () => readonly PersistedCacheEntry[];
  /** Persist immediately. Returns bytes written, 0 when cleared, or null on failure. */
  flush: () => number | null;
  /** Called only by SWR's real network-success callback. */
  recordNetworkSuccess: (key: unknown) => void;
};

type CreatePersistedSWRCacheOptions = {
  buildSalt?: string;
  now?: () => number;
  storage?: StorageLike | null;
};

function serializedCacheKey(key: unknown): string {
  if (typeof key === "string") return key;
  return unstable_serialize(key as Key);
}

function operationNameFromKey(key: unknown): string | null {
  if (Array.isArray(key)) {
    if (typeof key[0] !== "string" || typeof key[1] !== "string") return null;
    return key[1].match(/\bquery\s+([A-Za-z0-9_]+)/)?.[1] ?? null;
  }
  // SWR providers receive stable-hash strings for array keys. Requiring the
  // array marker prevents a plain/auth string containing query-like text from
  // being admitted accidentally.
  if (typeof key !== "string" || !key.startsWith("@")) return null;
  return key.match(/\bquery\s+([A-Za-z0-9_]+)/)?.[1] ?? null;
}

export function isPersistableSWRKey(key: unknown): boolean {
  const operationName = operationNameFromKey(key);
  return operationName !== null && allowedOperations.has(operationName);
}

function readBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function byteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    // TextEncoder is present in supported browsers, but this conservative
    // fallback still prevents an unexpectedly large write in restricted DOMs.
    return value.length * 2;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type TradingLimitRow = TradingLimitsQuery["TradingLimit"][number];

const TRADING_LIMIT_STRING_FIELDS = [
  "id",
  "token",
  "limit0",
  "limit1",
  "netflow0",
  "netflow1",
  "lastUpdated0",
  "lastUpdated1",
  "limitPressure0",
  "limitPressure1",
  "limitStatus",
  "updatedAtBlock",
  "updatedAtTimestamp",
] as const satisfies readonly (keyof TradingLimitRow)[];

function isTradingLimitsPayload(value: unknown): value is TradingLimitsQuery {
  if (!isObject(value) || !Array.isArray(value.TradingLimit)) return false;
  return value.TradingLimit.every(
    (row) =>
      isObject(row) &&
      typeof row.decimals === "number" &&
      Number.isInteger(row.decimals) &&
      TRADING_LIMIT_STRING_FIELDS.every(
        (field) => typeof row[field] === "string",
      ),
  );
}

function isPersistableSWRPayload(key: unknown, data: unknown): boolean {
  // Keep the validator fail-closed if the operation allowlist ever expands:
  // every newly admitted operation must add its exact response contract here.
  return (
    operationNameFromKey(key) === "TradingLimits" &&
    isTradingLimitsPayload(data)
  );
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readCacheData(value: unknown): unknown {
  return isObject(value) && "data" in value
    ? (value as State<unknown>).data
    : undefined;
}

const INVALID_ENTRY = Symbol("invalid-persisted-entry");

function hasValidRecordHeader(
  value: unknown,
  buildSalt: string,
  now: number,
): value is Record<string, unknown> & {
  entries: unknown[];
  savedAt: number;
} {
  if (!isObject(value)) return false;
  if (value.schemaVersion !== SWR_PERSISTED_CACHE_SCHEMA_VERSION) return false;
  if (value.buildSalt !== buildSalt) return false;
  if (!isFiniteTimestamp(value.savedAt)) return false;
  if (value.savedAt > now + MAX_FUTURE_SKEW_MS) return false;
  if (now - value.savedAt > SWR_PERSISTED_CACHE_MAX_AGE_MS) return false;
  return Array.isArray(value.entries) && value.entries.length <= MAX_ENTRIES;
}

function parseEntry(
  candidate: unknown,
  now: number,
): PersistedCacheEntry | null | typeof INVALID_ENTRY {
  if (!isObject(candidate)) return INVALID_ENTRY;
  if (typeof candidate.key !== "string") return INVALID_ENTRY;
  if (!isPersistableSWRKey(candidate.key)) return INVALID_ENTRY;
  if (!isFiniteTimestamp(candidate.updatedAt)) return INVALID_ENTRY;
  if (candidate.updatedAt > now + MAX_FUTURE_SKEW_MS) return INVALID_ENTRY;
  if (!("data" in candidate)) return INVALID_ENTRY;
  if (!isPersistableSWRPayload(candidate.key, candidate.data)) {
    return INVALID_ENTRY;
  }
  if (now - candidate.updatedAt > SWR_PERSISTED_CACHE_MAX_AGE_MS) return null;
  return {
    data: candidate.data,
    key: candidate.key,
    updatedAt: candidate.updatedAt,
  };
}

function parseRecord(
  raw: string,
  buildSalt: string,
  now: number,
): PersistedCacheRecord | null {
  if (byteLength(raw) > SWR_PERSISTED_CACHE_MAX_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!hasValidRecordHeader(parsed, buildSalt, now)) return null;

  const entries: PersistedCacheEntry[] = [];
  for (const candidate of parsed.entries) {
    const entry = parseEntry(candidate, now);
    if (entry === INVALID_ENTRY) return null;
    if (entry !== null) entries.push(entry);
  }

  return {
    buildSalt,
    entries,
    savedAt: parsed.savedAt,
    schemaVersion: SWR_PERSISTED_CACHE_SCHEMA_VERSION,
  };
}

function discardRecord(storage: StorageLike): void {
  try {
    storage.removeItem(SWR_PERSISTED_CACHE_STORAGE_KEY);
  } catch {
    // Storage can throw in private browsing. The record is still ignored in
    // memory, which is the fail-closed behavior that matters for this load.
  }
}

function makeRecord(
  buildSalt: string,
  entries: PersistedCacheEntry[],
): PersistedCacheRecord {
  return {
    buildSalt,
    entries,
    savedAt: entries[0]?.updatedAt ?? 0,
    schemaVersion: SWR_PERSISTED_CACHE_SCHEMA_VERSION,
  };
}

function persistenceCandidate(
  cache: Map<string, State<unknown>>,
  key: string,
  updatedAt: number,
  now: number,
): PersistedCacheEntry | null {
  if (!isPersistableSWRKey(key)) return null;
  if (updatedAt > now + MAX_FUTURE_SKEW_MS) return null;
  if (now - updatedAt > SWR_PERSISTED_CACHE_MAX_AGE_MS) return null;
  const data = readCacheData(cache.get(key));
  if (data === undefined) return null;
  if (!isPersistableSWRPayload(key, data)) return null;
  const candidate = { data, key, updatedAt };
  try {
    return byteLength(JSON.stringify(candidate)) <= MAX_ENTRY_BYTES
      ? candidate
      : null;
  } catch {
    // Cyclic/BigInt/non-JSON data stays in SWR's in-memory Map.
    return null;
  }
}

function collectPersistableEntries(
  cache: Map<string, State<unknown>>,
  updatedAtByKey: Map<string, number>,
  buildSalt: string,
  now: number,
): PersistedCacheEntry[] {
  const newestFirst = Array.from(updatedAtByKey.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  const entries: PersistedCacheEntry[] = [];
  for (const [key, updatedAt] of newestFirst) {
    if (entries.length >= MAX_ENTRIES) break;
    const candidate = persistenceCandidate(cache, key, updatedAt, now);
    if (candidate === null) continue;
    const nextEntries = [...entries, candidate];
    if (
      byteLength(JSON.stringify(makeRecord(buildSalt, nextEntries))) <=
      SWR_PERSISTED_CACHE_MAX_BYTES
    ) {
      entries.push(candidate);
    }
  }
  return entries;
}

function mergePersistableEntries(
  buildSalt: string,
  diskEntries: readonly PersistedCacheEntry[],
  localEntries: readonly PersistedCacheEntry[],
  locallyUpdatedKeys: ReadonlySet<string>,
): PersistedCacheEntry[] {
  const newestByKey = new Map<string, PersistedCacheEntry>();
  const localCandidateKeys = new Set(localEntries.map((entry) => entry.key));
  for (const entry of diskEntries) {
    // A local network success owns this key even when its new value cannot be
    // serialized. Keeping the older disk value would resurrect stale data on
    // the next load.
    if (
      !locallyUpdatedKeys.has(entry.key) ||
      localCandidateKeys.has(entry.key)
    ) {
      newestByKey.set(entry.key, entry);
    }
  }
  for (const entry of localEntries) {
    const existing = newestByKey.get(entry.key);
    if (existing === undefined || entry.updatedAt >= existing.updatedAt) {
      newestByKey.set(entry.key, entry);
    }
  }

  const newestFirst = Array.from(newestByKey.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const merged: PersistedCacheEntry[] = [];
  for (const entry of newestFirst) {
    if (merged.length >= MAX_ENTRIES) break;
    try {
      if (byteLength(JSON.stringify(entry)) > MAX_ENTRY_BYTES) continue;
      const nextEntries = [...merged, entry];
      if (
        byteLength(JSON.stringify(makeRecord(buildSalt, nextEntries))) <=
        SWR_PERSISTED_CACHE_MAX_BYTES
      ) {
        merged.push(entry);
      }
    } catch {
      // Invalid local data stays memory-only. Parsed disk entries cannot be
      // cyclic, but use one fail-closed path for both sources.
    }
  }
  return merged;
}

class PersistedSWRCache implements PersistedSWRCacheController {
  readonly cache = new Map<string, State<unknown>>();
  private readonly locallyUpdatedKeys = new Set<string>();
  private readonly updatedAtByKey = new Map<string, number>();
  private hydratedEntries: PersistedCacheEntry[] = [];
  private writeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private writesDisabled = false;

  constructor(
    private readonly storage: StorageLike | null,
    private readonly buildSalt: string,
    private readonly now: () => number,
  ) {
    this.hydrate();
  }

  private hydrate(): void {
    if (this.storage === null) return;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY);
    } catch {
      this.writesDisabled = true;
    }
    if (raw === null) return;
    const record = parseRecord(raw, this.buildSalt, this.now());
    if (record === null) {
      discardRecord(this.storage);
      return;
    }
    // Parsing is deliberately synchronous, but exposing the data through the
    // provider Map here would make the browser's hydration render differ from
    // SSR. SwrProvider consumes this staging array in its first client effect
    // and uses provider-scoped mutate so mounted hooks are notified.
    this.hydratedEntries = record.entries;
  }

  consumeHydratedEntries = (): readonly PersistedCacheEntry[] => {
    const entries = this.hydratedEntries;
    this.hydratedEntries = [];
    for (const entry of entries) {
      // A network success can win the race before the activation effect.
      // Never replace its newer timestamp with the persisted one.
      if (!this.updatedAtByKey.has(entry.key)) {
        this.updatedAtByKey.set(entry.key, entry.updatedAt);
      }
    }
    return entries;
  };

  private clearWriteTimer(): void {
    if (this.writeTimer === null) return;
    globalThis.clearTimeout(this.writeTimer);
    this.writeTimer = null;
  }

  flush = (): number | null => {
    this.clearWriteTimer();
    if (this.storage === null || this.writesDisabled) return null;
    const now = this.now();
    const localEntries = collectPersistableEntries(
      this.cache,
      this.updatedAtByKey,
      this.buildSalt,
      now,
    );
    try {
      const raw = this.storage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY);
      const diskEntries =
        raw === null
          ? []
          : (parseRecord(raw, this.buildSalt, now)?.entries ?? []);
      const entries = mergePersistableEntries(
        this.buildSalt,
        diskEntries,
        localEntries,
        this.locallyUpdatedKeys,
      );
      if (entries.length === 0) {
        this.storage.removeItem(SWR_PERSISTED_CACHE_STORAGE_KEY);
        return 0;
      }
      const serialized = JSON.stringify(makeRecord(this.buildSalt, entries));
      this.storage.setItem(SWR_PERSISTED_CACHE_STORAGE_KEY, serialized);
      return byteLength(serialized);
    } catch {
      // QuotaExceededError and private-browsing writes never escape.
      this.writesDisabled = true;
      return null;
    }
  };

  private scheduleFlush(): void {
    if (this.storage === null || this.writesDisabled) return;
    this.clearWriteTimer();
    this.writeTimer = globalThis.setTimeout(this.flush, WRITE_DEBOUNCE_MS);
  }

  recordNetworkSuccess = (key: unknown): void => {
    if (!isPersistableSWRKey(key)) return;
    const serializedKey = serializedCacheKey(key);
    if (!serializedKey) return;
    this.locallyUpdatedKeys.add(serializedKey);
    this.updatedAtByKey.set(serializedKey, this.now());
    this.scheduleFlush();
  };

  attachLifecycleFlushes = (): (() => void) => {
    if (this.storage === null || typeof window === "undefined") return () => {};
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") this.flush();
    };
    const handlePageExit = () => {
      this.flush();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handlePageExit);
    window.addEventListener("pagehide", handlePageExit);

    let cleanedUp = false;
    return () => {
      if (cleanedUp) return;
      cleanedUp = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handlePageExit);
      window.removeEventListener("pagehide", handlePageExit);
      this.flush();
    };
  };
}

export function createPersistedSWRCache(
  options: CreatePersistedSWRCacheOptions = {},
): PersistedSWRCacheController {
  const buildSalt =
    options.buildSalt ?? clientEnv.NEXT_PUBLIC_SWR_CACHE_BUILD_SALT;
  const now = options.now ?? Date.now;
  const storage =
    options.storage === undefined ? readBrowserStorage() : options.storage;
  return new PersistedSWRCache(storage, buildSalt, now);
}
