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
  const evalMock = vi.fn();
  return {
    Redis: function MockRedis() {
      return { hgetall, hget, hmget, hset, hdel, eval: evalMock };
    },
    __mocks: { hgetall, hget, hmget, hset, hdel, evalMock },
  };
});

vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");

import {
  getLabels,
  getLabelsForAddresses,
  getLabel,
  upsertEntry,
  deleteLabel,
  importArkhamRefreshLabelsIfUnchanged,
  importLabels,
  importLabelsIfAbsent,
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
      evalMock: ReturnType<typeof vi.fn>;
    };
  }
).__mocks;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getLabels", () => {
  it("returns all entries from the flat labels hash", async () => {
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
    });
    const result = await getLabels();
    expect(mocks.hgetall).toHaveBeenCalledWith("labels");
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["0xaaa"]!.name).toBe("One");
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
    expect(result["0xaaa"]!.name).toBe("Legacy");
    expect(result["0xaaa"]!.tags).toEqual(["DeFi"]);
    expect((result["0xaaa"] as Record<string, unknown>).label).toBeUndefined();
  });

  it("does not read retired legacy scope hashes", async () => {
    mocks.hgetall.mockResolvedValue(null);
    await getLabels();
    expect(mocks.hgetall).toHaveBeenCalledTimes(1);
    expect(mocks.hgetall).toHaveBeenCalledWith("labels");
  });
});

describe("getLabelsForAddresses", () => {
  it("reads only requested address fields with HMGET", async () => {
    mocks.hmget.mockResolvedValue({
      "0xaaa": {
        name: "One",
        tags: [],
        isPublic: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });

    const result = await getLabelsForAddresses(["0xAAA", "0xBBB", "0xAAA"]);

    expect(mocks.hmget).toHaveBeenCalledWith("labels", "0xaaa", "0xbbb");
    expect(mocks.hgetall).not.toHaveBeenCalled();
    expect(Object.keys(result)).toEqual(["0xaaa"]);
    expect(result["0xaaa"]!.name).toBe("One");
  });

  it("chunks large field lists", async () => {
    mocks.hmget.mockResolvedValue({});
    const addresses = Array.from(
      { length: 1001 },
      (_, i) => `0x${i.toString(16).padStart(40, "0")}`,
    );

    await getLabelsForAddresses(addresses);

    expect(mocks.hmget).toHaveBeenCalledTimes(2);
    expect(mocks.hmget.mock.calls[0]!.length).toBe(1 + 1000);
    expect(mocks.hmget.mock.calls[1]!.length).toBe(1 + 1);
  });

  it("returns empty object without Redis when input is empty", async () => {
    expect(await getLabelsForAddresses([])).toEqual({});
    expect(mocks.hmget).not.toHaveBeenCalled();
  });
});

describe("upsertEntry", () => {
  it("writes a single HSET to the flat labels hash, lowercasing the address", async () => {
    await upsertEntry("0xABC", { name: "Test", tags: [], isPublic: true });
    expect(mocks.hset).toHaveBeenCalledTimes(1);
    const [key, fields] = mocks.hset.mock.calls[0]!;
    expect(key).toBe("labels");
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]!);
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
    const [, fields] = mocks.hset.mock.calls[0]!;
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]!);
    expect(value.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("deleteLabel", () => {
  it("HDELs the flat labels hash only", async () => {
    await deleteLabel("0xABC");
    expect(mocks.hdel).toHaveBeenCalledWith("labels", "0xabc");
    expect(mocks.hdel).toHaveBeenCalledTimes(1);
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
    const [key, fields] = mocks.hset.mock.calls[0]!;
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
    const [, fields] = mocks.hset.mock.calls[0]!;
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]!);
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
    const [, fields] = mocks.hset.mock.calls[0]!;
    const value = JSON.parse((fields as Record<string, string>)["0xabc"]!);
    expect(value.isPublic).toBe(true);
  });

  it("is a no-op when the batch is empty", async () => {
    await importLabels({});
    expect(mocks.hset).not.toHaveBeenCalled();
  });
});

describe("importLabelsIfAbsent", () => {
  it("inserts labels with an atomic HGET/HSET Lua script and returns written count", async () => {
    mocks.evalMock.mockResolvedValue(1);

    await expect(
      importLabelsIfAbsent({
        "0xAAA": {
          name: "A",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
        "0xbbb": {
          name: "B",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).resolves.toBe(1);

    expect(mocks.evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, argv] = mocks.evalMock.mock.calls[0]!;
    expect(script).toContain("HGET");
    expect(script).toContain("HSET");
    expect(keys).toEqual(["labels"]);
    expect(argv).toHaveLength(4);
    expect(argv[0]).toBe("0xaaa");
    expect(argv[2]).toBe("0xbbb");
  });

  it("is a no-op when the insert-only batch is empty", async () => {
    await expect(importLabelsIfAbsent({})).resolves.toBe(0);
    expect(mocks.evalMock).not.toHaveBeenCalled();
  });
});

describe("importArkhamRefreshLabelsIfUnchanged", () => {
  it("updates Arkham labels with an atomic source + updatedAt compare-and-set Lua script", async () => {
    mocks.evalMock.mockResolvedValue(1);

    await expect(
      importArkhamRefreshLabelsIfUnchanged(
        {
          "0xAAA": {
            name: "Arkham label",
            tags: [],
            source: "arkham",
            updatedAt: "2026-04-02T00:00:00Z",
          },
        },
        { "0xaaa": "2026-04-01T00:00:00Z" },
      ),
    ).resolves.toBe(1);

    expect(mocks.evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, argv] = mocks.evalMock.mock.calls[0]!;
    expect(script).toContain("cjson.decode");
    expect(script).toContain("updatedAt");
    expect(script).toContain('type(raw_updated_at) == "string"');
    expect(script).toContain("source");
    expect(keys).toEqual(["labels"]);
    expect(argv).toHaveLength(3);
    expect(argv[0]).toBe("0xaaa");
    expect(argv[1]).toBe("2026-04-01T00:00:00Z");
    expect(JSON.parse(argv[2] as string)).toMatchObject({
      name: "Arkham label",
      source: "arkham",
    });
  });

  it("is a no-op for empty, non-Arkham, or missing-expectation refresh batches", async () => {
    await expect(importArkhamRefreshLabelsIfUnchanged({}, {})).resolves.toBe(0);
    await expect(
      importArkhamRefreshLabelsIfUnchanged(
        {
          "0xAAA": {
            name: "Manual label",
            tags: [],
            updatedAt: "2026-04-02T00:00:00Z",
          },
        },
        { "0xaaa": "2026-04-01T00:00:00Z" },
      ),
    ).resolves.toBe(0);
    await expect(
      importArkhamRefreshLabelsIfUnchanged(
        {
          "0xBBB": {
            name: "Arkham label",
            tags: [],
            source: "arkham",
            updatedAt: "2026-04-02T00:00:00Z",
          },
        },
        {},
      ),
    ).resolves.toBe(0);
    expect(mocks.evalMock).not.toHaveBeenCalled();
  });
});

describe("getLabel — single-address HGET", () => {
  it("returns the entry from the flat hash", async () => {
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
    expect(mocks.hget).toHaveBeenCalledTimes(1);
    expect(mocks.hget).toHaveBeenCalledWith("labels", "0xabc");
    expect(entry?.name).toBe("Alice");
  });

  it("returns null when the flat hash does not have the address", async () => {
    mocks.hget.mockResolvedValue(null);
    expect(await getLabel("0xABC")).toBeNull();
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

  it("substitutes a stable empty-string `updatedAt` for legacy rows missing the timestamp (codex round 7)", () => {
    // Codex flagged that synthesizing `new Date().toISOString()` here makes
    // `entry.updatedAt` change on every 30s SWR poll for legacy rows, so
    // the detail page (which keys the form mount on `updatedAt`) would
    // remount and discard in-progress edits every poll. Pin the stable
    // sentinel: two upgrades of the same legacy entry must yield the same
    // `updatedAt`.
    const legacy = { label: "Old", category: "CEX" };
    const a = upgradeEntry({ ...legacy });
    const b = upgradeEntry({ ...legacy });
    expect(a.updatedAt).toBe("");
    expect(b.updatedAt).toBe("");

    // V2 entries with a persisted timestamp pass through unchanged.
    const v2 = upgradeEntry({
      name: "New",
      tags: [],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(v2.updatedAt).toBe("2026-01-01T00:00:00Z");

    // Tag-only legacy entries also get the stable sentinel.
    const tagOnly = upgradeEntry({ tags: ["mev"] });
    expect(tagOnly.updatedAt).toBe("");
  });
});
