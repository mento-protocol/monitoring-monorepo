import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @upstash/redis before importing the module under test
vi.mock("@upstash/redis", () => {
  const Redis = vi.fn();
  Redis.prototype.scan = vi.fn();
  Redis.prototype.hgetall = vi.fn();
  Redis.prototype.hset = vi.fn();
  Redis.prototype.hdel = vi.fn();
  Redis.prototype.eval = vi.fn().mockResolvedValue(1);
  return { Redis };
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

const evalMock = Redis.prototype.eval as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getLabels", () => {
  it("returns all entries for a chain scope", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
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
        "0xccc": {
          name: "Three",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const result = await getLabels(42220);
    expect(Object.keys(result)).toHaveLength(3);
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

  it("returns empty object when hgetall returns null", async () => {
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      null,
    );
    const result = await getLabels(42220);
    expect(result).toEqual({});
  });
});

// Helpers for the atomic Lua-script path. The script takes the target key
// via KEYS[1] and a flat [count, addr1, value1, addr2, value2, …] ARGV tuple.
function evalCall(call: unknown[]): {
  script: string;
  keys: string[];
  args: string[];
} {
  const [script, keys, args] = call as [string, string[], string[]];
  return { script, keys, args };
}

function evalEntries(args: string[]): Array<{ addr: string; value: unknown }> {
  const count = Number(args[0]);
  const entries: Array<{ addr: string; value: unknown }> = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      addr: args[1 + i * 2],
      value: JSON.parse(args[2 + i * 2]),
    });
  }
  return entries;
}

describe("upsertEntry — persists isPublic and enforces strict either/or", () => {
  it("stores isPublic: true when provided, writes to per-chain key", async () => {
    await upsertEntry(42220, "0xABC", {
      name: "Test",
      tags: [],
      isPublic: true,
    });
    expect(evalMock).toHaveBeenCalledTimes(1);
    const { keys, args } = evalCall(evalMock.mock.calls[0]);
    expect(keys).toEqual(["labels:42220"]);
    const [{ addr, value }] = evalEntries(args);
    expect(addr).toBe("0xabc");
    expect((value as { isPublic: boolean }).isPublic).toBe(true);
  });

  it("writes to labels:global when scope is 'global'", async () => {
    await upsertEntry("global", "0xABC", { name: "Test", tags: [] });
    const { keys } = evalCall(evalMock.mock.calls[0]);
    expect(keys).toEqual(["labels:global"]);
  });

  it("passes the Lua script that HDELs the address from every other scope", async () => {
    await upsertEntry(42220, "0xABC", { name: "Celo", tags: [] });
    const { script, keys, args } = evalCall(evalMock.mock.calls[0]);
    // The script itself performs the cross-scope HDEL atomically on the
    // Redis server — we can't observe intermediate pipeline calls, but we
    // can assert the script's cross-scope cleanup is part of the payload.
    expect(script).toContain("'labels:*'");
    expect(script).toContain("HDEL");
    expect(script).toContain("HSET");
    expect(keys).toEqual(["labels:42220"]);
    const [{ addr }] = evalEntries(args);
    expect(addr).toBe("0xabc");
  });

  it("upsert at global writes via the same atomic script path", async () => {
    await upsertEntry("global", "0xABC", { name: "Cross-chain", tags: [] });
    const { keys, args } = evalCall(evalMock.mock.calls[0]);
    expect(keys).toEqual(["labels:global"]);
    const [{ addr, value }] = evalEntries(args);
    expect(addr).toBe("0xabc");
    expect((value as { name: string }).name).toBe("Cross-chain");
  });
});

describe("importLabels — isPublic coercion and invariant", () => {
  it('coerces isPublic: "yes" to false', async () => {
    await importLabels(42220, {
      "0xabc": {
        name: "Test",
        tags: [],
        // @ts-expect-error intentionally passing wrong type to test coercion
        isPublic: "yes",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const { args } = evalCall(evalMock.mock.calls[0]);
    const [{ value }] = evalEntries(args);
    expect((value as { isPublic: boolean }).isPublic).toBe(false);
  });

  it("keeps isPublic: true when it is strictly true", async () => {
    await importLabels(42220, {
      "0xabc": {
        name: "Test",
        tags: [],
        isPublic: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const { args } = evalCall(evalMock.mock.calls[0]);
    const [{ value }] = evalEntries(args);
    expect((value as { isPublic: boolean }).isPublic).toBe(true);
  });

  it("batches all imported addresses into a single atomic EVAL", async () => {
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

    expect(evalMock).toHaveBeenCalledTimes(1);
    const { keys, args } = evalCall(evalMock.mock.calls[0]);
    expect(keys).toEqual(["labels:global"]);
    expect(Number(args[0])).toBe(2);
    const addrs = evalEntries(args).map((e) => e.addr);
    expect(addrs).toEqual(["0xaaa", "0xbbb"]);
  });

  it("is a no-op when the batch is empty (no EVAL call)", async () => {
    await importLabels("global", {});
    expect(evalMock).not.toHaveBeenCalled();
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
