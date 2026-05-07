/**
 * Server-side tests for the report Redis client. Mocks `@upstash/redis` to
 * match real SDK behavior — particularly that `redis.eval`'s response is
 * auto-deserialized: a script that returns `cjson.encode(table)` arrives in
 * JS as an already-parsed object, NOT a string.
 *
 * Cursor flagged a regression on PR #330 / commit 31a1167 where
 * `JSON.parse(encoded)` was being called on that already-parsed object,
 * coercing to `"[object Object]"` and throwing on every save. This file
 * pins the contract so a future "fix" doesn't accidentally re-introduce
 * the parse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @upstash/redis to a controllable Redis client. The real SDK
// auto-deserializes JSON via parseResponse → parseRecursive (see
// node_modules/@upstash/redis/nodejs.js); reproducing that here is what
// makes the test catch the regression.
const mockEval = vi.fn();
const mockHget = vi.fn();
const mockHkeys = vi.fn();
const mockHdel = vi.fn();

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
      body: "x",
      authorEmail: "alice@mentolabs.xyz",
      source: "manual",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
      version: 1,
    });

    const { upsertReport } = await import("@/lib/address-reports");

    const saved = await upsertReport("global", ADDR, {
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
      body: "x",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:01.000Z",
      version: 7,
    });

    const { upsertReport } = await import("@/lib/address-reports");
    const saved = await upsertReport("global", ADDR, { body: "x" });
    expect(saved.version).toBe(7);
  });
});

describe("findReport — preferredScope filter (strict scope match)", () => {
  it("returns chain match when preferredScope matches", async () => {
    // ALL_REPORT_SCOPE_KEYS iterates in derivation order; mock per-key.
    mockHget.mockImplementation((key: string) => {
      if (key === "reports:42220") {
        return Promise.resolve({
          body: "celo",
          createdAt: "1",
          updatedAt: "1",
          version: 1,
        });
      }
      return Promise.resolve(null);
    });

    const { findReport } = await import("@/lib/address-reports");
    const found = await findReport(ADDR, 42220);
    expect(found).not.toBeNull();
    expect(found?.scope).toBe(42220);
    expect(found?.report.body).toBe("celo");
  });

  it("does NOT return a global report when a chain scope is requested (strict match)", async () => {
    // Strict-scope mode: a chain row must NOT see a global report. If the
    // user wants the global one, they should open the global row.
    mockHget.mockImplementation((key: string) => {
      if (key === "reports:global") {
        return Promise.resolve({
          body: "global",
          createdAt: "1",
          updatedAt: "1",
          version: 1,
        });
      }
      return Promise.resolve(null);
    });

    const { findReport } = await import("@/lib/address-reports");
    const found = await findReport(ADDR, 42220);
    expect(found).toBeNull();
  });

  it("does NOT return a chain-scoped report when a different chain is requested", async () => {
    mockHget.mockImplementation((key: string) => {
      if (key === "reports:42220") {
        return Promise.resolve({
          body: "celo only",
          createdAt: "1",
          updatedAt: "1",
          version: 1,
        });
      }
      return Promise.resolve(null);
    });

    const { findReport } = await import("@/lib/address-reports");
    // Request from Monad scope — should not see the Celo report.
    const found = await findReport(ADDR, 10143);
    expect(found).toBeNull();
  });

  it("global request only returns global match", async () => {
    mockHget.mockImplementation((key: string) => {
      if (key === "reports:42220") {
        return Promise.resolve({
          body: "celo",
          createdAt: "1",
          updatedAt: "1",
          version: 1,
        });
      }
      return Promise.resolve(null);
    });

    const { findReport } = await import("@/lib/address-reports");
    const found = await findReport(ADDR, "global");
    expect(found).toBeNull();
  });

  it("no preferredScope returns first match (back-compat)", async () => {
    mockHget.mockImplementation((key: string) => {
      if (key === "reports:42220") {
        return Promise.resolve({
          body: "celo",
          createdAt: "1",
          updatedAt: "1",
          version: 1,
        });
      }
      return Promise.resolve(null);
    });

    const { findReport } = await import("@/lib/address-reports");
    const found = await findReport(ADDR);
    expect(found?.scope).toBe(42220);
  });
});
