import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturedCacheKeyParts, capturedCacheOptions } = vi.hoisted(() => {
  // The cache key is built when `peg-og-data` is evaluated, so the bridge URL
  // has to be in place before the import below. `vi.stubEnv` in a hook runs
  // after that and would only ever see the key already frozen.
  process.env.METRICS_BRIDGE_URL = "https://metrics-bridge.example";
  return {
    capturedCacheKeyParts: [] as string[][],
    capturedCacheOptions: [] as unknown[],
  };
});

// Identity wrapper: the tests drive the fetch themselves, and recording the
// key parts and options makes the deploy/config salting a tested contract.
vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(
    fn: T,
    keyParts?: string[],
    options?: unknown,
  ) => {
    if (keyParts) capturedCacheKeyParts.push(keyParts);
    capturedCacheOptions.push(options);
    return fn;
  },
}));

import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
import type { PegMonitoringResponse } from "@/lib/peg-monitoring-schema";
import {
  buildPegMonitoringOgData,
  fetchPegMonitoringForMetadata,
  fetchPegMonitoringOgDataUncached,
  PEG_OG_MAX_ROWS,
} from "../_lib/peg-og-data";

const BRIDGE_ORIGIN = "https://metrics-bridge.example";

/** The fixture's `producedAt`, rendered a few seconds later. */
function freshNow(data: PegMonitoringResponse): number {
  return data.producedAt * 1_000 + 12_000;
}

/** Pair label the board derives for the clone at `index`. */
function pegPair(index: number): string {
  return `PEG${index} / EUR`;
}

/**
 * Clone the fixture's single package `count` times under distinct pair names.
 * The clone at `criticalIndex` deviates past its critical threshold; every
 * other clone sits well inside its warning band, so the board carries a real
 * tone order for the sort to act on.
 *
 * Healthy deviations grow with the index, so distance order runs opposite to
 * pair order. `presentPegMonitoring` already returns assets sorted by severity
 * then distance; only `sortBoardRows`' alphabetical tie-break produces pair
 * order, so the two orderings stay distinguishable.
 */
function withPegs(count: number, criticalIndex: number): PegMonitoringResponse {
  const base = makePegMonitoringResponse();
  const template = base.packages[0]!;
  return {
    ...base,
    packages: Array.from({ length: count }, (_, index) => {
      // Policy warns at 25 bps and pages at 50.
      const deviationBps = index === criticalIndex ? 80 : 5 + index * 3;
      return {
        ...template,
        asset: `${template.asset}-${index}`,
        sources: template.sources.map((source) => ({
          ...source,
          // The pair label reads the source's base currency, so this is what
          // the sort's alphabetical tie-break compares.
          baseCurrency: `PEG${index}`,
          executablePrice: 1 - deviationBps / 10_000,
          deviationBps,
          premiumBps: 0,
        })),
      };
    }),
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
    const data = withPegs(PEG_OG_MAX_ROWS + 2, PEG_OG_MAX_ROWS + 1);
    const og = buildPegMonitoringOgData(data, freshNow(data));

    expect(og.rows).toHaveLength(PEG_OG_MAX_ROWS);
    expect(og.omittedCount).toBe(2);
  });

  it("draws the rows in board order, so the critical peg survives the cap", () => {
    // The critical peg is last in the payload, so it reaches the card only if
    // the rows are ordered before the cap is applied. Drop `sortBoardRows` and
    // the healthy pegs arrive in distance order instead of pair order.
    const criticalIndex = PEG_OG_MAX_ROWS + 1;
    const data = withPegs(PEG_OG_MAX_ROWS + 2, criticalIndex);
    const og = buildPegMonitoringOgData(data, freshNow(data));

    expect(og.rows[0]!.pair).toBe(pegPair(criticalIndex));
    expect(og.rows[0]!.tone).toBe("critical");
    // Worst first, then the healthy pegs in pair order. The two omitted pegs
    // are the healthy tail, never the breached one.
    expect(og.rows.map((row) => row.pair)).toEqual([
      pegPair(criticalIndex),
      pegPair(0),
      pegPair(1),
      pegPair(2),
    ]);
    expect(og.rows.slice(1).map((row) => row.tone)).toEqual([
      "healthy",
      "healthy",
      "healthy",
    ]);
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

describe("peg monitoring OG cache", () => {
  it("salts the key with the deploy marker and the resolved bridge origin", () => {
    // Without the origin part, repointing the bridge on a deploy that shares
    // the "dev" salt would keep serving the previous origin's packages.
    expect(capturedCacheKeyParts).toEqual([
      [
        "peg-monitoring-og",
        process.env.VERCEL_DEPLOYMENT_ID ??
          process.env.VERCEL_GIT_COMMIT_SHA ??
          "dev",
        BRIDGE_ORIGIN,
      ],
    ]);
  });

  it("holds the package for 60s under a purgeable tag", () => {
    expect(capturedCacheOptions).toEqual([
      { revalidate: 60, tags: ["peg-monitoring-og"] },
    ]);
  });
});

describe("fetchPegMonitoringForMetadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("METRICS_BRIDGE_URL", BRIDGE_ORIGIN);
  });

  it("returns the board data through the path the route calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makePegMonitoringResponse()), {
        headers: { "content-type": "application/json" },
      }),
    );

    const og = await fetchPegMonitoringForMetadata();

    // Rendered against the real clock, so assert the shape rather than the
    // verdict — `buildPegMonitoringOgData` owns the verdict wording above.
    expect(og?.rows).toHaveLength(1);
    expect(og?.rows[0]!.pair).toContain("/");
  });

  it("returns null when the bridge fails, so the card cannot assert a state", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));

    expect(await fetchPegMonitoringForMetadata()).toBeNull();
  });
});
