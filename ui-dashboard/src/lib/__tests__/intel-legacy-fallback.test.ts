import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @/lib/redis so hgetallWithLegacy never touches a real client.
// `hgetall` is kept in the mock (and asserted un-called in the first test
// below) specifically to prove the fix never falls back to a whole-hash
// read: intel_deep already exceeds Upstash REST's 10MB single-response cap
// on a plain HGETALL, so a regression back to `redis.hgetall` must fail
// loudly here rather than only in production.
const hget = vi.fn();
const hgetall = vi.fn(() => {
  throw new Error(
    "hgetall must not be called: intel_deep exceeds the Upstash REST 10MB cap",
  );
});
const hscan = vi.fn();

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ hget, hgetall, hscan }),
}));

import {
  hgetallWithLegacy,
  HSCAN_MAX_PAGES,
  HSCAN_PAGE_COUNT,
} from "@/lib/intel-legacy-fallback";

const INTEL_KEY = "intel_deep";
const LEGACY_KEY = "arkham_deep";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hgetallWithLegacy", () => {
  it("never issues a whole-hash HGETALL — reads exclusively via paginated HSCAN", async () => {
    hscan.mockResolvedValue(["0", ["0xaaa", { address: "0xaaa" }]]);

    const result = await hgetallWithLegacy(INTEL_KEY, LEGACY_KEY);

    expect(result).toEqual({ "0xaaa": { address: "0xaaa" } });
    expect(hgetall).not.toHaveBeenCalled();
    expect(hscan).toHaveBeenCalled();
  });

  it("pages through HSCAN with the documented count and merges every page", async () => {
    hscan.mockImplementation((key: string, cursor: string | number) => {
      if (key !== INTEL_KEY) return Promise.resolve(["0", []]);
      if (cursor === 0) {
        return Promise.resolve([
          "7",
          ["0xaaa", { address: "0xaaa" }, "0xbbb", { address: "0xbbb" }],
        ]);
      }
      if (cursor === "7") {
        return Promise.resolve(["0", ["0xccc", { address: "0xccc" }]]);
      }
      throw new Error(`unexpected cursor ${String(cursor)}`);
    });

    const result = await hgetallWithLegacy(INTEL_KEY, LEGACY_KEY);

    expect(result).toEqual({
      "0xaaa": { address: "0xaaa" },
      "0xbbb": { address: "0xbbb" },
      "0xccc": { address: "0xccc" },
    });
    expect(hscan).toHaveBeenCalledWith(INTEL_KEY, 0, {
      count: HSCAN_PAGE_COUNT,
    });
    expect(hscan).toHaveBeenCalledWith(INTEL_KEY, "7", {
      count: HSCAN_PAGE_COUNT,
    });
  });

  it("keeps the later page's value when HSCAN returns the same field twice", async () => {
    hscan.mockImplementation((key: string, cursor: string | number) => {
      if (key !== INTEL_KEY) return Promise.resolve(["0", []]);
      if (cursor === 0) {
        return Promise.resolve(["3", ["0xaaa", { v: "stale" }]]);
      }
      return Promise.resolve(["0", ["0xaaa", { v: "fresh" }]]);
    });

    const result = await hgetallWithLegacy(INTEL_KEY, LEGACY_KEY);

    expect(result).toEqual({ "0xaaa": { v: "fresh" } });
  });

  it("lets intel win over legacy on key collision", async () => {
    hscan.mockImplementation((key: string) => {
      if (key === INTEL_KEY) {
        return Promise.resolve(["0", ["0xaaa", { source: "intel" }]]);
      }
      return Promise.resolve([
        "0",
        ["0xaaa", { source: "legacy" }, "0xbbb", { source: "legacy" }],
      ]);
    });

    const result = await hgetallWithLegacy(INTEL_KEY, LEGACY_KEY);

    expect(result).toEqual({
      "0xaaa": { source: "intel" },
      "0xbbb": { source: "legacy" },
    });
  });

  it("lowercases legacy keys on merge", async () => {
    hscan.mockImplementation((key: string) => {
      if (key === INTEL_KEY) return Promise.resolve(["0", []]);
      return Promise.resolve(["0", ["0xAaA", { source: "legacy" }]]);
    });

    const result = await hgetallWithLegacy(INTEL_KEY, LEGACY_KEY);

    expect(result).toEqual({ "0xaaa": { source: "legacy" } });
  });

  it("returns {} when both hashes are empty", async () => {
    hscan.mockResolvedValue(["0", []]);

    expect(await hgetallWithLegacy(INTEL_KEY, LEGACY_KEY)).toEqual({});
  });

  it("re-parses a value if it comes back as a raw JSON string instead of pre-parsed", async () => {
    hscan.mockImplementation((key: string) => {
      if (key === INTEL_KEY) {
        return Promise.resolve(["0", ["0xaaa", JSON.stringify({ v: 1 })]]);
      }
      return Promise.resolve(["0", []]);
    });

    const result = await hgetallWithLegacy(INTEL_KEY, LEGACY_KEY);

    expect(result).toEqual({ "0xaaa": { v: 1 } });
  });

  it("aborts instead of looping forever when the cursor never returns to 0", async () => {
    hscan.mockImplementation((key: string) => {
      if (key !== INTEL_KEY) return Promise.resolve(["0", []]);
      return Promise.resolve(["never-zero", ["0xaaa", { v: 1 }]]);
    });

    await expect(hgetallWithLegacy(INTEL_KEY, LEGACY_KEY)).rejects.toThrow(
      new RegExp(`${HSCAN_MAX_PAGES} pages`),
    );
  });
});
