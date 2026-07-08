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

  it("does not mark active polling data stale only because it is older than its refresh interval", () => {
    const unregister = registerSWRFreshnessKey(["celo", "query"]);
    recordSWRFreshnessSuccess(["celo", "query"], {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus()).toBeNull();
    expect(getSWRFreshnessStatus()).toBeNull();

    unregister();
    expect(getSWRFreshnessStatus()).toBeNull();
  });

  it("marks last-good data stale when a later refresh fails", () => {
    registerSWRFreshnessKey(["bridge", "query"]);
    recordSWRFreshnessSuccess(["bridge", "query"], {
      refreshInterval: REFRESH_MS,
    });

    vi.setSystemTime(NOW + 5_000);
    recordSWRFreshnessError(new Error("Tier quota"), ["bridge", "query"], {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus()).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "Tier quota",
      lastUpdatedAt: NOW,
    });
  });

  it("preserves success metadata across inactive periods for the same key", () => {
    const unregister = registerSWRFreshnessKey("remount-key");
    recordSWRFreshnessSuccess("remount-key", {
      refreshInterval: REFRESH_MS,
    });
    unregister();

    expect(getSWRFreshnessStatus()).toBeNull();

    registerSWRFreshnessKey("remount-key");

    expect(getSWRFreshnessStatus()).toBeNull();

    vi.setSystemTime(NOW + REFRESH_MS + 2);
    recordSWRFreshnessError(new Error("remount failed"), "remount-key", {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus()).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "remount failed",
      lastUpdatedAt: NOW,
    });
  });

  it("keeps a success recorded before registration and uses it for later failures", () => {
    recordSWRFreshnessSuccess("fast-key", { refreshInterval: REFRESH_MS });

    expect(getSWRFreshnessStatus()).toBeNull();

    registerSWRFreshnessKey("fast-key");

    expect(getSWRFreshnessStatus()).toBeNull();

    vi.setSystemTime(NOW + REFRESH_MS + 2);
    recordSWRFreshnessError(new Error("fast key failed"), "fast-key", {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus()).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "fast key failed",
      lastUpdatedAt: NOW,
    });
  });

  it("matches registered array keys with SWR serialized callback keys", () => {
    const swrKey = ["celo", "query", { chainId: 42220 }];
    const serializedKey = unstable_serialize(swrKey);

    registerSWRFreshnessKey(swrKey);
    recordSWRFreshnessSuccess(serializedKey, {
      refreshInterval: REFRESH_MS,
    });

    vi.setSystemTime(NOW + 5_000);
    recordSWRFreshnessError(new Error("poll failed"), serializedKey, {
      refreshInterval: REFRESH_MS,
    });

    expect(getSWRFreshnessStatus()).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "poll failed",
      lastUpdatedAt: NOW,
    });
  });

  it("falls back to a string for SWR keys without a serialized value", () => {
    expect(normalizeSWRFreshnessKey(null)).toBe("null");
  });

  it("ignores one-shot SWR events without active polling metadata", () => {
    recordSWRFreshnessSuccess("one-shot");
    recordSWRFreshnessError("not active", "one-shot-error");

    expect(getSWRFreshnessStatus()).toBeNull();
  });

  it("records refresh failures for active keys without a refresh interval", () => {
    registerSWRFreshnessKey("manual-key");
    recordSWRFreshnessSuccess("manual-key");

    vi.setSystemTime(NOW + 1_000);
    recordSWRFreshnessError("not an Error instance", "manual-key");

    expect(getSWRFreshnessStatus()).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "Unknown refresh error",
      lastUpdatedAt: NOW,
    });
  });

  it("seeds fallback data without clearing later refresh failures", () => {
    registerSWRFreshnessKey("seeded-key");
    seedSWRFreshnessData("seeded-key", { refreshInterval: REFRESH_MS });

    vi.setSystemTime(NOW + 1_000);
    recordSWRFreshnessError(new Error("refresh failed"), "seeded-key", {
      refreshInterval: REFRESH_MS,
    });
    seedSWRFreshnessData("seeded-key", { refreshInterval: REFRESH_MS });

    expect(getSWRFreshnessStatus()).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "refresh failed",
      lastUpdatedAt: NOW,
    });
  });

  it("keeps duplicate registrations active until the final unregister", () => {
    const unregisterFirst = registerSWRFreshnessKey("shared-key");
    const unregisterSecond = registerSWRFreshnessKey("shared-key");
    recordSWRFreshnessSuccess("shared-key", { refreshInterval: REFRESH_MS });

    vi.setSystemTime(NOW + 1_000);
    recordSWRFreshnessError(new Error("shared failed"), "shared-key", {
      refreshInterval: REFRESH_MS,
    });

    unregisterFirst();

    expect(getSWRFreshnessStatus()).toMatchObject({
      failedCount: 1,
      lastErrorMessage: "shared failed",
      lastUpdatedAt: NOW,
    });

    unregisterSecond();
    expect(getSWRFreshnessStatus()).toBeNull();
  });

  it("cleans empty registrations and tolerates repeated unregister calls", () => {
    const unregister = registerSWRFreshnessKey("empty-key");

    unregister();
    unregister();

    expect(getSWRFreshnessStatus()).toBeNull();
  });
});
