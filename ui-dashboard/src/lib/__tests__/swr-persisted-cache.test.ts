import { unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OLS_POOL,
  POOL_DEPLOYMENT,
  POOL_DETAIL_WITH_HEALTH,
  POOL_RESERVES,
  POOL_SWAPS_PAGE,
  TRADING_LIMITS,
} from "@/lib/queries";
import {
  SWR_KEY_ALL_NETWORKS_DATA,
  SWR_KEY_LIVE_POOL_HEALTH,
  SWR_KEY_ORACLE_RATES,
} from "@/lib/swr-keys";
import {
  createPersistedSWRCache,
  isPersistableSWRKey,
  PERSISTED_SWR_OPERATION_NAMES,
  SWR_PERSISTED_CACHE_MAX_AGE_MS,
  SWR_PERSISTED_CACHE_MAX_BYTES,
  SWR_PERSISTED_CACHE_SCHEMA_VERSION,
  SWR_PERSISTED_CACHE_STORAGE_KEY,
} from "@/lib/swr-persisted-cache";
import { resetSWRFreshnessForTests } from "@/lib/swr-freshness";

const NOW = 1_767_225_600_000;
const POOL_ID = "42220-0xpool";
const BUILD_SALT = "deploy-a";
const tradingLimitsKey = [
  "celo-mainnet",
  TRADING_LIMITS,
  { poolId: POOL_ID },
] as const;
const otherTradingLimitsKey = [
  "celo-mainnet",
  TRADING_LIMITS,
  { poolId: "42220-0xother" },
] as const;

class MemoryStorage {
  readonly values = new Map<string, string>();
  throwOnGet = false;
  throwOnRemove = false;
  throwOnSet = false;

  getItem(key: string): string | null {
    if (this.throwOnGet) throw new DOMException("denied", "SecurityError");
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    if (this.throwOnRemove) throw new DOMException("denied", "SecurityError");
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new DOMException("quota", "QuotaExceededError");
    this.values.set(key, value);
  }
}

function seedTradingLimits(storage: MemoryStorage, now = NOW): number {
  const controller = createPersistedSWRCache({
    buildSalt: BUILD_SALT,
    now: () => now,
    storage,
  });
  controller.cache.set(unstable_serialize(tradingLimitsKey), {
    data: {
      TradingLimit: [
        {
          id: "limit-1",
          limit0: "100",
          limit1: "200",
          token: "0xtoken",
        },
      ],
    },
  });
  controller.recordNetworkSuccess(tradingLimitsKey);
  return controller.flush() ?? 0;
}

describe("persisted SWR cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetSWRFreshnessForTests();
  });

  afterEach(() => {
    resetSWRFreshnessForTests();
    vi.useRealTimers();
  });

  it("uses a one-operation allowlist and denies SSR, auth, and history keys", () => {
    expect(PERSISTED_SWR_OPERATION_NAMES).toEqual(["TradingLimits"]);
    expect(isPersistableSWRKey(tradingLimitsKey)).toBe(true);
    expect(isPersistableSWRKey(unstable_serialize(tradingLimitsKey))).toBe(
      true,
    );

    for (const query of [
      POOL_DETAIL_WITH_HEALTH,
      POOL_RESERVES,
      POOL_SWAPS_PAGE,
      OLS_POOL,
      POOL_DEPLOYMENT,
    ]) {
      expect(
        isPersistableSWRKey(["celo-mainnet", query, { poolId: POOL_ID }]),
      ).toBe(false);
    }
    for (const key of [
      SWR_KEY_ALL_NETWORKS_DATA,
      SWR_KEY_LIVE_POOL_HEALTH,
      SWR_KEY_ORACLE_RATES,
      "address-labels:all",
      "address-reports:index",
      "address-reports:single:0x1234",
    ]) {
      expect(isPersistableSWRKey(key)).toBe(false);
    }
  });

  it("stages valid data synchronously without changing the hydration Map", () => {
    const storage = new MemoryStorage();
    const bytes = seedTradingLimits(storage);

    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(SWR_PERSISTED_CACHE_MAX_BYTES);

    const controller = createPersistedSWRCache({
      buildSalt: BUILD_SALT,
      now: () => NOW + 1_000,
      storage,
    });
    const serializedKey = unstable_serialize(tradingLimitsKey);
    expect(controller.cache.size).toBe(0);
    expect(controller.consumeHydratedEntries()).toEqual([
      {
        data: {
          TradingLimit: [
            {
              id: "limit-1",
              limit0: "100",
              limit1: "200",
              token: "0xtoken",
            },
          ],
        },
        key: serializedKey,
        updatedAt: NOW,
      },
    ]);
    expect(controller.consumeHydratedEntries()).toEqual([]);
    expect(controller.cache.size).toBe(0);
  });

  it("merges valid untouched entries written by another controller", () => {
    const storage = new MemoryStorage();
    let now = NOW;
    // Both tabs start before either has written, so the second controller has
    // no in-memory knowledge of the first tab's later entry.
    const first = createPersistedSWRCache({
      buildSalt: BUILD_SALT,
      now: () => now,
      storage,
    });
    const second = createPersistedSWRCache({
      buildSalt: BUILD_SALT,
      now: () => now,
      storage,
    });
    const firstKey = unstable_serialize(tradingLimitsKey);
    const secondKey = unstable_serialize(otherTradingLimitsKey);

    first.cache.set(firstKey, {
      data: { TradingLimit: [{ id: "first-tab" }] },
    });
    first.recordNetworkSuccess(tradingLimitsKey);
    expect(first.flush()).toBeGreaterThan(0);

    now += 1_000;
    second.cache.set(secondKey, {
      data: { TradingLimit: [{ id: "second-tab" }] },
    });
    second.recordNetworkSuccess(otherTradingLimitsKey);
    expect(second.flush()).toBeGreaterThan(0);

    const raw = storage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw!) as {
      entries: Array<{ data: unknown; key: string; updatedAt: number }>;
    };
    expect(record.entries).toEqual([
      {
        data: { TradingLimit: [{ id: "second-tab" }] },
        key: secondKey,
        updatedAt: NOW + 1_000,
      },
      {
        data: { TradingLimit: [{ id: "first-tab" }] },
        key: firstKey,
        updatedAt: NOW,
      },
    ]);
  });

  it("discards the whole record on build-salt or schema mismatch", () => {
    const storage = new MemoryStorage();
    seedTradingLimits(storage);

    const buildMismatch = createPersistedSWRCache({
      buildSalt: "deploy-b",
      now: () => NOW,
      storage,
    });
    expect(buildMismatch.cache.size).toBe(0);
    expect(storage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY)).toBeNull();

    storage.setItem(
      SWR_PERSISTED_CACHE_STORAGE_KEY,
      JSON.stringify({
        buildSalt: BUILD_SALT,
        entries: [],
        savedAt: NOW,
        schemaVersion: SWR_PERSISTED_CACHE_SCHEMA_VERSION + 1,
      }),
    );
    const schemaMismatch = createPersistedSWRCache({
      buildSalt: BUILD_SALT,
      now: () => NOW,
      storage,
    });
    expect(schemaMismatch.cache.size).toBe(0);
    expect(storage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY)).toBeNull();
  });

  it("discards corrupt and expired records without throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(SWR_PERSISTED_CACHE_STORAGE_KEY, "{broken");
    expect(() =>
      createPersistedSWRCache({
        buildSalt: BUILD_SALT,
        now: () => NOW,
        storage,
      }),
    ).not.toThrow();
    expect(storage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY)).toBeNull();

    seedTradingLimits(storage, NOW - SWR_PERSISTED_CACHE_MAX_AGE_MS - 1);
    const expired = createPersistedSWRCache({
      buildSalt: BUILD_SALT,
      now: () => NOW,
      storage,
    });
    expect(expired.cache.size).toBe(0);
    expect(storage.getItem(SWR_PERSISTED_CACHE_STORAGE_KEY)).toBeNull();
  });

  it("degrades quota and unavailable-storage failures to memory-only", () => {
    const quotaStorage = new MemoryStorage();
    quotaStorage.throwOnSet = true;
    const controller = createPersistedSWRCache({
      buildSalt: BUILD_SALT,
      now: () => NOW,
      storage: quotaStorage,
    });
    const serializedKey = unstable_serialize(tradingLimitsKey);
    controller.cache.set(serializedKey, {
      data: { TradingLimit: [{ id: "still-in-memory" }] },
    });
    controller.recordNetworkSuccess(tradingLimitsKey);

    expect(controller.flush()).toBeNull();
    expect(controller.cache.get(serializedKey)).toEqual({
      data: { TradingLimit: [{ id: "still-in-memory" }] },
    });

    const deniedStorage = new MemoryStorage();
    deniedStorage.throwOnGet = true;
    expect(() =>
      createPersistedSWRCache({
        buildSalt: BUILD_SALT,
        now: () => NOW,
        storage: deniedStorage,
      }),
    ).not.toThrow();
  });
});
