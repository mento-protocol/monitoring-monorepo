import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_serialize } from "swr";
import {
  getSWRFreshnessStatus,
  normalizeSWRFreshnessKey,
  recordSWRFreshnessError,
  recordSWRFreshnessSuccess,
  registerSWRFreshnessKey,
  resetSWRFreshnessForTests,
  seedSWRFreshnessData,
} from "@/lib/swr-freshness";

const NOW = 1_767_225_600_000;
const REFRESH_MS = 30_000;

describe("SWR freshness status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetSWRFreshnessForTests();
  });

  afterEach(() => {
    resetSWRFreshnessForTests();
    vi.useRealTimers();
  });

  it("marks active polling data stale once it is older than its refresh interval", () => {
    const unregister = registerSWRFreshnessKey(["celo", "query"], REFRESH_MS);
    recordSWRFreshnessSuccess(["celo", "query"], {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS)).toBeNull();

    const status = getSWRFreshnessStatus(NOW + REFRESH_MS + 1);
    expect(status).toMatchObject({
      failedCount: 0,
      lastUpdatedAt: NOW,
      staleCount: 1,
    });

    unregister();
    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toBeNull();
  });

  it("marks last-good data stale when a later refresh fails", () => {
    registerSWRFreshnessKey(["bridge", "query"], REFRESH_MS);
    recordSWRFreshnessSuccess(["bridge", "query"], {
      refreshInterval: REFRESH_MS,
    });

    vi.setSystemTime(NOW + 5_000);
    recordSWRFreshnessError(new Error("Tier quota"), ["bridge", "query"], {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus(NOW + 5_000)).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "Tier quota",
      lastUpdatedAt: NOW,
      staleCount: 1,
    });
  });

  it("preserves success metadata across inactive periods for the same key", () => {
    const unregister = registerSWRFreshnessKey("remount-key", REFRESH_MS);
    recordSWRFreshnessSuccess("remount-key", {
      refreshInterval: REFRESH_MS,
    });
    unregister();

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toBeNull();

    registerSWRFreshnessKey("remount-key", REFRESH_MS);

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toMatchObject({
      failedCount: 0,
      lastUpdatedAt: NOW,
      staleCount: 1,
    });
  });

  it("keeps a success recorded before registration and activates it on subscribe", () => {
    recordSWRFreshnessSuccess("fast-key", { refreshInterval: REFRESH_MS });

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toBeNull();

    registerSWRFreshnessKey("fast-key", REFRESH_MS);

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toMatchObject({
      failedCount: 0,
      lastUpdatedAt: NOW,
      staleCount: 1,
    });
  });

  it("matches registered array keys with SWR serialized callback keys", () => {
    const swrKey = ["celo", "query", { chainId: 42220 }];
    const serializedKey = unstable_serialize(swrKey);

    registerSWRFreshnessKey(swrKey, REFRESH_MS);
    recordSWRFreshnessSuccess(serializedKey, {
      refreshInterval: REFRESH_MS,
    });

    vi.setSystemTime(NOW + 5_000);
    recordSWRFreshnessError(new Error("poll failed"), serializedKey, {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus(NOW + 5_000)).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "poll failed",
      lastUpdatedAt: NOW,
      staleCount: 1,
    });
  });

  it("falls back to a string for SWR keys without a serialized value", () => {
    expect(normalizeSWRFreshnessKey(null)).toBe("null");
  });

  it("ignores one-shot SWR events without active polling metadata", () => {
    recordSWRFreshnessSuccess("one-shot");
    recordSWRFreshnessError("not active", "one-shot-error");

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toBeNull();
  });

  it("records refresh failures for active keys without a refresh interval", () => {
    registerSWRFreshnessKey("manual-key", null);
    recordSWRFreshnessSuccess("manual-key");

    vi.setSystemTime(NOW + 1_000);
    recordSWRFreshnessError("not an Error instance", "manual-key");

    expect(getSWRFreshnessStatus(NOW + 1_000)).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "Unknown refresh error",
      lastUpdatedAt: NOW,
      staleCount: 1,
    });
  });

  it("seeds fallback data without clearing later refresh failures", () => {
    registerSWRFreshnessKey("seeded-key", REFRESH_MS);
    seedSWRFreshnessData("seeded-key", { refreshInterval: REFRESH_MS });

    vi.setSystemTime(NOW + 1_000);
    recordSWRFreshnessError(new Error("refresh failed"), "seeded-key", {
      refreshInterval: REFRESH_MS,
    });
    seedSWRFreshnessData("seeded-key", { refreshInterval: REFRESH_MS });

    expect(getSWRFreshnessStatus(NOW + 1_000)).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "refresh failed",
      lastUpdatedAt: NOW,
      staleCount: 1,
    });
  });

  it("keeps duplicate registrations active until the final unregister", () => {
    const unregisterFirst = registerSWRFreshnessKey("shared-key", REFRESH_MS);
    const unregisterSecond = registerSWRFreshnessKey("shared-key", null);
    recordSWRFreshnessSuccess("shared-key", { refreshInterval: REFRESH_MS });

    unregisterFirst();

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toMatchObject({
      failedCount: 0,
      lastUpdatedAt: NOW,
      staleCount: 1,
    });

    unregisterSecond();
    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toBeNull();
  });

  it("cleans empty registrations and tolerates repeated unregister calls", () => {
    const unregister = registerSWRFreshnessKey("empty-key", REFRESH_MS);

    unregister();
    unregister();

    expect(getSWRFreshnessStatus(NOW + REFRESH_MS + 1)).toBeNull();
  });
});
