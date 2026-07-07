import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSWRFreshnessStatus,
  recordSWRFreshnessError,
  recordSWRFreshnessSuccess,
  registerSWRFreshnessKey,
  resetSWRFreshnessForTests,
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
});
