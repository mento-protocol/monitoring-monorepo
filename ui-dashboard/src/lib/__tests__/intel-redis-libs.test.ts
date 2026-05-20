import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @/lib/redis so the intel-* libs never touch a real client.
const hget = vi.fn();
const hgetall = vi.fn();
const hkeys = vi.fn();

vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(() => ({ hget, hgetall, hkeys })),
}));

import {
  getIntelDeep,
  getAllIntelDeep,
  INTEL_DEEP_KEY,
} from "@/lib/intel-deep";
import {
  getIntelTransfers,
  getAllIntelTransfers,
  INTEL_TRANSFERS_KEY,
} from "@/lib/intel-transfers";
import {
  getIntelWealth,
  getAllIntelWealth,
  INTEL_WEALTH_KEY,
} from "@/lib/intel-wealth";
import {
  getIntelEntity,
  getAllIntelEntities,
  hkeysIntelEntities,
  INTEL_ENTITIES_KEY,
  INTEL_ENTITY_SLUG_RE,
} from "@/lib/intel-entities";
import {
  getIntelEntityCps,
  getAllIntelEntityCps,
  INTEL_ENTITY_CPS_KEY,
} from "@/lib/intel-entity-cps";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("intel-deep", () => {
  it("getIntelDeep: calls hget with the right key, lowercases address, returns data", async () => {
    const record = { address: "0xabc", fetchedAt: "2026-01-01T00:00:00Z" };
    hget.mockResolvedValue(record);
    const result = await getIntelDeep("0xABC");
    expect(hget).toHaveBeenCalledWith(INTEL_DEEP_KEY, "0xabc");
    expect(result).toBe(record);
  });

  it("getIntelDeep: returns null when redis returns null", async () => {
    hget.mockResolvedValue(null);
    expect(await getIntelDeep("0xabc")).toBeNull();
  });

  it("getAllIntelDeep: returns all records, falls back to {} on null", async () => {
    const all = { "0xaaa": { address: "0xaaa", fetchedAt: "2026-01-01" } };
    hgetall.mockResolvedValue(all);
    // toEqual (not toBe) because the legacy-fallback helper spreads-merges
    // intel + arkham hashes into a fresh object.
    expect(await getAllIntelDeep()).toEqual(all);

    hgetall.mockResolvedValue(null);
    expect(await getAllIntelDeep()).toEqual({});
  });

  it("getIntelDeep: falls back to legacy arkham_deep when intel is empty", async () => {
    const legacyRecord = { address: "0xbbb", fetchedAt: "2026-01-01" };
    hget.mockResolvedValueOnce(null).mockResolvedValueOnce(legacyRecord);
    const result = await getIntelDeep("0xBBB");
    expect(hget).toHaveBeenNthCalledWith(1, INTEL_DEEP_KEY, "0xbbb");
    expect(hget).toHaveBeenNthCalledWith(2, "arkham_deep", "0xbbb");
    expect(result).toBe(legacyRecord);
  });

  it("getAllIntelDeep: merges legacy entries, intel wins on collision", async () => {
    const intel = { "0xaaa": { address: "0xaaa", source: "intel" } };
    const legacy = {
      "0xaaa": { address: "0xaaa", source: "arkham" }, // collides
      "0xbbb": { address: "0xbbb", source: "arkham" }, // legacy-only
    };
    hgetall.mockImplementation((key: string) =>
      Promise.resolve(key === INTEL_DEEP_KEY ? intel : legacy),
    );
    const result = await getAllIntelDeep();
    expect(result).toEqual({
      "0xaaa": { address: "0xaaa", source: "intel" },
      "0xbbb": { address: "0xbbb", source: "arkham" },
    });
  });

  it("getAllIntelDeep: lowercases legacy mixed-case keys on merge", async () => {
    const intel = {};
    const legacy = {
      "0xAaA": { address: "0xAaA", source: "arkham" }, // mixed-case key
    };
    hgetall.mockImplementation((key: string) =>
      Promise.resolve(key === INTEL_DEEP_KEY ? intel : legacy),
    );
    const result = await getAllIntelDeep();
    expect(result).toEqual({
      "0xaaa": { address: "0xAaA", source: "arkham" },
    });
  });
});

describe("intel-transfers", () => {
  it("getIntelTransfers: calls hget with the right key and lowercases address", async () => {
    const record = {
      address: "0xabc",
      fetchedAt: "2026-01-01",
      transferCount: 0,
      transfers: null,
    };
    hget.mockResolvedValue(record);
    const result = await getIntelTransfers("0xABC");
    expect(hget).toHaveBeenCalledWith(INTEL_TRANSFERS_KEY, "0xabc");
    expect(result).toBe(record);
  });

  it("getIntelTransfers: returns null on cache miss", async () => {
    hget.mockResolvedValue(null);
    expect(await getIntelTransfers("0xabc")).toBeNull();
  });

  it("getAllIntelTransfers: falls back to {} on null", async () => {
    hgetall.mockResolvedValue(null);
    expect(await getAllIntelTransfers()).toEqual({});
  });
});

describe("intel-wealth", () => {
  it("getIntelWealth: calls hget with the right key and lowercases address", async () => {
    const record = {
      address: "0xabc",
      fetchedAt: "2026-01-01",
      sources: [],
      balances: null,
      portfolio: null,
      version: 1,
    };
    hget.mockResolvedValue(record);
    const result = await getIntelWealth("0xABC");
    expect(hget).toHaveBeenCalledWith(INTEL_WEALTH_KEY, "0xabc");
    expect(result).toBe(record);
  });

  it("getIntelWealth: returns null on cache miss", async () => {
    hget.mockResolvedValue(null);
    expect(await getIntelWealth("0xabc")).toBeNull();
  });

  it("getAllIntelWealth: falls back to {} on null", async () => {
    hgetall.mockResolvedValue(null);
    expect(await getAllIntelWealth()).toEqual({});
  });
});

describe("intel-entities", () => {
  it("INTEL_ENTITY_SLUG_RE accepts valid slugs and rejects invalid ones", () => {
    expect(INTEL_ENTITY_SLUG_RE.test("binance")).toBe(true);
    expect(INTEL_ENTITY_SLUG_RE.test("some-entity_123")).toBe(true);
    expect(INTEL_ENTITY_SLUG_RE.test("Invalid Slug!")).toBe(false);
    expect(INTEL_ENTITY_SLUG_RE.test("")).toBe(false);
  });

  it("getIntelEntity: calls hget with slug (no lowercasing)", async () => {
    const record = {
      slug: "binance",
      fetchedAt: "2026-01-01",
      name: "Binance",
    };
    hget.mockResolvedValue(record);
    const result = await getIntelEntity("binance");
    expect(hget).toHaveBeenCalledWith(INTEL_ENTITIES_KEY, "binance");
    expect(result).toBe(record);
  });

  it("getIntelEntity: returns null on cache miss", async () => {
    hget.mockResolvedValue(null);
    expect(await getIntelEntity("unknown-slug")).toBeNull();
  });

  it("getAllIntelEntities: falls back to {} on null", async () => {
    hgetall.mockResolvedValue(null);
    expect(await getAllIntelEntities()).toEqual({});
  });

  it("hkeysIntelEntities: returns list of slug keys", async () => {
    hkeys.mockResolvedValue(["binance", "coinbase"]);
    const result = await hkeysIntelEntities();
    expect(hkeys).toHaveBeenCalledWith(INTEL_ENTITIES_KEY);
    expect(result).toEqual(["binance", "coinbase"]);
  });
});

describe("intel-entity-cps", () => {
  it("getIntelEntityCps: calls hget with slug", async () => {
    const record = {
      slug: "binance",
      fetchedAt: "2026-01-01",
      counterparties: null,
    };
    hget.mockResolvedValue(record);
    const result = await getIntelEntityCps("binance");
    expect(hget).toHaveBeenCalledWith(INTEL_ENTITY_CPS_KEY, "binance");
    expect(result).toBe(record);
  });

  it("getIntelEntityCps: returns null on cache miss", async () => {
    hget.mockResolvedValue(null);
    expect(await getIntelEntityCps("unknown-slug")).toBeNull();
  });

  it("getAllIntelEntityCps: falls back to {} on null", async () => {
    hgetall.mockResolvedValue(null);
    expect(await getAllIntelEntityCps()).toEqual({});
  });
});
