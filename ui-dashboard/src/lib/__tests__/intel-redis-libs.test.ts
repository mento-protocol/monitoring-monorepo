import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @/lib/redis so the intel-* libs never touch a real client.
const hget = vi.fn();
const hgetall = vi.fn();
const hkeys = vi.fn();
const hlen = vi.fn();
const hmget = vi.fn();
const pipelineExec = vi.fn();
const pipelineHstrlen = vi.fn();
const pipeline = vi.fn(() => ({
  exec: pipelineExec,
  hstrlen: pipelineHstrlen,
}));

vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(() => ({ hget, hgetall, hkeys, hlen, hmget, pipeline })),
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
  getIntelEntityDirectorySource,
  INTEL_ENTITIES_KEY,
  INTEL_ENTITY_DIRECTORY_MAX_BYTES,
  INTEL_ENTITY_DIRECTORY_MAX_RECORDS,
  INTEL_ENTITY_SLUG_RE,
} from "@/lib/intel-entities";
import {
  getIntelEntityCps,
  getAllIntelEntityCps,
  INTEL_ENTITY_CPS_KEY,
} from "@/lib/intel-entity-cps";

beforeEach(() => {
  vi.clearAllMocks();
  hkeys.mockResolvedValue([]);
  hlen.mockResolvedValue(0);
  hmget.mockResolvedValue({});
  pipelineExec.mockResolvedValue([]);
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

  it("getIntelDeep: falls back to mixed-case legacy address keys", async () => {
    const legacyRecord = { address: "0xBBB", fetchedAt: "2026-01-01" };
    hget
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyRecord);
    const result = await getIntelDeep("0xBBB");
    expect(hget).toHaveBeenNthCalledWith(1, INTEL_DEEP_KEY, "0xbbb");
    expect(hget).toHaveBeenNthCalledWith(2, "arkham_deep", "0xbbb");
    expect(hget).toHaveBeenNthCalledWith(3, "arkham_deep", "0xBBB");
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

  it("getIntelTransfers: falls back to mixed-case legacy address keys", async () => {
    const legacyRecord = {
      address: "0xABC",
      fetchedAt: "2026-01-01",
      transferCount: 0,
      transfers: null,
    };
    hget
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyRecord);
    const result = await getIntelTransfers("0xABC");
    expect(hget).toHaveBeenNthCalledWith(1, INTEL_TRANSFERS_KEY, "0xabc");
    expect(hget).toHaveBeenNthCalledWith(2, "arkham_transfers", "0xabc");
    expect(hget).toHaveBeenNthCalledWith(3, "arkham_transfers", "0xABC");
    expect(result).toBe(legacyRecord);
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

  it("getIntelWealth: falls back to mixed-case legacy address keys", async () => {
    const legacyRecord = {
      address: "0xABC",
      fetchedAt: "2026-01-01",
      sources: [],
      balances: null,
      portfolio: null,
      version: 1,
    };
    hget
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyRecord);
    const result = await getIntelWealth("0xABC");
    expect(hget).toHaveBeenNthCalledWith(1, INTEL_WEALTH_KEY, "0xabc");
    expect(hget).toHaveBeenNthCalledWith(2, "arkham_wealth", "0xabc");
    expect(hget).toHaveBeenNthCalledWith(3, "arkham_wealth", "0xABC");
    expect(result).toBe(legacyRecord);
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
    // Arkham slugs may contain dots (e.g. "crypto.com"); regex must accept.
    expect(INTEL_ENTITY_SLUG_RE.test("crypto.com")).toBe(true);
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

  it("getIntelEntityDirectorySource reads full records below both limits", async () => {
    const record = { slug: "binance", name: "Binance" };
    hlen.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    hkeys.mockResolvedValueOnce(["binance"]).mockResolvedValueOnce([]);
    pipelineExec.mockResolvedValue([128]);
    hmget.mockResolvedValue({ binance: record });

    await expect(getIntelEntityDirectorySource()).resolves.toEqual({
      entities: { binance: record },
      limited: false,
    });
    expect(pipelineHstrlen).toHaveBeenCalledWith(INTEL_ENTITIES_KEY, "binance");
    expect(hmget).toHaveBeenCalledWith(INTEL_ENTITIES_KEY, "binance");
    expect(hgetall).not.toHaveBeenCalled();
  });

  it("does not fetch records above the entity-count limit", async () => {
    hlen
      .mockResolvedValueOnce(INTEL_ENTITY_DIRECTORY_MAX_RECORDS + 1)
      .mockResolvedValueOnce(0);

    await expect(getIntelEntityDirectorySource()).resolves.toEqual({
      entities: null,
      limited: true,
      reason: "record-count",
    });
    expect(hkeys).not.toHaveBeenCalled();
    expect(hgetall).not.toHaveBeenCalled();
  });

  it("measures overlapping current and legacy records only once", async () => {
    const currentRecord = { slug: "binance", name: "Current Binance" };
    hlen.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    hkeys.mockResolvedValueOnce(["binance"]).mockResolvedValueOnce(["Binance"]);
    pipelineExec.mockResolvedValue([128]);
    hmget.mockResolvedValue({ binance: currentRecord });

    await expect(getIntelEntityDirectorySource()).resolves.toEqual({
      entities: { binance: currentRecord },
      limited: false,
    });
    expect(pipelineHstrlen).toHaveBeenCalledTimes(1);
    expect(pipelineHstrlen).toHaveBeenCalledWith(INTEL_ENTITIES_KEY, "binance");
    expect(hmget).toHaveBeenCalledTimes(1);
    expect(hmget).toHaveBeenCalledWith(INTEL_ENTITIES_KEY, "binance");
  });

  it("fetches only the selected fields from both hashes", async () => {
    const currentRecord = { slug: "binance", name: "Binance" };
    const legacyRecord = { slug: "kraken", name: "Kraken" };
    hlen.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    hkeys.mockResolvedValueOnce(["binance"]).mockResolvedValueOnce(["Kraken"]);
    pipelineExec.mockResolvedValue([64, 96]);
    hmget.mockImplementation((key: string) =>
      Promise.resolve(
        key === INTEL_ENTITIES_KEY
          ? { binance: currentRecord }
          : { Kraken: legacyRecord },
      ),
    );

    await expect(getIntelEntityDirectorySource()).resolves.toEqual({
      entities: {
        binance: currentRecord,
        kraken: legacyRecord,
      },
      limited: false,
    });
    expect(hmget).toHaveBeenCalledWith(INTEL_ENTITIES_KEY, "binance");
    expect(hmget).toHaveBeenCalledWith("arkham_entities", "Kraken");
    expect(hgetall).not.toHaveBeenCalled();
  });

  it("does not fetch records above the stored-payload limit", async () => {
    hlen.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    hkeys.mockResolvedValueOnce(["binance"]).mockResolvedValueOnce([]);
    pipelineExec.mockResolvedValue([INTEL_ENTITY_DIRECTORY_MAX_BYTES + 1]);

    await expect(getIntelEntityDirectorySource()).resolves.toEqual({
      entities: null,
      limited: true,
      reason: "payload-bytes",
    });
    expect(hgetall).not.toHaveBeenCalled();
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
