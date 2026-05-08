import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @upstash/redis before importing the module under test.
// `Redis` must be a constructor (use `function`, not arrow — vi.fn().mockImplementation()
// produces a callable but not a constructor).
vi.mock("@upstash/redis", () => {
  const hgetall = vi.fn();
  const hget = vi.fn();
  const hmget = vi.fn();
  const hset = vi.fn();
  const hdel = vi.fn();
  const scan = vi.fn();
  const del = vi.fn();
  return {
    Redis: function MockRedis() {
      return { hgetall, hget, hmget, hset, hdel, scan, del };
    },
    __mocks: { hgetall, hget, hmget, hset, hdel, scan, del },
  };
});

vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");

import {
  getLabels,
  getLabel,
  getLabelsByAddress,
  upsertEntry,
  deleteLabel,
  importLabels,
  readLegacyScopes,
  dropLegacyScopes,
  upgradeEntry,
} from "@/lib/address-labels";
import * as upstash from "@upstash/redis";

const mocks = (
  upstash as unknown as {
    __mocks: {
      hgetall: ReturnType<typeof vi.fn>;
      hget: ReturnType<typeof vi.fn>;
      hmget: ReturnType<typeof vi.fn>;
      hset: ReturnType<typeof vi.fn>;
      hdel: ReturnType<typeof vi.fn>;
      scan: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };
  }
).__mocks;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getLabels", () => {
  it("returns all entries from the flat labels hash (legacy hashes empty)", async () => {
    mocks.hgetall.mockImplementation(async (key: string) => {
      if (key === "labels")
        return {
          "0xaaa": {
            name: "One",
            tags: [],
            isPublic: true,
            updatedAt: "2026-01-01T00:00:00Z",
          },
          "0xbbb": {
            name: "Two",
            tags: [],
            isPublic: false,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        };
      return null;
    });
    const result = await getLabels();
    expect(mocks.hgetall).toHaveBeenCalledWith("labels");
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["0xaaa"].name).toBe("One");
  });

  it("returns empty object when every hash returns null", async () => {
    mocks.hgetall.mockResolvedValue(null);
    expect(await getLabels()).toEqual({});
  });

  it("auto-upgrades legacy v1 entries on read (label → name)", async () => {
    mocks.hgetall.mockImplementation(async (key: string) =>
      key === "labels"
        ? {
            "0xaaa": {
              label: "Legacy",
              category: "DeFi",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          }
        : null,
    );
    const result = await getLabels();
    expect(result["0xaaa"].name).toBe("Legacy");
    expect(result["0xaaa"].tags).toEqual(["DeFi"]);
    expect((result["0xaaa"] as Record<string, unknown>).label).toBeUndefined();
  });

  it("dual-reads legacy scopes during the migration window — flat wins on conflict", async () => {
    mocks.hgetall.mockImplementation(async (key: string) => {
      if (key === "labels")
        return {
          "0xaaa": {
            name: "Flat-Alice",
            tags: [],
            updatedAt: "2026-04-01T00:00:00Z",
          },
        };
      if (key === "labels:global")
        return {
          "0xaaa": {
            name: "Legacy-Alice",
            tags: [],
            updatedAt: "2026-03-01T00:00:00Z",
          },
          "0xbbb": {
            name: "Legacy-Bob",
            tags: [],
            updatedAt: "2026-03-01T00:00:00Z",
          },
        };
      return null;
    });
    const result = await getLabels();
    expect(result["0xaaa"].name).toBe("Flat-Alice");
    expect(result["0xbbb"].name).toBe("Legacy-Bob");
  });
});

describe("upsertEntry", () => {
  it("writes a single HSET to the flat labels hash, lowercasing the address", async () => {
    await upsertEntry("0xABC", { name: "Test", tags: [], isPublic: true });
    expect(mocks.hset).toHaveBeenCalledTimes(1);
    const [key, fields] = mocks.hset.mock.calls[0];
    expect(key).toBe("labels");
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]);
    expect(value.name).toBe("Test");
    expect(value.isPublic).toBe(true);
    expect(value.updatedAt).toBeTruthy();
    expect(value.createdAt).toBeTruthy();
  });

  it("preserves caller-supplied createdAt (e.g. from a prior entry)", async () => {
    await upsertEntry("0xABC", {
      name: "Test",
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const [, fields] = mocks.hset.mock.calls[0];
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]);
    expect(value.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("deleteLabel", () => {
  it("HDELs the flat hash AND every legacy scope (transition window safety)", async () => {
    // During the dual-read window, deleting only the flat copy would let
    // the legacy entry resurrect on the next refetch and get migrated back
    // into the flat hash. After migration the legacy HDELs are no-ops.
    await deleteLabel("0xABC");
    expect(mocks.hdel).toHaveBeenCalledWith("labels", "0xabc");
    expect(mocks.hdel).toHaveBeenCalledWith("labels:global", "0xabc");
    expect(mocks.hdel).toHaveBeenCalledWith("labels:42220", "0xabc");
    // Each legacy scope key from KNOWN_LEGACY_KEYS should get its own HDEL.
    // 6 known keys (global + 2 retired + 3 NETWORKS) + 1 flat = 7 total.
    expect(mocks.hdel).toHaveBeenCalledTimes(7);
  });
});

describe("importLabels", () => {
  it("batches all imports into a single HSET", async () => {
    await importLabels({
      "0xaaa": {
        name: "A",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      "0xBBB": {
        name: "B",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(mocks.hset).toHaveBeenCalledTimes(1);
    const [key, fields] = mocks.hset.mock.calls[0];
    expect(key).toBe("labels");
    expect(Object.keys(fields as Record<string, string>).sort()).toEqual([
      "0xaaa",
      "0xbbb",
    ]);
  });

  it("coerces non-true isPublic to false", async () => {
    await importLabels({
      "0xabc": {
        name: "Test",
        tags: [],
        // @ts-expect-error intentionally passing wrong type to test coercion
        isPublic: "yes",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const [, fields] = mocks.hset.mock.calls[0];
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]);
    expect(value.isPublic).toBe(false);
  });

  it("keeps isPublic: true when strictly true", async () => {
    await importLabels({
      "0xabc": {
        name: "Test",
        tags: [],
        isPublic: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const [, fields] = mocks.hset.mock.calls[0];
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]);
    expect(value.isPublic).toBe(true);
  });

  it("is a no-op when the batch is empty", async () => {
    await importLabels({});
    expect(mocks.hset).not.toHaveBeenCalled();
  });
});

describe("readLegacyScopes — migration helper", () => {
  it("returns only the legacy keys with non-empty entries", async () => {
    // KNOWN_LEGACY_KEYS = labels:global + 2 retired (44787, 62320) + 3
    // NETWORKS chains (42220, 11142220, 143) = 6 hgetall calls in parallel.
    // Seed labels:global + labels:42220 with entries; rest empty.
    mocks.hgetall.mockImplementation(async (key: string) => {
      if (key === "labels:global")
        return {
          "0xggg": {
            name: "Global",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        };
      if (key === "labels:42220")
        return {
          "0xccc": {
            name: "Celo",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        };
      return null;
    });

    const { scopes, legacyKeys } = await readLegacyScopes();
    expect(legacyKeys.sort()).toEqual(["labels:42220", "labels:global"]);
    expect(scopes.map((s) => s.key).sort()).toEqual([
      "labels:42220",
      "labels:global",
    ]);
    const global = scopes.find((s) => s.key === "labels:global");
    expect(global?.entries["0xggg"].name).toBe("Global");
  });

  it("returns an empty scope/key list when no legacy hash has entries", async () => {
    mocks.hgetall.mockResolvedValue(null);
    const { scopes, legacyKeys } = await readLegacyScopes();
    expect(scopes).toHaveLength(0);
    expect(legacyKeys).toHaveLength(0);
  });

  it("does not call SCAN — uses the deterministic legacy-key list", async () => {
    mocks.hgetall.mockResolvedValue(null);
    await readLegacyScopes();
    expect(mocks.scan).not.toHaveBeenCalled();
  });
});

describe("dropLegacyScopes — migration helper", () => {
  it("DELs every legacy key in a single variadic call", async () => {
    await dropLegacyScopes(["labels:global", "labels:42220"]);
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith("labels:global", "labels:42220");
  });

  it("is a no-op when the legacy-key list is empty", async () => {
    await dropLegacyScopes([]);
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe("getLabel — single-address HGET with legacy fallback", () => {
  it("returns the entry from the flat hash without checking legacy", async () => {
    mocks.hget.mockImplementation(async (key: string) =>
      key === "labels"
        ? {
            name: "Alice",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          }
        : null,
    );
    const entry = await getLabel("0xABC");
    // Only the flat-hash HGET should fire; no legacy fallback when flat hits.
    expect(mocks.hget).toHaveBeenCalledTimes(1);
    expect(mocks.hget).toHaveBeenCalledWith("labels", "0xabc");
    expect(entry?.name).toBe("Alice");
  });

  it("falls back to legacy scopes when the address isn't in the flat hash", async () => {
    mocks.hget.mockImplementation(async (key: string) => {
      if (key === "labels") return null;
      if (key === "labels:42220")
        return {
          name: "Legacy-Alice",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        };
      return null;
    });
    const entry = await getLabel("0xABC");
    expect(entry?.name).toBe("Legacy-Alice");
  });

  it("returns null when no flat or legacy hash has the address", async () => {
    mocks.hget.mockResolvedValue(null);
    expect(await getLabel("0xABC")).toBeNull();
  });
});

describe("getLabelsByAddress — HMGET batch", () => {
  // Codex flagged this with a P1 claim that Upstash returns a positional
  // array, but `@upstash/redis`'s HMGetCommand wraps the raw array via
  // `deserialize4(fields, result)` which builds `{[fieldName]: value | null}`.
  // The tests below pin both shapes — Upstash's actual object output and
  // the `null` outer return — so a future client upgrade that drops the
  // wrapper would fail loudly here instead of silently breaking the
  // migration's verification step.

  it("returns an array aligned with the input addresses (null for missing fields)", async () => {
    // Upstash's `hmget` deserializer returns an object keyed by field name,
    // with `null` for missing fields. Asserting the helper handles that.
    mocks.hmget.mockResolvedValueOnce({
      "0xaaa": {
        name: "A",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      "0xbbb": null,
    });
    const result = await getLabelsByAddress(["0xAAA", "0xBBB"]);
    expect(mocks.hmget).toHaveBeenCalledWith("labels", "0xaaa", "0xbbb");
    expect(result[0]?.name).toBe("A");
    expect(result[1]).toBeNull();
  });

  it("returns all-null when every requested field is missing (Upstash returns null)", async () => {
    // When EVERY requested field is missing, Upstash's deserializer returns
    // `null` (not an object). The helper must convert that to a same-length
    // null array so the migration's verification step doesn't blow up.
    mocks.hmget.mockResolvedValueOnce(null);
    const result = await getLabelsByAddress(["0xAAA", "0xBBB"]);
    expect(result).toEqual([null, null]);
  });

  it("returns an empty array for an empty input (no Redis call)", async () => {
    expect(await getLabelsByAddress([])).toEqual([]);
    expect(mocks.hmget).not.toHaveBeenCalled();
  });
});

describe("upgradeEntry — backward compat", () => {
  it("passes through v2 entries", () => {
    const entry = upgradeEntry({
      name: "Wintermute",
      tags: ["Market Maker"],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(entry.name).toBe("Wintermute");
    expect(entry.tags).toEqual(["Market Maker"]);
  });

  it("upgrades v1 entries (label → name, category → tags[0])", () => {
    const entry = upgradeEntry({
      label: "Old Name",
      category: "CEX",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(entry.name).toBe("Old Name");
    expect(entry.tags).toEqual(["CEX"]);
  });

  it("handles entries with neither name nor label", () => {
    const entry = upgradeEntry({ updatedAt: "2026-01-01T00:00:00Z" });
    expect(entry.name).toBe("");
    expect(entry.tags).toEqual([]);
  });
});
