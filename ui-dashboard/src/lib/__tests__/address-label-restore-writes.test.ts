import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted so the mocks are available when vi.mock factories run.
const { replaceRedisHashes, mergeRedisHashes } = vi.hoisted(() => ({
  replaceRedisHashes: vi.fn().mockResolvedValue(undefined),
  mergeRedisHashes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/redis-hash", () => ({ replaceRedisHashes, mergeRedisHashes }));
vi.mock("@/lib/redis", () => ({ getRedis: vi.fn(() => ({})) }));

import {
  replaceSnapshotHashes,
  importSnapshotHashes,
} from "@/lib/address-label-restore-writes";
import { INTEL_DEEP_KEY } from "@/lib/intel-deep";
import { INTEL_TRANSFERS_KEY } from "@/lib/intel-transfers";
import { INTEL_WEALTH_KEY } from "@/lib/intel-wealth";
import { INTEL_ENTITIES_KEY } from "@/lib/intel-entities";
import { INTEL_ENTITY_CPS_KEY } from "@/lib/intel-entity-cps";
import { LABELS_KEY } from "@/lib/address-label-fields";
import { REPORTS_KEY } from "@/lib/address-report-fields";

beforeEach(() => vi.clearAllMocks());

describe("replaceSnapshotHashes — intel hashes", () => {
  it("passes intelDeep fields as JSON-encoded hash", async () => {
    const record = { address: "0xaaa", fetchedAt: "2026-01-01", version: 1 };
    await replaceSnapshotHashes({ intelDeep: { "0xaaa": record as never } });

    expect(replaceRedisHashes).toHaveBeenCalledOnce();
    const [, replacements] = replaceRedisHashes.mock.calls[0] as [
      unknown,
      Array<{ key: string; fields: Record<string, string> }>,
    ];
    const deepReplacement = replacements.find((r) => r.key === INTEL_DEEP_KEY);
    expect(deepReplacement).toBeDefined();
    expect(JSON.parse(deepReplacement!.fields["0xaaa"])).toEqual(record);
  });

  it("passes intelTransfers fields as JSON-encoded hash", async () => {
    const record = {
      address: "0xbbb",
      fetchedAt: "2026-01-01",
      transferCount: 3,
      transfers: null,
    };
    await replaceSnapshotHashes({
      intelTransfers: { "0xbbb": record as never },
    });

    const [, replacements] = replaceRedisHashes.mock.calls[0] as [
      unknown,
      Array<{ key: string; fields: Record<string, string> }>,
    ];
    const r = replacements.find((x) => x.key === INTEL_TRANSFERS_KEY);
    expect(r).toBeDefined();
    expect(JSON.parse(r!.fields["0xbbb"])).toEqual(record);
  });

  it("passes intelWealth fields as JSON-encoded hash", async () => {
    const record = {
      address: "0xccc",
      fetchedAt: "2026-01-01",
      sources: [],
      balances: null,
      portfolio: null,
      version: 2,
    };
    await replaceSnapshotHashes({ intelWealth: { "0xccc": record as never } });

    const [, replacements] = replaceRedisHashes.mock.calls[0] as [
      unknown,
      Array<{ key: string; fields: Record<string, string> }>,
    ];
    const r = replacements.find((x) => x.key === INTEL_WEALTH_KEY);
    expect(r).toBeDefined();
    expect(JSON.parse(r!.fields["0xccc"])).toEqual(record);
  });

  it("passes intelEntities fields as JSON-encoded hash", async () => {
    const record = {
      slug: "binance",
      fetchedAt: "2026-01-01",
      name: "Binance",
    };
    await replaceSnapshotHashes({
      intelEntities: { binance: record as never },
    });

    const [, replacements] = replaceRedisHashes.mock.calls[0] as [
      unknown,
      Array<{ key: string; fields: Record<string, string> }>,
    ];
    const r = replacements.find((x) => x.key === INTEL_ENTITIES_KEY);
    expect(r).toBeDefined();
    expect(JSON.parse(r!.fields["binance"])).toEqual(record);
  });

  it("passes intelEntityCps fields as JSON-encoded hash", async () => {
    const record = {
      slug: "coinbase",
      fetchedAt: "2026-01-01",
      counterparties: null,
    };
    await replaceSnapshotHashes({
      intelEntityCps: { coinbase: record as never },
    });

    const [, replacements] = replaceRedisHashes.mock.calls[0] as [
      unknown,
      Array<{ key: string; fields: Record<string, string> }>,
    ];
    const r = replacements.find((x) => x.key === INTEL_ENTITY_CPS_KEY);
    expect(r).toBeDefined();
    expect(JSON.parse(r!.fields["coinbase"])).toEqual(record);
  });

  it("combines labels + reports + intel hash in a single call", async () => {
    const ADDR = "0x" + "a".repeat(40);
    const label = { name: "Test", tags: [], updatedAt: "2026-01-01T00:00:00Z" };
    const report = {
      body: "report",
      authorEmail: "a@b.com",
      source: "claude" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      version: 1 as const,
    };
    const deepRecord = { address: "0xaaa", fetchedAt: "2026-01-01" };

    await replaceSnapshotHashes({
      labels: { [ADDR]: label },
      reports: { [ADDR]: report },
      intelDeep: { "0xaaa": deepRecord as never },
    });

    expect(replaceRedisHashes).toHaveBeenCalledOnce();
    const [, replacements] = replaceRedisHashes.mock.calls[0] as [
      unknown,
      Array<{ key: string }>,
    ];
    const keys = replacements.map((r) => r.key);
    expect(keys).toContain(LABELS_KEY);
    expect(keys).toContain(REPORTS_KEY);
    expect(keys).toContain(INTEL_DEEP_KEY);
  });
});

describe("importSnapshotHashes — delegates to mergeRedisHashes", () => {
  it("calls mergeRedisHashes (not replaceRedisHashes)", async () => {
    const record = { address: "0xaaa", fetchedAt: "2026-01-01" };
    await importSnapshotHashes({ intelDeep: { "0xaaa": record as never } });
    expect(mergeRedisHashes).toHaveBeenCalledOnce();
    expect(replaceRedisHashes).not.toHaveBeenCalled();
  });
});
