import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @upstash/redis before importing the module under test
vi.mock("@upstash/redis", () => {
  const multiExec = vi.fn().mockResolvedValue([]);
  const multiHset = vi.fn();
  const multiHdel = vi.fn();
  const multiFactory = () => {
    const multi = {
      hset: multiHset,
      hdel: multiHdel,
      exec: multiExec,
    };
    multiHset.mockReturnValue(multi);
    multiHdel.mockReturnValue(multi);
    return multi;
  };
  const Redis = vi.fn();
  Redis.prototype.scan = vi.fn();
  Redis.prototype.hgetall = vi.fn();
  Redis.prototype.hset = vi.fn();
  Redis.prototype.hdel = vi.fn();
  Redis.prototype.multi = vi.fn(multiFactory);
  return { Redis, __multi: { multiExec, multiHset, multiHdel } };
});

// Stub env vars so getRedis() doesn't throw
vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");

import {
  getAllLabels,
  getLabels,
  upsertEntry,
  importLabels,
  upgradeEntry,
} from "@/lib/address-labels";
import { Redis } from "@upstash/redis";

// Grab the multi spies the mock factory created so we can assert against
// them. Cast through unknown to bypass the module-type barrier.
const mockedUpstash = (await import("@upstash/redis")) as unknown as {
  __multi: {
    multiExec: ReturnType<typeof vi.fn>;
    multiHset: ReturnType<typeof vi.fn>;
    multiHdel: ReturnType<typeof vi.fn>;
  };
};
const { multiExec, multiHset, multiHdel } = mockedUpstash.__multi;

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

  it("works for global scope", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xaaa": {
          name: "Cross-chain",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const result = await getLabels("global");
    expect(Redis.prototype.hgetall).toHaveBeenCalledWith("labels:global");
    expect(result["0xaaa"].name).toBe("Cross-chain");
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
});

describe("upsertEntry — persists isPublic and enforces strict either/or", () => {
  it("stores isPublic: true when provided, writes to per-chain key", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:42220"],
    ]);
    await upsertEntry(42220, "0xABC", {
      name: "Test",
      tags: [],
      isPublic: true,
    });
    expect(multiHset).toHaveBeenCalledTimes(1);
    const [targetKey, fields] = multiHset.mock.calls[0];
    expect(targetKey).toBe("labels:42220");
    const stored = Object.values(fields)[0] as { isPublic: boolean };
    expect(stored.isPublic).toBe(true);
    // No other scopes exist → no HDEL calls.
    expect(multiHdel).not.toHaveBeenCalled();
    expect(multiExec).toHaveBeenCalledTimes(1);
  });

  it("writes to labels:global when scope is 'global'", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:global"],
    ]);
    await upsertEntry("global", "0xABC", { name: "Test", tags: [] });
    const [targetKey] = multiHset.mock.calls[0];
    expect(targetKey).toBe("labels:global");
  });

  it("HDELs the address from every other existing scope (strict either/or)", async () => {
    // Pretend three scopes exist: global + two chains.
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:global", "labels:42220", "labels:143"],
    ]);
    await upsertEntry(42220, "0xABC", { name: "Celo", tags: [] });

    // HSET at the target.
    const [targetKey] = multiHset.mock.calls[0];
    expect(targetKey).toBe("labels:42220");

    // HDEL from global AND from labels:143 — but NOT from labels:42220.
    const hdelKeys = multiHdel.mock.calls.map((c) => c[0]);
    expect(hdelKeys).toContain("labels:global");
    expect(hdelKeys).toContain("labels:143");
    expect(hdelKeys).not.toContain("labels:42220");

    // All HDELs lowercase the address.
    for (const call of multiHdel.mock.calls) {
      expect(call[1]).toBe("0xabc");
    }
  });

  it("upsert at global HDELs same address from every chain scope", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:global", "labels:42220"],
    ]);
    await upsertEntry("global", "0xABC", { name: "Cross-chain", tags: [] });

    const [targetKey] = multiHset.mock.calls[0];
    expect(targetKey).toBe("labels:global");

    const hdelKeys = multiHdel.mock.calls.map((c) => c[0]);
    expect(hdelKeys).toContain("labels:42220");
    expect(hdelKeys).not.toContain("labels:global");
  });
});

describe("importLabels — isPublic coercion and invariant", () => {
  it('coerces isPublic: "yes" to false', async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:42220"],
    ]);
    await importLabels(42220, {
      "0xabc": {
        name: "Test",
        tags: [],
        // @ts-expect-error intentionally passing wrong type to test coercion
        isPublic: "yes",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const [, fields] = multiHset.mock.calls[0];
    const stored = Object.values(fields)[0] as { isPublic: boolean };
    expect(stored.isPublic).toBe(false);
  });

  it("keeps isPublic: true when it is strictly true", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:42220"],
    ]);
    await importLabels(42220, {
      "0xabc": {
        name: "Test",
        tags: [],
        isPublic: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const [, fields] = multiHset.mock.calls[0];
    const stored = Object.values(fields)[0] as { isPublic: boolean };
    expect(stored.isPublic).toBe(true);
  });

  it("HDELs imported addresses from other scopes", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:global", "labels:42220"],
    ]);
    await importLabels("global", {
      "0xaaa": {
        name: "A",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      "0xbbb": {
        name: "B",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });

    const [targetKey] = multiHset.mock.calls[0];
    expect(targetKey).toBe("labels:global");

    // One HDEL call per other-scope key with all imported addresses.
    expect(multiHdel).toHaveBeenCalledTimes(1);
    const [hdelKey, ...fields] = multiHdel.mock.calls[0];
    expect(hdelKey).toBe("labels:42220");
    expect(fields).toEqual(expect.arrayContaining(["0xaaa", "0xbbb"]));
  });
});

describe("getAllLabels — paginated SCAN", () => {
  it("returns { global, chains } from a single-page scan", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:global", "labels:42220"],
    ]);
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>)
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

    const result = await getAllLabels();
    expect(result.global["0xggg"].name).toBe("Global");
    expect(result.chains["42220"]["0xccc"].name).toBe("Celo");
  });

  it("follows cursor pagination across multiple pages", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(["5", ["labels:42220"]])
      .mockResolvedValueOnce(["0", ["labels:143"]]);

    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        "0xaaa": { name: "Celo", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      })
      .mockResolvedValueOnce({
        "0xbbb": { name: "Monad", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      });

    const result = await getAllLabels();
    expect(Redis.prototype.scan).toHaveBeenCalledTimes(2);
    expect(result.chains).toHaveProperty("42220");
    expect(result.chains).toHaveProperty("143");
    expect(result.global).toEqual({});
  });

  it("returns empty global + chains when no labels:* keys exist", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      [],
    ]);

    const result = await getAllLabels();
    expect(result).toEqual({ global: {}, chains: {} });
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
