import { describe, expect, it, vi } from "vitest";
import { isMainModule, samples, verifyLibSamples } from "./verify-libs.mjs";

function logger() {
  return {
    log: vi.fn(),
  };
}

describe("verifyLibSamples", () => {
  it("reports missing required samples", async () => {
    const redis = {
      hget: vi.fn().mockResolvedValue(null),
      hkeys: vi.fn().mockResolvedValue(["one"]),
    };
    const out = logger();

    const result = await verifyLibSamples(redis, out);

    expect(result.missing).toBe(samples.length);
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("succeeds when every required sample is present", async () => {
    const redis = {
      hget: vi.fn().mockResolvedValue({ ok: true }),
      hkeys: vi.fn().mockResolvedValue(["one"]),
    };

    const result = await verifyLibSamples(redis, logger());

    expect(result.missing).toBe(0);
  });

  it("does not treat an absent argv entry as the ESM main module", () => {
    expect(isMainModule("file:///tmp/verify-libs.mjs", ["node"])).toBe(false);
  });
});
