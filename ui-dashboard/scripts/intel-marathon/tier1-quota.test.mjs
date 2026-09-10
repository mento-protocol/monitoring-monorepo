import { describe, expect, it, vi } from "vitest";
import { createQuota } from "./tier1-quota.mjs";
const quiet = { log: vi.fn(), warn: vi.fn() };
describe("tier1 quota", () => {
  it("prefers Remaining headers permanently while Usage-only leaves body fallback live", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ totalCount: 10, totalLimit: 100 }))
      .mockResolvedValueOnce(Response.json({ totalCount: 20, totalLimit: 100 }))
      .mockResolvedValueOnce(
        Response.json({ totalCount: 99, totalLimit: 100 }),
      );
    const api = createQuota({ fetch, console: quiet });
    await api.logIntelUsage("start");
    expect(api.quota.remaining).toBe(90);
    api.noteQuotaHeaders(
      new Response(null, { headers: { "X-Intel-Datapoints-Usage": "15" } }),
    );
    await api.logIntelUsage("poll");
    expect(api.quota.remaining).toBe(80);
    expect(
      api.noteQuotaHeaders(
        new Response(null, {
          headers: { "X-Intel-Datapoints-Remaining": "70" },
        }),
      ),
    ).toBe(true);
    await api.logIntelUsage("end");
    expect(api.quota.remaining).toBe(70);
    expect(api.quotaLine()).toContain("via=headers");
  });
  it("rejects empty and nonfinite headers and unknown bodies", () => {
    const api = createQuota();
    expect(
      api.noteQuotaHeaders(
        new Response(null, {
          headers: {
            "X-Intel-Datapoints-Remaining": "  ",
            "X-Intel-Datapoints-Limit": "Infinity",
          },
        }),
      ),
    ).toBe(false);
    expect(api.quota.remaining).toBeNull();
    expect(api.remainingFromUsageBody({ remainingDatapoints: 15 })).toBe(15);
    expect(
      api.remainingFromUsageBody({ totalCount: "5", totalLimit: 100 }),
    ).toBeNull();
    expect(api.remainingFromUsageBody(null)).toBeNull();
  });
  it("preserves unknown quota on failed usage polls", async () => {
    const api = createQuota({
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
      console: quiet,
    });
    await api.logIntelUsage("start");
    expect(api.quota.remaining).toBeNull();
    expect(api.quotaLine()).toBe("quota not yet observed");
  });
  it.each([
    [401, "ARKHAM_AUTH_FAIL"],
    [402, "ARKHAM_ENTITLEMENT"],
    [403, "ARKHAM_ENTITLEMENT"],
    [429, "ARKHAM_RATE_LIMITED"],
    [500, "arkham_http_500"],
  ])("classifies HTTP %i", async (status, message) => {
    const api = createQuota({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status })),
    });
    await expect(api.fetchEnriched("address")).rejects.toThrow(message);
  });
});
