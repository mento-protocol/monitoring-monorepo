import { describe, expect, it } from "vitest";
import { buildDescription } from "../page";

const baseData: Parameters<typeof buildDescription>[0] = {
  chains: ["Celo", "Monad"],
  offlineChains: [],
  partial: false,
  totalTvlUsd: 1_000_000,
  tvlWoWPct: null,
  totalVolume7dUsd: 250_000,
  volume7dWoWPct: null,
  volumeSeries: [],
  tvlSeries: [],
  poolCount: 12,
  chainCount: 2,
  healthBuckets: {
    OK: 12,
    WARN: 0,
    CRITICAL: 0,
    WEEKEND: 0,
    HALTED: 0,
    "N/A": 0,
  },
  attentionPools: [],
};

describe("homepage metadata description", () => {
  it("uses a generic partial-data phrase when no chain is offline", () => {
    const description = buildDescription({
      ...baseData,
      partial: true,
      offlineChains: [],
    });

    expect(description).toContain("Partial data");
    expect(description).not.toContain("Partial —  offline");
  });

  it("names offline chains when partial data is caused by chain outage", () => {
    const description = buildDescription({
      ...baseData,
      partial: true,
      offlineChains: ["Monad"],
    });

    expect(description).toContain("Partial — Monad offline");
  });
});
