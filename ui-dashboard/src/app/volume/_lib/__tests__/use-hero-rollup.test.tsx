/** @vitest-environment jsdom */

/* eslint-disable @typescript-eslint/no-explicit-any */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Orchestration tests for `useHeroRollup`.
 *
 * `mergeHeroSnapshot` is unit-tested in isolation; this file covers
 * the cross-query state machine the hook adds on top:
 *   1. primary snapshot + today queries resolve while the isolated
 *      firstDay + the gated yesterday queries are still unresolved →
 *      hero tiles render with the conservative (uncaught-up) totals
 *      and the chain stays in `degradedChains` so the page banner
 *      renders.
 *   2. firstDay + yesterday land → slice subtraction supplements the
 *      degraded chain, it drops from `degradedChains`, totals reflect
 *      the catch-up.
 *   3. firstDay / yesterday returns an error or empty result → tiles
 *      stay rendered (primary queries still resolved) and the chain
 *      remains in `degradedChains` so the banner stays up.
 *
 * Cursor flagged on PR #352 that helper-level `mergeHeroSnapshot`
 * tests miss this orchestration layer; this file plugs that gap.
 *
 * Pattern: jsdom + `react-dom/client` + `act` + a `Probe` component
 * that exposes the hook's return value via a ref. Same convention as
 * `lib/__tests__/use-table-sort.test.ts`. No `@testing-library/react`
 * (not in this repo).
 */

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BROKER_VOLUME_TODAY_TRADERS,
  BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST,
  BROKER_VOLUME_WINDOW_LATEST,
  VOLUME_PARTIAL_OVERLAP_TRADERS,
  VOLUME_TODAY_TRADERS,
  VOLUME_WINDOW_FIRSTDAY_LATEST,
  VOLUME_WINDOW_LATEST,
  VOLUME_YESTERDAY_TRADERS,
} from "@/lib/queries/volume";
import type {
  VolumeTodayTraderRow,
  VolumeRangeKey,
  VolumeWindowFirstDayRow,
  VolumeWindowRow,
} from "@/lib/volume";

// ---------------------------------------------------------------------------
// useGQL mock — programmable per-query response. Each test configures
// `gqlResponses` keyed by the query document, then any call with `null`
// (gated off) returns a stable "loading" shape.
// ---------------------------------------------------------------------------

type GQLResponse = {
  data: unknown;
  isLoading: boolean;
  error?: unknown;
};

const NULL_RESPONSE: GQLResponse = {
  data: undefined,
  isLoading: false,
  error: undefined,
};

let gqlResponses: Map<string, GQLResponse> = new Map();
let lastVariables: Map<string, Record<string, unknown> | undefined> = new Map();
let lastOptions: Map<string, Record<string, unknown> | undefined> = new Map();

vi.mock("@/lib/graphql", () => ({
  useGQL: (
    query: string | null,
    variables?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): GQLResponse => {
    if (query === null) return NULL_RESPONSE;
    lastVariables.set(query, variables);
    lastOptions.set(query, options);
    const configured = gqlResponses.get(query);
    if (configured) return configured;
    // Mirror SWR's fallbackData contract closely enough for gating tests:
    // fallback-seeded hooks report data with isLoading still true (SWR does
    // not count fallbackData as "loaded data" during first revalidation).
    const fallbackData = options?.fallbackData;
    if (fallbackData !== undefined)
      return { data: fallbackData, isLoading: true };
    return { data: undefined, isLoading: true };
  },
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    networkId: "celo-mainnet",
    network: { id: "celo-mainnet", chainId: 42220 },
  }),
}));

import { useHeroRollup } from "../use-hero-rollup";
import type { VolumeHeroInitialData } from "@/lib/volume-hero-initial-data";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 86400;
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const TODAY_MIDNIGHT =
  Math.floor(NOW_SECONDS / SECONDS_PER_DAY) * SECONDS_PER_DAY;
const TWO_DAYS_AGO_MIDNIGHT = TODAY_MIDNIGHT - 2 * SECONDS_PER_DAY;
const CELO = 42220;

function snapshot(
  overrides: Partial<VolumeWindowRow> & { chainId: number },
): VolumeWindowRow {
  return {
    id: `${overrides.chainId}-7d-${TWO_DAYS_AGO_MIDNIGHT}`,
    windowKey: "7d",
    snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
    windowStartDay: String(TWO_DAYS_AGO_MIDNIGHT - 5 * SECONDS_PER_DAY),
    totalVolumeUsdWei: "1000000000000000000000",
    totalVolumeUsdWeiIncludingProtocolActors: "1000000000000000000000",
    totalSwapCount: 50,
    totalSwapCountIncludingProtocolActors: 50,
    uniqueTraders: 10,
    uniqueTradersIncludingProtocolActors: 10,
    ...overrides,
  };
}

function firstDaySlice(
  overrides: Partial<VolumeWindowFirstDayRow> & { chainId: number },
): VolumeWindowFirstDayRow {
  return {
    snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
    firstDayVolumeUsdWei: "100000000000000000000",
    firstDayVolumeUsdWeiIncludingProtocolActors: "100000000000000000000",
    firstDaySwapCount: 5,
    firstDaySwapCountIncludingProtocolActors: 5,
    firstDayExclusiveUniqueTraders: 1,
    firstDayExclusiveUniqueTradersIncludingProtocolActors: 1,
    ...overrides,
  };
}

function yesterdayRow(
  trader: string,
  volumeUsdWei = "50000000000000000000",
): VolumeTodayTraderRow {
  return {
    chainId: CELO,
    trader,
    volumeUsdWei,
    swapCount: 1,
    isProtocolActor: false,
  };
}

// ---------------------------------------------------------------------------
// Probe — exposes the hook's return value via a ref so tests can assert on it
// ---------------------------------------------------------------------------

type HookResult = ReturnType<typeof useHeroRollup>;
const EMPTY_KPI_SOURCE: ReadonlyArray<{
  chainId: number;
  volumeUsdWei: bigint;
}> = [];

function Probe({
  resultRef,
  initialData,
  venue = "v3",
  range = "7d",
  kpiSource = EMPTY_KPI_SOURCE,
  kpiSourceRange,
}: {
  resultRef: { current: HookResult | null };
  initialData?: VolumeHeroInitialData | undefined;
  venue?: "v3" | "v2" | undefined;
  range?: VolumeRangeKey | undefined;
  kpiSource?: ReadonlyArray<{ chainId: number; volumeUsdWei: bigint }>;
  kpiSourceRange?: VolumeRangeKey | undefined;
}) {
  resultRef.current = useHeroRollup({
    venue,
    range,
    includeProtocolActors: false,
    isProtocolActorIn: [false],
    utcDayKey: 0,
    kpiSource,
    kpiSourceRange,
    kpiSourceIncludesProtocolActors:
      kpiSourceRange === undefined ? undefined : false,
    initialData,
  });
  return null;
}

// ---------------------------------------------------------------------------
// DOM scaffolding
// ---------------------------------------------------------------------------

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  gqlResponses = new Map();
  lastVariables = new Map();
  lastOptions = new Map();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(
  initialData?: VolumeHeroInitialData,
  options: {
    venue?: "v3" | "v2";
    range?: VolumeRangeKey;
    kpiSource?: ReadonlyArray<{ chainId: number; volumeUsdWei: bigint }>;
    kpiSourceRange?: VolumeRangeKey;
  } = {},
): { current: HookResult | null } {
  const ref: { current: HookResult | null } = { current: null };
  act(() => {
    root.render(
      <Probe resultRef={ref} initialData={initialData} {...options} />,
    );
  });
  return ref;
}

function rerender(
  ref: { current: HookResult | null },
  options: {
    venue?: "v3" | "v2";
    range?: VolumeRangeKey;
    kpiSource?: ReadonlyArray<{ chainId: number; volumeUsdWei: bigint }>;
    kpiSourceRange?: VolumeRangeKey;
  } = {},
) {
  act(() => {
    root.render(<Probe resultRef={ref} {...options} />);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useHeroRollup orchestration", () => {
  it("phase 1: primary snapshot + today resolved, firstDay + yesterday still loading → degraded banner stays up, tiles render", () => {
    // Snapshot is at T-2 → degraded state. Today's partial is empty
    // (no swap yet today, which is exactly when this matters).
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: { volumeWindowSnapshots: [snapshot({ chainId: CELO })] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_TODAY_TRADERS, {
      data: { volumeTodayTraders: [] },
      isLoading: false,
      error: undefined,
    });
    // firstDay + yesterday queries fire but haven't resolved.
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: undefined,
      isLoading: true,
      error: undefined,
    });
    gqlResponses.set(VOLUME_YESTERDAY_TRADERS, {
      data: undefined,
      isLoading: true,
      error: undefined,
    });

    const ref = render();
    const result = ref.current;
    expect(result).not.toBeNull();
    // Degraded chain detected. Banner driver populated.
    expect(result!.degradedChains).toEqual([CELO]);
    expect(result!.staleChains).toEqual([]);
    // Tiles render with the conservative (uncaught-up) totals — snapshot
    // contributes its full pre-subtraction volume since the firstDay
    // slice hasn't landed yet.
    expect(result!.totalVolume).toBeCloseTo(1000, 4);
    expect(result!.totalSwaps).toBe(50);
    expect(result!.totalTraders).toBe(10);
    // The yesterday-traders query was fired (gated on degradedChains).
    const yesterdayVars = lastVariables.get(VOLUME_YESTERDAY_TRADERS);
    expect(yesterdayVars?.chainIdIn).toEqual([CELO]);
  });

  it("phase 2: firstDay + yesterday resolve → chain caught up, drops from degradedChains, totals reflect the supplement", () => {
    // Same primary state as phase 1, but now firstDay + yesterday have
    // both landed. mergeHeroSnapshot should subtract the firstDay slice
    // and add yesterday's contribution.
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: { volumeWindowSnapshots: [snapshot({ chainId: CELO })] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_TODAY_TRADERS, {
      data: { volumeTodayTraders: [] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: {
        volumeWindowFirstDaySnapshots: [firstDaySlice({ chainId: CELO })],
      },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_YESTERDAY_TRADERS, {
      data: {
        volumeYesterdayTraders: [
          yesterdayRow("0xa", "75000000000000000000"),
          yesterdayRow("0xb", "25000000000000000000"),
        ],
      },
      isLoading: false,
      error: undefined,
    });

    const ref = render();
    const result = ref.current;
    expect(result).not.toBeNull();
    // Chain caught up — banner clears.
    expect(result!.degradedChains).toEqual([]);
    expect(result!.staleChains).toEqual([]);
    // Slice subtraction: snapshot 1000 - firstDay 100 + yesterday 100 = 1000.
    expect(result!.totalVolume).toBeCloseTo(1000, 4);
    // swaps: 50 - 5 + 2 = 47
    expect(result!.totalSwaps).toBe(47);
    // uniqueTraders: snapshot 10 - exclusive 1 + yesterday's 2 distinct = 11
    expect(result!.totalTraders).toBe(11);
    const overlapVars = lastVariables.get(VOLUME_PARTIAL_OVERLAP_TRADERS);
    expect(overlapVars?.limit).toBe(4);
    expect(
      lastOptions.get(VOLUME_YESTERDAY_TRADERS)?.keepPreviousData,
    ).toBeUndefined();
    expect(
      lastOptions.get(VOLUME_PARTIAL_OVERLAP_TRADERS)?.keepPreviousData,
    ).toBeUndefined();
  });

  it("keeps retained hero data rendered across a range-key change", () => {
    const yesterdayMidnight = TODAY_MIDNIGHT - SECONDS_PER_DAY;
    const priorSnapshot = snapshot({
      chainId: CELO,
      snapshotDay: String(yesterdayMidnight),
      windowStartDay: String(yesterdayMidnight - 5 * SECONDS_PER_DAY),
    });
    const primaryData = { volumeWindowSnapshots: [priorSnapshot] };
    const firstDayData = {
      volumeWindowFirstDaySnapshots: [firstDaySlice({ chainId: CELO })],
    };
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: primaryData,
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_TODAY_TRADERS, {
      data: { volumeTodayTraders: [] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: firstDayData,
      isLoading: false,
      error: undefined,
    });

    const ref = render(undefined, { range: "7d" });
    expect(ref.current?.isLoading).toBe(false);

    // Mirror SWR's key-transition state with keepPreviousData: the old
    // response remains present while the new key reports isLoading=true.
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: primaryData,
      isLoading: true,
      error: undefined,
    });
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: firstDayData,
      isLoading: true,
      error: undefined,
    });
    rerender(ref, { range: "30d" });

    expect(lastVariables.get(VOLUME_WINDOW_LATEST)?.windowKey).toBe("30d");
    expect(lastOptions.get(VOLUME_WINDOW_LATEST)?.keepPreviousData).toBe(true);
    expect(
      lastOptions.get(VOLUME_WINDOW_FIRSTDAY_LATEST)?.keepPreviousData,
    ).toBe(true);
    expect(
      lastOptions.get(VOLUME_TODAY_TRADERS)?.keepPreviousData,
    ).toBeUndefined();
    expect(ref.current?.isLoading).toBe(false);
    expect(ref.current?.totalVolume).toBeGreaterThan(0);
  });

  it("publishes only range-coherent hero slices and concentration inputs", () => {
    const yesterdayMidnight = TODAY_MIDNIGHT - SECONDS_PER_DAY;
    const priorPrimary = {
      volumeWindowSnapshots: [
        snapshot({
          chainId: CELO,
          windowKey: "7d",
          snapshotDay: String(yesterdayMidnight),
          windowStartDay: String(yesterdayMidnight - 6 * SECONDS_PER_DAY),
          totalVolumeUsdWei: "1000000000000000000000",
        }),
      ],
    };
    const priorFirstDay = {
      volumeWindowFirstDaySnapshots: [firstDaySlice({ chainId: CELO })],
    };
    const todayData = { volumeTodayTraders: [] };
    const priorKpi = [
      { chainId: CELO, volumeUsdWei: BigInt("500000000000000000000") },
    ];

    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: priorPrimary,
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: priorFirstDay,
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_TODAY_TRADERS, {
      data: todayData,
      isLoading: false,
      error: undefined,
    });

    const ref = render(undefined, {
      range: "7d",
      kpiSource: priorKpi,
      kpiSourceRange: "7d",
    });
    expect(ref.current?.displayRange).toBe("7d");
    expect(ref.current?.totalVolume).toBeCloseTo(1000, 4);
    expect(ref.current?.concentration).toBeCloseTo(50, 4);

    const nextPrimary = {
      volumeWindowSnapshots: [
        snapshot({
          chainId: CELO,
          windowKey: "30d",
          snapshotDay: String(yesterdayMidnight),
          windowStartDay: String(yesterdayMidnight - 29 * SECONDS_PER_DAY),
          totalVolumeUsdWei: "3000000000000000000000",
        }),
      ],
    };
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: nextPrimary,
      isLoading: false,
      error: undefined,
    });
    // The primary response won the race. SWR still exposes the prior
    // first-day slice and trader numerator for their replacement keys.
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: priorFirstDay,
      isLoading: true,
      error: undefined,
    });
    rerender(ref, {
      range: "30d",
      kpiSource: priorKpi,
      kpiSourceRange: "7d",
    });

    // Keep the prior complete snapshot; never combine the new denominator
    // with an old first-day subtraction or numerator.
    expect(ref.current?.displayRange).toBe("7d");
    expect(ref.current?.totalVolume).toBeCloseTo(1000, 4);
    expect(ref.current?.concentration).toBeCloseTo(50, 4);

    const nextFirstDay = {
      volumeWindowFirstDaySnapshots: [firstDaySlice({ chainId: CELO })],
    };
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: nextFirstDay,
      isLoading: false,
      error: undefined,
    });
    // Even after the hero pair is current, the old trader numerator keeps
    // the whole display on its previous coherent version.
    rerender(ref, {
      range: "30d",
      kpiSource: priorKpi,
      kpiSourceRange: "7d",
    });
    expect(ref.current?.displayRange).toBe("7d");
    expect(ref.current?.concentration).toBeCloseTo(50, 4);

    rerender(ref, {
      range: "30d",
      kpiSource: [
        { chainId: CELO, volumeUsdWei: BigInt("600000000000000000000") },
      ],
      kpiSourceRange: "30d",
    });
    expect(ref.current?.displayRange).toBe("30d");
    expect(ref.current?.totalVolume).toBeCloseTo(3000, 4);
    expect(ref.current?.concentration).toBeCloseTo(20, 4);
  });

  it("opts both v2 range-keyed hero queries into previous-data retention", () => {
    gqlResponses.set(BROKER_VOLUME_WINDOW_LATEST, {
      data: { brokerVolumeWindowSnapshots: [] },
      isLoading: true,
      error: undefined,
    });
    gqlResponses.set(BROKER_VOLUME_TODAY_TRADERS, {
      data: { brokerVolumeTodayTraders: [] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: { brokerVolumeWindowFirstDaySnapshots: [] },
      isLoading: true,
      error: undefined,
    });

    render(undefined, { venue: "v2", range: "90d" });

    expect(lastOptions.get(BROKER_VOLUME_WINDOW_LATEST)?.keepPreviousData).toBe(
      true,
    );
    expect(
      lastOptions.get(BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST)?.keepPreviousData,
    ).toBe(true);
    expect(
      lastOptions.get(BROKER_VOLUME_TODAY_TRADERS)?.keepPreviousData,
    ).toBeUndefined();
  });

  it("phase 3: firstDay query errors out → chain stays degraded, tiles stay rendered with conservative totals", () => {
    // firstDay query errored — `data` is undefined and `error` is set.
    // Since `firstDayRows` is undefined, mergeHeroSnapshot can't perform
    // slice subtraction; chain remains in degradedChains for the banner.
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: { volumeWindowSnapshots: [snapshot({ chainId: CELO })] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_TODAY_TRADERS, {
      data: { volumeTodayTraders: [] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: undefined,
      isLoading: false,
      error: new Error("hosted Hasura schema lag"),
    });
    // Yesterday landed authoritatively — empty for this chain.
    gqlResponses.set(VOLUME_YESTERDAY_TRADERS, {
      data: { volumeYesterdayTraders: [] },
      isLoading: false,
      error: undefined,
    });

    const ref = render();
    const result = ref.current;
    expect(result).not.toBeNull();
    // Banner stays up — the catch-up could not complete.
    expect(result!.degradedChains).toEqual([CELO]);
    // Primary snapshot's totals still drive the tiles (graceful degradation:
    // only the catch-up degrades, not the hero).
    expect(result!.totalVolume).toBeCloseTo(1000, 4);
    expect(result!.totalSwaps).toBe(50);
    expect(result!.totalTraders).toBe(10);
    // hasError is driven by the PRIMARY queries (snapshot + today). The
    // firstDay error degrades JUST the catch-up — that's the design.
    expect(result!.hasError).toBe(false);
  });

  it("attaches SSR fallbackData to the hero trio when the prefetched view matches", () => {
    const initialData: VolumeHeroInitialData = {
      view: {
        networkId: "celo-mainnet",
        venue: "v3",
        range: "7d",
        includeProtocolActors: false,
        todayMidnight: TODAY_MIDNIGHT,
      },
      heroV3: { volumeWindowSnapshots: [snapshot({ chainId: CELO })] },
      todayV3: { volumeTodayTraders: [] },
      firstDayV3: {
        volumeWindowFirstDaySnapshots: [firstDaySlice({ chainId: CELO })],
      },
    };

    const ref = render(initialData);

    expect(lastOptions.get(VOLUME_WINDOW_LATEST)?.fallbackData).toBe(
      initialData.heroV3,
    );
    expect(lastOptions.get(VOLUME_TODAY_TRADERS)?.fallbackData).toBe(
      initialData.todayV3,
    );
    expect(lastOptions.get(VOLUME_WINDOW_FIRSTDAY_LATEST)?.fallbackData).toBe(
      initialData.firstDayV3,
    );
    // With the fallback seeded (SWR reports data present but isLoading true
    // during the first revalidation), the hook's data-presence loading gate
    // lets the tiles render populated numbers immediately.
    expect(ref.current!.isLoading).toBe(false);
    expect(ref.current!.totalVolume).toBeCloseTo(1000, 4);
  });

  it("drops the SSR fallback when the prefetched view descriptor mismatches", () => {
    const initialData: VolumeHeroInitialData = {
      view: {
        networkId: "celo-mainnet",
        venue: "v3",
        range: "30d", // Probe renders range "7d" — must not seed 30d data
        includeProtocolActors: false,
        todayMidnight: TODAY_MIDNIGHT,
      },
      heroV3: { volumeWindowSnapshots: [snapshot({ chainId: CELO })] },
      todayV3: { volumeTodayTraders: [] },
    };

    const ref = render(initialData);

    expect(lastOptions.get(VOLUME_WINDOW_LATEST)?.fallbackData).toBeUndefined();
    expect(lastOptions.get(VOLUME_TODAY_TRADERS)?.fallbackData).toBeUndefined();
    expect(
      lastOptions.get(VOLUME_WINDOW_FIRSTDAY_LATEST)?.fallbackData,
    ).toBeUndefined();
    expect(ref.current!.isLoading).toBe(true);
  });

  it("drops the SSR fallback across the UTC-midnight edge (server day N, client day N+1)", () => {
    const initialData: VolumeHeroInitialData = {
      view: {
        networkId: "celo-mainnet",
        venue: "v3",
        range: "7d",
        includeProtocolActors: false,
        todayMidnight: TODAY_MIDNIGHT - SECONDS_PER_DAY,
      },
      heroV3: { volumeWindowSnapshots: [snapshot({ chainId: CELO })] },
      todayV3: { volumeTodayTraders: [] },
    };

    render(initialData);

    expect(lastOptions.get(VOLUME_WINDOW_LATEST)?.fallbackData).toBeUndefined();
    expect(lastOptions.get(VOLUME_TODAY_TRADERS)?.fallbackData).toBeUndefined();
  });

  it("does NOT fire the yesterday query when no chain is degraded", () => {
    // Snapshot at T-1 (yesterday) → fresh, not degraded.
    const yesterdayMidnight = TODAY_MIDNIGHT - SECONDS_PER_DAY;
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: {
        volumeWindowSnapshots: [
          snapshot({
            chainId: CELO,
            snapshotDay: String(yesterdayMidnight),
            windowStartDay: String(yesterdayMidnight - 5 * SECONDS_PER_DAY),
          }),
        ],
      },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_TODAY_TRADERS, {
      data: { volumeTodayTraders: [] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_WINDOW_FIRSTDAY_LATEST, {
      data: {
        volumeWindowFirstDaySnapshots: [firstDaySlice({ chainId: CELO })],
      },
      isLoading: false,
      error: undefined,
    });

    const ref = render();
    expect(ref.current!.degradedChains).toEqual([]);
    // Yesterday query should not have been called — no entry in lastVariables
    // for that document means useGQL was passed `null`.
    expect(lastVariables.has(VOLUME_YESTERDAY_TRADERS)).toBe(false);
  });
});
