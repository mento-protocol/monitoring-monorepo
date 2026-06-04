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
  LEGACY_VOLUME_WINDOW_LATEST,
  VOLUME_PARTIAL_OVERLAP_TRADERS,
  VOLUME_TODAY_TRADERS,
  VOLUME_WINDOW_FIRSTDAY_LATEST,
  VOLUME_WINDOW_LATEST,
  VOLUME_YESTERDAY_TRADERS,
} from "@/lib/queries/volume";
import type {
  VolumeTodayTraderRow,
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

vi.mock("@/lib/graphql", () => ({
  useGQL: (
    query: string | null,
    variables?: Record<string, unknown>,
  ): GQLResponse => {
    if (query === null) return NULL_RESPONSE;
    lastVariables.set(query, variables);
    return gqlResponses.get(query) ?? { data: undefined, isLoading: true };
  },
}));

import { useHeroRollup } from "../use-hero-rollup";

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
    totalVolumeUsdWeiIncludingSystem: "1000000000000000000000",
    totalSwapCount: 50,
    totalSwapCountIncludingSystem: 50,
    uniqueTraders: 10,
    uniqueTradersIncludingSystem: 10,
    ...overrides,
  };
}

function firstDaySlice(
  overrides: Partial<VolumeWindowFirstDayRow> & { chainId: number },
): VolumeWindowFirstDayRow {
  return {
    snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
    firstDayVolumeUsdWei: "100000000000000000000",
    firstDayVolumeUsdWeiIncludingSystem: "100000000000000000000",
    firstDaySwapCount: 5,
    firstDaySwapCountIncludingSystem: 5,
    firstDayExclusiveUniqueTraders: 1,
    firstDayExclusiveUniqueTradersIncludingSystem: 1,
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
    isSystemAddress: false,
  };
}

// ---------------------------------------------------------------------------
// Probe — exposes the hook's return value via a ref so tests can assert on it
// ---------------------------------------------------------------------------

type HookResult = ReturnType<typeof useHeroRollup>;

function Probe({ resultRef }: { resultRef: { current: HookResult | null } }) {
  resultRef.current = useHeroRollup({
    venue: "v3",
    range: "7d",
    showSystem: false,
    isSystemAddressIn: [false],
    utcDayKey: 0,
    kpiSource: [],
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

function render(): { current: HookResult | null } {
  const ref: { current: HookResult | null } = { current: null };
  act(() => {
    root.render(<Probe resultRef={ref} />);
  });
  return ref;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useHeroRollup orchestration", () => {
  it("falls back to the previous snapshot entity name when the renamed hero query errors", () => {
    gqlResponses.set(VOLUME_WINDOW_LATEST, {
      data: undefined,
      isLoading: false,
      error: new Error("field VolumeWindowSnapshot not found"),
    });
    gqlResponses.set(LEGACY_VOLUME_WINDOW_LATEST, {
      data: { volumeWindowSnapshots: [snapshot({ chainId: CELO })] },
      isLoading: false,
      error: undefined,
    });
    gqlResponses.set(VOLUME_TODAY_TRADERS, {
      data: { volumeTodayTraders: [] },
      isLoading: false,
      error: undefined,
    });

    const ref = render();
    const result = ref.current;
    expect(result).not.toBeNull();
    expect(lastVariables.has(LEGACY_VOLUME_WINDOW_LATEST)).toBe(true);
    expect(result!.hasError).toBe(false);
    expect(result!.totalVolume).toBeCloseTo(1000, 4);
  });

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
