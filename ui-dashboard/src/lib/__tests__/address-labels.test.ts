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

import { getAllChainLabels } from "@/lib/address-labels";
import { Redis } from "@upstash/redis";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAllChainLabels — paginated SCAN", () => {
  it("returns labels from a single-page scan", async () => {
    (Redis.prototype.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "0",
      ["labels:42220"],
    ]);
    (Redis.prototype.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
      },
    );

    const result = await getAllChainLabels();
    expect(result).toHaveProperty("42220");
    expect(result["42220"]["0xabc"].label).toBe("Test");
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
        "0xaaa": { label: "Mainnet", updatedAt: "2026-01-01T00:00:00Z" },
      })
      .mockResolvedValueOnce({
        "0xbbb": { label: "Sepolia", updatedAt: "2026-01-01T00:00:00Z" },
      });

    const result = await getAllChainLabels();

    expect(Redis.prototype.scan).toHaveBeenCalledTimes(2);
    expect(result).toHaveProperty("42220");
    expect(result).toHaveProperty("11142220");
    expect(result["42220"]["0xaaa"].label).toBe("Mainnet");
    expect(result["11142220"]["0xbbb"].label).toBe("Sepolia");
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
