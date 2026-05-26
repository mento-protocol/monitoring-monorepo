import { describe, expect, it, vi } from "vitest";
import { selectTier2Queue } from "./tier2-queue.mjs";

describe("selectTier2Queue", () => {
  it("does not let resumed intel_deep records consume the requested limit", async () => {
    const ranked = [
      { address: "0x0000000000000000000000000000000000000001" },
      { address: "0x0000000000000000000000000000000000000002" },
      { address: "0x0000000000000000000000000000000000000003" },
      { address: "0x0000000000000000000000000000000000000004" },
    ];
    const alreadyDeep = new Set([ranked[0].address, ranked[2].address]);
    const hasDeepRecord = vi.fn(async (address) => alreadyDeep.has(address));

    const result = await selectTier2Queue(ranked, 2, hasDeepRecord);

    expect(result.skipResume).toBe(2);
    expect(result.queue.map((candidate) => candidate.address)).toEqual([
      ranked[1].address,
      ranked[3].address,
    ]);
    expect(hasDeepRecord).toHaveBeenCalledTimes(4);
  });

  it("treats non-finite limits as zero instead of queueing every candidate", async () => {
    const ranked = [{ address: "0x0000000000000000000000000000000000000001" }];
    const hasDeepRecord = vi.fn(async () => false);

    const result = await selectTier2Queue(ranked, Number.NaN, hasDeepRecord);

    expect(result.queue).toEqual([]);
    expect(result.skipResume).toBe(0);
    expect(hasDeepRecord).not.toHaveBeenCalled();
  });
});
