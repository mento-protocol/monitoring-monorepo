import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @upstash/redis before importing the module under test
vi.mock("@upstash/redis", () => {
  const Redis = vi.fn();
  Redis.prototype.scan = vi.fn();
  Redis.prototype.hgetall = vi.fn();
  Redis.prototype.hset = vi.fn();
  Redis.prototype.hdel = vi.fn();
  return { Redis };
});

// Stub env vars so getRedis() doesn't throw
vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");

import {
  getAllChainLabels,
  getLabels,
  upsertEntry,
  importLabels,
  upgradeEntry,
} from "@/lib/address-labels";
import { Redis } from "@upstash/redis";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getLabels — publicOnly filter", () => {
  it("returns all entries when publicOnly is not set", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xaaa": {
          name: "Public",
          tags: [],
          isPublic: true,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xbbb": {
          name: "Private",
          tags: [],
          isPublic: false,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xccc": {
          name: "NoFlag",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const result = await getLabels(42220);
    expect(Object.keys(result)).toHaveLength(3);
  });

  it("returns only isPublic===true entries when publicOnly is true", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xaaa": {
          name: "Public",
          tags: [],
          isPublic: true,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xbbb": {
          name: "Private",
          tags: [],
          isPublic: false,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xccc": {
          name: "NoFlag",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const result = await getLabels(42220, { publicOnly: true });
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["0xaaa"].name).toBe("Public");
  });

  it("treats missing isPublic as private when publicOnly is true", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xaaa": {
          name: "NoFlag",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const result = await getLabels(42220, { publicOnly: true });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns all entries when publicOnly is false", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xaaa": {
          name: "Public",
          tags: [],
          isPublic: true,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xbbb": {
          name: "Private",
          tags: [],
          isPublic: false,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const result = await getLabels(42220, { publicOnly: false });
    expect(Object.keys(result)).toHaveLength(2);
  });
});

describe("upsertEntry — persists isPublic", () => {
  it("stores isPublic: true when provided", async () => {
    (Redis.prototype.hset as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    await upsertEntry(42220, "0xABC", {
      name: "Test",
      tags: [],
      isPublic: true,
    });
    const [, fields] = (Redis.prototype.hset as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const stored = Object.values(fields)[0] as { isPublic: boolean };
    expect(stored.isPublic).toBe(true);
  });

  it("stores isPublic: false when not provided", async () => {
    (Redis.prototype.hset as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    await upsertEntry(42220, "0xABC", { name: "Test", tags: [] });
    const [, fields] = (Redis.prototype.hset as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const stored = Object.values(fields)[0] as {
      isPublic: boolean | undefined;
    };
    expect(stored.isPublic).toBeFalsy();
  });
});

describe("importLabels — isPublic coercion", () => {
  it('coerces isPublic: "yes" to false', async () => {
    (Redis.prototype.hset as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    await importLabels(42220, {
      "0xabc": {
        name: "Test",
        tags: [],
        // @ts-expect-error intentionally passing wrong type to test coercion
        isPublic: "yes",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const [, fields] = (Redis.prototype.hset as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const stored = Object.values(fields)[0] as { isPublic: boolean };
    expect(stored.isPublic).toBe(false);
  });

  it("keeps isPublic: true when it is strictly true", async () => {
    (Redis.prototype.hset as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    await importLabels(42220, {
      "0xabc": {
        name: "Test",
        tags: [],
        isPublic: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const [, fields] = (Redis.prototype.hset as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const stored = Object.values(fields)[0] as { isPublic: boolean };
    expect(stored.isPublic).toBe(true);
  });
});

describe("getAllChainLabels — paginated SCAN", () => {
  it("returns labels from a single-page scan", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:42220"],
    ]);
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xabc": { name: "Test", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      },
    );

    const result = await getAllChainLabels();
    expect(result).toHaveProperty("42220");
    expect(result["42220"]["0xabc"].name).toBe("Test");
    expect(Redis.prototype.scan).toHaveBeenCalledTimes(1);
  });

  it("follows cursor pagination across multiple pages", async () => {
    // Page 1: cursor=5 (non-zero → continue)
    (Redis.prototype.scan as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(["5", ["labels:42220"]])
      // Page 2: cursor=0 → done
      .mockResolvedValueOnce(["0", ["labels:11142220"]]);

    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        "0xaaa": {
          name: "Mainnet",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        "0xbbb": {
          name: "Sepolia",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });

    const result = await getAllChainLabels();

    expect(Redis.prototype.scan).toHaveBeenCalledTimes(2);
    expect(result).toHaveProperty("42220");
    expect(result).toHaveProperty("11142220");
    expect(result["42220"]["0xaaa"].name).toBe("Mainnet");
    expect(result["11142220"]["0xbbb"].name).toBe("Sepolia");
  });

  it("returns empty object when no labels:* keys exist", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      [],
    ]);

    const result = await getAllChainLabels();
    expect(result).toEqual({});
    expect(Redis.prototype.scan).toHaveBeenCalledTimes(1);
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

  it("upgrades v1 entries without category (empty tags)", () => {
    const entry = upgradeEntry({
      label: "Old Name",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(entry.name).toBe("Old Name");
    expect(entry.tags).toEqual([]);
  });

  it("handles entries with neither name nor label", () => {
    const entry = upgradeEntry({ updatedAt: "2026-01-01T00:00:00Z" });
    expect(entry.name).toBe("");
    expect(entry.tags).toEqual([]);
  });

  it("auto-upgrades v1 entries on getLabels read", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xaaa": {
          label: "Legacy",
          category: "DeFi",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const result = await getLabels(42220);
    expect(result["0xaaa"].name).toBe("Legacy");
    expect(result["0xaaa"].tags).toEqual(["DeFi"]);
    // label/category should not exist in returned entry
    expect((result["0xaaa"] as Record<string, unknown>).label).toBeUndefined();
    expect(
      (result["0xaaa"] as Record<string, unknown>).category,
    ).toBeUndefined();
  });
});
