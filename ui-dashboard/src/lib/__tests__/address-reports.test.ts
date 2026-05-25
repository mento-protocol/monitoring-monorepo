/**
 * Server-side tests for the report Redis client. Mocks `@upstash/redis` to
 * match real SDK behavior — particularly that `redis.eval`'s response is
 * auto-deserialized: a script that returns `cjson.encode(table)` arrives in
 * JS as an already-parsed object, NOT a string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEval = vi.fn();
const mockHget = vi.fn();
const mockHkeys = vi.fn();
const mockHdel = vi.fn();
const mockHgetall = vi.fn();
const mockHset = vi.fn();

vi.mock("@upstash/redis", () => ({
  // Constructor mock — vitest-mock-quirks rule: must be a real `function`
  // declaration (not an arrow), otherwise `new Redis(...)` throws "is not
  // a constructor".
  Redis: function MockRedis() {
    return {
      eval: mockEval,
      hget: mockHget,
      hkeys: mockHkeys,
      hdel: mockHdel,
      hgetall: mockHgetall,
      hset: mockHset,
    };
  },
}));

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

const ADDR = "0xb64c8b0a3f8008d5028d8f9323b858f17b18c3c4";

describe("upsertReport — Upstash auto-deserialization contract", () => {
  it("uses redis.eval result directly (Upstash already parsed it; no JSON.parse)", async () => {
    // Real Upstash returns the cjson.encode'd payload as a parsed object.
    // If a future change re-introduces `JSON.parse(result)`, that becomes
    // `JSON.parse("[object Object]")` and throws SyntaxError.
    mockEval.mockResolvedValueOnce({
      ok: true,
      report: {
        body: "x",
        authorEmail: "alice@mentolabs.xyz",
        source: "manual",
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
        version: 1,
      },
    });

    const { upsertReport } = await import("@/lib/address-reports");

    const saved = await upsertReport(ADDR, {
      body: "x",
      authorEmail: "alice@mentolabs.xyz",
      source: "manual",
    });

    expect(saved).toEqual({
      body: "x",
      authorEmail: "alice@mentolabs.xyz",
      source: "manual",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
      version: 1,
    });
    expect(mockEval).toHaveBeenCalledOnce();
  });

  it("propagates the version stamped by the Lua script", async () => {
    mockEval.mockResolvedValueOnce({
      ok: true,
      report: {
        body: "x",
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:01.000Z",
        version: 7,
      },
    });

    const { upsertReport } = await import("@/lib/address-reports");
    const saved = await upsertReport(ADDR, { body: "x" });
    expect(saved.version).toBe(7);
  });

  it("targets the single `reports` Redis hash (no scope)", async () => {
    mockEval.mockResolvedValueOnce({
      ok: true,
      report: {
        body: "x",
        createdAt: "1",
        updatedAt: "1",
        version: 1,
      },
    });
    const { upsertReport } = await import("@/lib/address-reports");
    await upsertReport(ADDR, { body: "x" });
    const callArgs = mockEval.mock.calls[0]!;
    // KEYS arg is the second positional — should be ["reports"], no scope.
    expect(callArgs[1]).toEqual(["reports"]);
  });

  it("sends an empty base-version precondition for create-only writes", async () => {
    mockEval.mockResolvedValueOnce({
      ok: true,
      report: {
        body: "x",
        createdAt: "1",
        updatedAt: "1",
        version: 1,
      },
    });
    const { upsertReport } = await import("@/lib/address-reports");
    await upsertReport(ADDR, { body: "x" });
    const argv = mockEval.mock.calls[0]![2] as string[];
    expect(argv[3]).toBe("");
  });

  it("passes the expected base version into the atomic Lua script", async () => {
    mockEval.mockResolvedValueOnce({
      ok: true,
      report: {
        body: "x",
        createdAt: "1",
        updatedAt: "2",
        version: 4,
      },
    });
    const { upsertReport } = await import("@/lib/address-reports");
    await upsertReport(ADDR, { body: "x", baseVersion: 3 });
    const argv = mockEval.mock.calls[0]![2] as string[];
    expect(argv[3]).toBe("3");
  });

  it("throws a typed conflict when Redis reports an existing version mismatch", async () => {
    mockEval.mockResolvedValueOnce({
      ok: false,
      error: "version_conflict",
      existingVersion: 7,
    });

    const { upsertReport, AddressReportVersionConflictError } =
      await import("@/lib/address-reports");

    try {
      await upsertReport(ADDR, { body: "x", baseVersion: 6 });
      throw new Error("expected conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(AddressReportVersionConflictError);
      expect(err).toMatchObject({
        name: "AddressReportVersionConflictError",
        existingVersion: 7,
      });
    }
  });

  it("reports a null existing version when a supplied baseVersion targets a missing report", async () => {
    mockEval.mockResolvedValueOnce({
      ok: false,
      error: "version_conflict",
      existingVersion: null,
    });

    const { upsertReport } = await import("@/lib/address-reports");

    await expect(
      upsertReport(ADDR, { body: "x", baseVersion: 1 }),
    ).rejects.toMatchObject({
      existingVersion: null,
    });
  });
});

describe("deleteReport — optimistic concurrency", () => {
  it("passes the expected base version into the atomic Lua script", async () => {
    mockEval.mockResolvedValueOnce({ ok: true });

    const { deleteReport } = await import("@/lib/address-reports");
    await deleteReport(ADDR, 3);

    const callArgs = mockEval.mock.calls[0]!;
    expect(callArgs[1]).toEqual(["reports"]);
    expect(callArgs[2]).toEqual([ADDR.toLowerCase(), "3"]);
  });

  it("throws a typed conflict when Redis reports a stale delete", async () => {
    mockEval.mockResolvedValueOnce({
      ok: false,
      error: "version_conflict",
      existingVersion: 7,
    });

    const { deleteReport, AddressReportVersionConflictError } =
      await import("@/lib/address-reports");

    try {
      await deleteReport(ADDR, 6);
      throw new Error("expected conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(AddressReportVersionConflictError);
      expect(err).toMatchObject({ existingVersion: 7 });
    }
  });
});

describe("findReport — single-key lookup", () => {
  it("returns the report when it exists", async () => {
    mockHget.mockResolvedValueOnce({
      body: "yo",
      createdAt: "1",
      updatedAt: "1",
      version: 1,
    });

    const { findReport } = await import("@/lib/address-reports");
    const found = await findReport(ADDR);
    expect(found).not.toBeNull();
    expect(found?.body).toBe("yo");
    expect(mockHget).toHaveBeenCalledWith("reports", ADDR.toLowerCase());
  });

  it("returns null when no report exists", async () => {
    mockHget.mockResolvedValueOnce(null);
    const { findReport } = await import("@/lib/address-reports");
    const found = await findReport(ADDR);
    expect(found).toBeNull();
  });

  it("normalizes the address to lowercase for the lookup", async () => {
    mockHget.mockResolvedValueOnce(null);
    const { findReport } = await import("@/lib/address-reports");
    await findReport("0xB64C8B0A3F8008D5028D8F9323B858F17B18C3C4");
    expect(mockHget).toHaveBeenCalledWith(
      "reports",
      "0xb64c8b0a3f8008d5028d8f9323b858f17b18c3c4",
    );
  });
});

describe("getReportsIndex — addresses-only", () => {
  it("returns the lowercase address list with no metadata", async () => {
    mockHkeys.mockResolvedValueOnce(["0xaaa", "0xBBB"]);
    const { getReportsIndex } = await import("@/lib/address-reports");
    const idx = await getReportsIndex();
    expect(idx.addresses).toEqual(["0xaaa", "0xbbb"]);
  });

  it("hits HKEYS, never HGETALL — bandwidth guard for 50KB bodies", async () => {
    mockHkeys.mockResolvedValueOnce([]);
    const { getReportsIndex } = await import("@/lib/address-reports");
    await getReportsIndex();
    // Verify the bandwidth-cheap path is used — HKEYS returns field names
    // only. If a future change switches to HGETALL the 60s poll loop would
    // ship every 50KB body.
    expect(mockHkeys).toHaveBeenCalledWith("reports");
  });
});

describe("getAllReports — full hash for backup snapshots", () => {
  it("returns every report as an address → record map", async () => {
    mockHgetall.mockResolvedValueOnce({
      "0xaaa": {
        body: "Investigation A",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-02T00:00:00Z",
        version: 2,
      },
      "0xbbb": {
        body: "Investigation B",
        title: "Counterparty",
        source: "claude",
        createdAt: "2026-04-15T00:00:00Z",
        updatedAt: "2026-04-15T00:00:00Z",
        version: 1,
      },
    });

    const { getAllReports } = await import("@/lib/address-reports");
    const reports = await getAllReports();
    expect(Object.keys(reports)).toEqual(["0xaaa", "0xbbb"]);
    expect(reports["0xaaa"].body).toBe("Investigation A");
    expect(reports["0xbbb"].title).toBe("Counterparty");
    expect(reports["0xbbb"].source).toBe("claude");
    expect(mockHgetall).toHaveBeenCalledWith("reports");
  });

  it("returns an empty record (does NOT throw) when the hash is empty", async () => {
    // Restore parity acceptance: a fresh Upstash with zero reports must
    // produce an empty `reports: {}` in the snapshot, not a runtime error.
    mockHgetall.mockResolvedValueOnce(null);
    const { getAllReports } = await import("@/lib/address-reports");
    const reports = await getAllReports();
    expect(reports).toEqual({});
  });

  it("normalizes legacy/partial shapes via upgradeReports", async () => {
    // A row missing version / timestamps must default through upgradeReport
    // rather than land in the snapshot half-formed.
    mockHgetall.mockResolvedValueOnce({
      "0xccc": { body: "legacy" },
    });
    const { getAllReports } = await import("@/lib/address-reports");
    const reports = await getAllReports();
    expect(reports["0xccc"].body).toBe("legacy");
    expect(reports["0xccc"].version).toBe(1);
    expect(typeof reports["0xccc"].createdAt).toBe("string");
    expect(typeof reports["0xccc"].updatedAt).toBe("string");
  });
});

describe("importReports — restore-from-snapshot bulk write", () => {
  it("HSETs every record verbatim (preserves snapshot version/timestamps)", async () => {
    mockHset.mockResolvedValueOnce(2);
    const reports = {
      "0xaaa": {
        body: "A",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-02T00:00:00Z",
        version: 5,
      },
      "0xBBB": {
        body: "B",
        createdAt: "2026-04-15T00:00:00Z",
        updatedAt: "2026-04-15T00:00:00Z",
        version: 1,
      },
    };
    const { importReports } = await import("@/lib/address-reports");
    await importReports(reports);
    expect(mockHset).toHaveBeenCalledTimes(1);
    const [key, fields] = mockHset.mock.calls[0]!;
    expect(key).toBe("reports");
    // Keys lowercased; values are JSON-encoded so the on-disk shape matches
    // what the live upsert script writes.
    expect(Object.keys(fields)).toEqual(["0xaaa", "0xbbb"]);
    expect(JSON.parse((fields as Record<string, string>)["0xaaa"])).toEqual({
      body: "A",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
      version: 5,
    });
  });

  it("is a no-op for an empty input (does not call HSET)", async () => {
    const { importReports } = await import("@/lib/address-reports");
    await importReports({});
    expect(mockHset).not.toHaveBeenCalled();
  });
});
