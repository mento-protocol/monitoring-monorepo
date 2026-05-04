import { describe, expect, it } from "vitest";

import * as fetchAllNetworks from "@/lib/fetch-all-networks";

// Surface-contract test (TDD safety net for the network-fetcher split).
// Mirrors the `EXPECTED_EXPORT_NAMES` pattern from `queries.test.ts`. Locks
// the public API of `@/lib/fetch-all-networks` so the file's pending split
// into `network-fetcher/{types,fetch}` (re-exported via this barrel) can't
// silently drop or rename a named export — 7 importers depend on these.
const EXPECTED_EXPORT_NAMES = [
  "REQUEST_TIMEOUT_MS",
  "blankNetworkData",
  "fetchAllFeeSnapshotPages",
  "fetchAllNetworks",
  "fetchNetworkData",
  "isNetworkDataFullyHealthy",
  "partialPageLastCapturedAt",
  "warnedCapKeys",
] as const;

describe("@/lib/fetch-all-networks — surface contract", () => {
  it("exports every expected name", () => {
    const actual = Object.keys(fetchAllNetworks).sort();
    const expected = [...EXPECTED_EXPORT_NAMES].sort();
    expect(actual).toEqual(expected);
  });

  it("exports nothing extra", () => {
    const extra = Object.keys(fetchAllNetworks).filter(
      (k) =>
        !EXPECTED_EXPORT_NAMES.includes(
          k as (typeof EXPECTED_EXPORT_NAMES)[number],
        ),
    );
    expect(extra).toEqual([]);
  });

  it("REQUEST_TIMEOUT_MS is a positive number", () => {
    expect(typeof fetchAllNetworks.REQUEST_TIMEOUT_MS).toBe("number");
    expect(fetchAllNetworks.REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("fetchNetworkData and fetchAllNetworks are functions", () => {
    expect(typeof fetchAllNetworks.fetchNetworkData).toBe("function");
    expect(typeof fetchAllNetworks.fetchAllNetworks).toBe("function");
  });

  it("blankNetworkData and isNetworkDataFullyHealthy are functions", () => {
    expect(typeof fetchAllNetworks.blankNetworkData).toBe("function");
    expect(typeof fetchAllNetworks.isNetworkDataFullyHealthy).toBe("function");
  });

  it("warnedCapKeys is a Set and partialPageLastCapturedAt is a Map (mutable module state)", () => {
    expect(fetchAllNetworks.warnedCapKeys).toBeInstanceOf(Set);
    expect(fetchAllNetworks.partialPageLastCapturedAt).toBeInstanceOf(Map);
  });
});
