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
  it("returns all entries from the flat labels hash", async () => {
    mocks.hgetall.mockResolvedValueOnce({
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
    });
    const result = await getLabels();
    expect(mocks.hgetall).toHaveBeenCalledWith("labels");
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["0xaaa"].name).toBe("One");
  });

  it("returns empty object when hgetall returns null", async () => {
    mocks.hgetall.mockResolvedValueOnce(null);
    const result = await getLabels();
    expect(result).toEqual({});
  });

  it("auto-upgrades legacy v1 entries on read (label → name)", async () => {
    mocks.hgetall.mockResolvedValueOnce({
      "0xaaa": {
        label: "Legacy",
        category: "DeFi",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const result = await getLabels();
    expect(result["0xaaa"].name).toBe("Legacy");
    expect(result["0xaaa"].tags).toEqual(["DeFi"]);
    expect((result["0xaaa"] as Record<string, unknown>).label).toBeUndefined();
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
  it("HDEL removes the address from the flat hash, lowercasing", async () => {
    await deleteLabel("0xABC");
    expect(mocks.hdel).toHaveBeenCalledWith("labels", "0xabc");
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
  it("returns every legacy labels:* hash via SCAN", async () => {
    mocks.scan.mockResolvedValueOnce([
      "0",
      ["labels:global", "labels:42220", "labels"],
    ]);
    mocks.hgetall
      .mockResolvedValueOnce({
        "0xggg": {
          name: "Global",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        "0xccc": { name: "Celo", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      });

    const { scopes } = await readLegacyScopes();
    // Only labels:global and labels:42220 — the new flat `labels` key is excluded.
    expect(scopes.map((s) => s.key).sort()).toEqual([
      "labels:42220",
      "labels:global",
    ]);
    const global = scopes.find((s) => s.key === "labels:global");
    expect(global?.entries["0xggg"].name).toBe("Global");
  });

  it("excludes the new flat 'labels' key from the legacy scan result", async () => {
    mocks.scan.mockResolvedValueOnce(["0", ["labels"]]);
    const { scopes } = await readLegacyScopes();
    expect(scopes).toHaveLength(0);
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

describe("readLegacyScopes — returns legacyKeys for downstream DEL", () => {
  it("returns both the per-scope entries and the raw key list", async () => {
    mocks.scan.mockResolvedValueOnce([
      "0",
      ["labels:global", "labels:42220", "labels"],
    ]);
    mocks.hgetall.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const { legacyKeys } = await readLegacyScopes();
    expect(legacyKeys.sort()).toEqual(["labels:42220", "labels:global"]);
  });
});

describe("getLabel — single-address HGET", () => {
  it("returns the entry for an address (lowercased)", async () => {
    mocks.hget.mockResolvedValueOnce({
      name: "Alice",
      tags: [],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const entry = await getLabel("0xABC");
    expect(mocks.hget).toHaveBeenCalledWith("labels", "0xabc");
    expect(entry?.name).toBe("Alice");
  });

  it("returns null when the address has no entry", async () => {
    mocks.hget.mockResolvedValueOnce(null);
    expect(await getLabel("0xABC")).toBeNull();
  });
});

describe("getLabelsByAddress — HMGET batch", () => {
  it("returns an array aligned with the input addresses (null for missing)", async () => {
    mocks.hmget.mockResolvedValueOnce({
      "0xaaa": {
        name: "A",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const result = await getLabelsByAddress(["0xAAA", "0xBBB"]);
    expect(mocks.hmget).toHaveBeenCalledWith("labels", "0xaaa", "0xbbb");
    expect(result[0]?.name).toBe("A");
    expect(result[1]).toBeNull();
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
