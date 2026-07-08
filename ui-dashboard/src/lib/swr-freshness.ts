import { unstable_serialize, type Key, type SWRConfiguration } from "swr";

type SwrFreshnessEntry = {
  activeCount: number;
  key: string;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  lastSuccessAt: number | null;
};

export type SwrFreshnessStatus = {
  failedCount: number;
  lastErrorMessage: string | null;
  lastUpdatedAt: number;
};

type Listener = () => void;

const entries = new Map<string, SwrFreshnessEntry>();
const listeners = new Set<Listener>();
let snapshotVersion = 0;

export function normalizeSWRFreshnessKey(key: unknown): string {
  if (typeof key === "string") return key;
  return unstable_serialize(key as Key) || String(key);
}

function readRefreshIntervalMs(config: SWRConfiguration | undefined) {
  const refreshInterval = config?.refreshInterval;
  return typeof refreshInterval === "number" && refreshInterval > 0
    ? refreshInterval
    : null;
}

function emit() {
  snapshotVersion += 1;
  for (const listener of listeners) listener();
}

function upsertEntry(normalizedKey: string): SwrFreshnessEntry {
  const existing = entries.get(normalizedKey);
  if (existing) return existing;
  const next: SwrFreshnessEntry = {
    activeCount: 0,
    key: normalizedKey,
    lastErrorAt: null,
    lastErrorMessage: null,
    lastSuccessAt: null,
  };
  entries.set(normalizedKey, next);
  return next;
}

export function registerSWRFreshnessKey(key: unknown): () => void {
  const normalizedKey = normalizeSWRFreshnessKey(key);
  const entry = upsertEntry(normalizedKey);
  entry.activeCount += 1;
  emit();
  return () => {
    const current = entries.get(normalizedKey);
    if (!current) return;
    current.activeCount -= 1;
    if (current.activeCount <= 0) {
      current.activeCount = 0;
      if (current.lastSuccessAt === null && current.lastErrorAt === null) {
        entries.delete(normalizedKey);
      }
    }
    emit();
  };
}

export function recordSWRFreshnessSuccess(
  key: unknown,
  config?: SWRConfiguration,
): void {
  const normalizedKey = normalizeSWRFreshnessKey(key);
  const refreshIntervalMs = readRefreshIntervalMs(config);
  const entry =
    entries.get(normalizedKey) ??
    (refreshIntervalMs !== null ? upsertEntry(normalizedKey) : null);
  if (!entry) return;
  entry.lastSuccessAt = Date.now();
  entry.lastErrorAt = null;
  entry.lastErrorMessage = null;
  emit();
}

export function seedSWRFreshnessData(
  key: unknown,
  config?: SWRConfiguration,
): void {
  const normalizedKey = normalizeSWRFreshnessKey(key);
  const refreshIntervalMs = readRefreshIntervalMs(config);
  const entry =
    entries.get(normalizedKey) ??
    (refreshIntervalMs !== null ? upsertEntry(normalizedKey) : null);
  if (!entry) return;
  if (entry.lastSuccessAt !== null || entry.lastErrorAt !== null) return;
  entry.lastSuccessAt = Date.now();
  emit();
}

export function recordSWRFreshnessError(
  error: unknown,
  key: unknown,
  config?: SWRConfiguration,
): void {
  const normalizedKey = normalizeSWRFreshnessKey(key);
  const refreshIntervalMs = readRefreshIntervalMs(config);
  const entry =
    entries.get(normalizedKey) ??
    (refreshIntervalMs !== null ? upsertEntry(normalizedKey) : null);
  if (!entry) return;
  entry.lastErrorAt = Date.now();
  entry.lastErrorMessage =
    error instanceof Error ? error.message : "Unknown refresh error";
  emit();
}

export function subscribeSWRFreshness(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSWRFreshnessVersion(): number {
  return snapshotVersion;
}

export function getSWRFreshnessStatus(): SwrFreshnessStatus | null {
  let failedCount = 0;
  let lastErrorMessage: string | null = null;
  let lastUpdatedAt = Number.POSITIVE_INFINITY;

  for (const entry of entries.values()) {
    if (entry.activeCount <= 0 || entry.lastSuccessAt === null) continue;
    const failedAfterSuccess =
      entry.lastErrorAt !== null && entry.lastErrorAt > entry.lastSuccessAt;
    if (!failedAfterSuccess) continue;
    failedCount += 1;
    lastErrorMessage = entry.lastErrorMessage;
    lastUpdatedAt = Math.min(lastUpdatedAt, entry.lastSuccessAt);
  }

  if (failedCount === 0 || !Number.isFinite(lastUpdatedAt)) return null;
  return { failedCount, lastErrorMessage, lastUpdatedAt };
}

export function resetSWRFreshnessForTests(): void {
  entries.clear();
  emit();
}
