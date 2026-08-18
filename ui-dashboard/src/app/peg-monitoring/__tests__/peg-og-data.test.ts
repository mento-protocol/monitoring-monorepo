import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
import type { PegMonitoringResponse } from "@/lib/peg-monitoring-schema";
import {
  buildPegMonitoringOgData,
  fetchPegMonitoringOgDataUncached,
  PEG_OG_MAX_ROWS,
} from "../_lib/peg-og-data";

/** The fixture's `producedAt`, rendered a few seconds later. */
function freshNow(data: PegMonitoringResponse): number {
  return data.producedAt * 1_000 + 12_000;
}

/**
 * Clone the fixture's single package under a new asset name so multi-peg
 * layouts can be exercised without a second fixture builder.
 */
function withPegs(count: number): PegMonitoringResponse {
  const base = makePegMonitoringResponse();
  const template = base.packages[0]!;
  return {
    ...base,
    packages: Array.from({ length: count }, (_, index) => ({
      ...template,
      asset: index === 0 ? template.asset : `${template.asset}-${index}`,
    })),
  };
}

describe("buildPegMonitoringOgData", () => {
  it("carries the board's own verdict wording and a row per peg", () => {
    const data = makePegMonitoringResponse();
    const og = buildPegMonitoringOgData(data, freshNow(data));

    // The fixture peg sits past its warning threshold, so the card must say
    // so rather than rounding the board's verdict up to healthy.
    expect(og.summary).toBe("0 of 1 peg healthy · 1 warning");
    expect(og.tone).toBe("warning");
    expect(og.stale).toBe(false);
    expect(og.rows).toHaveLength(1);
    expect(og.omittedCount).toBe(0);
    const row = og.rows[0]!;
    expect(row.pair).toContain("/");
    expect(row.status).toBe("Warning");
    expect(row.tone).toBe("warning");
    expect(row.marker).not.toBeNull();
    // The marker sits on the ±60 bps rail, with the target at 50%.
    expect(row.marker!.percent).toBeGreaterThan(0);
    expect(row.marker!.percent).toBeLessThan(100);
  });

  it("caps the rows it draws and counts the rest", () => {
    const data = withPegs(PEG_OG_MAX_ROWS + 2);
    const og = buildPegMonitoringOgData(data, freshNow(data));

    expect(og.rows).toHaveLength(PEG_OG_MAX_ROWS);
    expect(og.omittedCount).toBe(2);
  });

  it("reports staleness rather than presenting an old package as current", () => {
    const data = makePegMonitoringResponse();
    const og = buildPegMonitoringOgData(
      data,
      data.producedAt * 1_000 + 600_000,
    );

    expect(og.stale).toBe(true);
    expect(og.tone).toBe("uncertain");
    // A stale package must never render as a green "all healthy" card. The
    // pill carries the counts and the footer carries the qualifier, so the
    // verdict survives even though the two live in different fields.
    expect(og.summary).toBe("0 of 1 peg healthy · 1 unconfirmed");
    expect(og.qualifier).toBe("latest data is stale");
    expect(og.age).toBe("10m");
  });

  it("carries each peg's own thresholds so the rail is not labelled from EUROP's", () => {
    const base = makePegMonitoringResponse();
    const item = base.packages[0]!;
    const data: PegMonitoringResponse = {
      ...base,
      packages: [
        {
          ...item,
          policy: {
            ...item.policy,
            warnDeviationBps: 40,
            criticalDeviationBps: 85,
            premiumWarnBps: 30,
          },
        },
      ],
    };
    const og = buildPegMonitoringOgData(data, freshNow(data));

    expect(og.rows[0]!.thresholds).toEqual({
      downsideWarn: 40,
      downsideCritical: 85,
      premiumWarn: 30,
    });
  });

  it("marks a peg unconfirmed when its decision source is unusable", () => {
    const base = makePegMonitoringResponse();
    const item = base.packages[0]!;
    const data: PegMonitoringResponse = {
      ...base,
      packages: [
        {
          ...item,
          sources: item.sources.map((source) => ({
            ...source,
            executablePrice: null,
            deviationBps: null,
            premiumBps: null,
            healthy: false,
            venueState: "halted" as const,
          })),
        },
      ],
    };
    const og = buildPegMonitoringOgData(data, freshNow(data));

    expect(og.tone).not.toBe("healthy");
    expect(og.rows[0]!.status).toBe("Unconfirmed");
    expect(og.rows[0]!.price).toBe("—");
    expect(og.rows[0]!.distance).toBe("Price unavailable");
    // No price means no defensible position on the rail.
    expect(og.rows[0]!.marker).toBeNull();
  });
});

describe("fetchPegMonitoringOgDataUncached", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("METRICS_BRIDGE_URL", "https://metrics-bridge.example");
  });

  it("returns the board data when the bridge answers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makePegMonitoringResponse()), {
        headers: { "content-type": "application/json" },
      }),
    );

    const og = await fetchPegMonitoringOgDataUncached();

    expect(og?.rows).toHaveLength(1);
  });

  it("returns null rather than a card asserting a state it cannot confirm", async () => {
    // Unreachable bridge, and an unconfigured one. Both must reach the card
    // as `null` so it renders "Status unavailable" instead of inventing a
    // verdict — a green card over a dead upstream is the damaging failure.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    expect(await fetchPegMonitoringOgDataUncached()).toBeNull();

    vi.stubEnv("METRICS_BRIDGE_URL", "");
    expect(await fetchPegMonitoringOgDataUncached()).toBeNull();
  });
});
