import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { VolumeHeroInitialData } from "@/lib/volume-hero-initial-data";
import {
  AGGREGATOR_DAILY_TOP,
  BROKER_AGGREGATOR_DAILY_TOP,
  BROKER_AGGREGATOR_DAILY_TOP_INCLUDING_PROTOCOL_ACTORS,
  BROKER_TRADER_DAILY_TOP,
  POOLS_FOR_VOLUME,
  TRADER_DAILY_TOP,
} from "@/lib/queries/volume";

const mockUseGQL = vi.hoisted(() => vi.fn());
const volumeState = vi.hoisted(() => ({
  venue: "v3" as "v3" | "v2",
  includeProtocolActors: false,
  range: "7d" as "24h" | "7d" | "30d" | "90d" | "all",
}));
const poolVolumeState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as Error | null,
  partial: false,
  dataAfterTimestamp: undefined as number | undefined,
  dataRange: undefined as typeof volumeState.range | undefined,
  hasData: false,
}));
const mockTimeSeriesChartCard = vi.hoisted(() => vi.fn());
const mockV2VolumeSection = vi.hoisted(() => vi.fn());
const mockV3VolumeSection = vi.hoisted(() => vi.fn());
const mockUsePoolChartViewModel = vi.hoisted(() => vi.fn());

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("../_lib/use-resolved-query-identity", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../_lib/use-resolved-query-identity")
    >();
  return {
    ...actual,
    // Static-markup wiring tests have no persistent component instance. The
    // real range/filter transition state machine is covered in the hook's
    // jsdom orchestration tests; here we model already-versioned current-key
    // data so the page-level loading/error plumbing stays focused.
    useVersionedVolumeQueryData: (
      result: { data: unknown; error: unknown; isLoading: boolean },
      currentIdentity: string,
    ) => ({
      data: result.data,
      dataIdentity: result.data === undefined ? undefined : currentIdentity,
      isLoading: result.isLoading && result.data === undefined,
      hasError: result.error != null && result.data === undefined,
    }),
  };
});

vi.mock("../_lib/url-state", () => ({
  useVolumeUrlState: ({
    canUseVolumeFilters,
  }: {
    canUseVolumeFilters: boolean;
  }) => {
    const includeProtocolActors = canUseVolumeFilters
      ? volumeState.includeProtocolActors
      : true;
    return {
      canUseVolumeFilters,
      range: volumeState.range,
      actorFilter: includeProtocolActors ? "all" : "organic",
      includeProtocolActors,
      venue: volumeState.venue,
      cutoff: 1_700_000_000,
      utcDayKey: 20_000,
      updateRange: vi.fn(),
      updateIncludeProtocolActors: vi.fn(),
      updateVenue: vi.fn(),
    };
  },
}));

vi.mock("../_lib/use-pool-volume-snapshots", () => ({
  usePoolVolumeSnapshots: () => poolVolumeState,
}));

vi.mock("../_lib/pool-chart-vm", () => ({
  usePoolChartViewModel: (args: unknown) => {
    mockUsePoolChartViewModel(args);
    return {
      poolVolumeBreakdown: {
        totalSeries: [],
        breakdown: [],
        windowTotalUsdWei: BigInt(0),
      },
      chartBreakdown: [],
      topPoolsListEntries: [],
    };
  },
}));

const mockUseHeroRollup = vi.hoisted(() => vi.fn());
const heroState = vi.hoisted(() => ({ isLoading: false, hasError: false }));

vi.mock("../_lib/use-hero-rollup", () => ({
  useHeroRollup: (args: unknown) => {
    mockUseHeroRollup(args);
    return {
      isLoading: heroState.isLoading,
      hasError: heroState.hasError,
      totalVolume: 0,
      totalTraders: 0,
      totalSwaps: 0,
      concentration: 0,
      staleChains: [],
      degradedChains: [],
      displayRange: volumeState.range,
    };
  },
}));

vi.mock("@/components/time-series-chart-card", () => ({
  TimeSeriesChartCard: (props: { title: string }) => {
    mockTimeSeriesChartCard(props);
    return <div data-testid="chart">{props.title}</div>;
  },
}));

vi.mock("../_components/hero-data-quality-banners", () => ({
  HeroDataQualityBanners: () => <div data-testid="hero-banners" />,
}));

vi.mock("../_components/top-pools-list", () => ({
  TopPoolsList: () => <div data-testid="top-pools" />,
}));

vi.mock("../_components/v2-volume-section", () => ({
  V2VolumeSection: (props: unknown) => {
    mockV2VolumeSection(props);
    return <div data-testid="v2-section" />;
  },
}));

vi.mock("../_components/v3-volume-section", () => ({
  V3VolumeSection: (props: unknown) => {
    mockV3VolumeSection(props);
    return <div data-testid="v3-section" />;
  },
}));

import { VolumeClient } from "../page-client";

function renderVolume(
  venue: "v3" | "v2",
  includeProtocolActors = false,
  canUseVolumeFilters = true,
) {
  volumeState.venue = venue;
  volumeState.includeProtocolActors = includeProtocolActors;
  return renderToStaticMarkup(
    <VolumeClient canUseVolumeFilters={canUseVolumeFilters} />,
  );
}

function optionsFor(query: string) {
  const call = mockUseGQL.mock.calls.find(([document]) => document === query);
  expect(call, `missing useGQL call for ${query}`).toBeDefined();
  return call ? call[call.length - 1] : undefined;
}

function variablesFor(query: string) {
  const call = mockUseGQL.mock.calls.find(([document]) => document === query);
  expect(call, `missing useGQL call for ${query}`).toBeDefined();
  return call ? call[1] : undefined;
}

describe("VolumeClient useGQL wiring", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
    mockUseHeroRollup.mockClear();
    mockTimeSeriesChartCard.mockClear();
    mockV2VolumeSection.mockClear();
    mockV3VolumeSection.mockClear();
    mockUsePoolChartViewModel.mockClear();
    heroState.isLoading = false;
    heroState.hasError = false;
    volumeState.range = "7d";
    poolVolumeState.rows = [];
    poolVolumeState.isLoading = false;
    poolVolumeState.error = null;
    poolVolumeState.partial = false;
    poolVolumeState.dataAfterTimestamp = undefined;
    poolVolumeState.dataRange = undefined;
    poolVolumeState.hasData = false;
    mockUseGQL.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });
  });

  it("uses 8s timeouts for v3 volume polling queries", () => {
    renderVolume("v3");

    expect(optionsFor(TRADER_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
      keepPreviousData: true,
    });
    expect(optionsFor(AGGREGATOR_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
      keepPreviousData: true,
    });
    expect(optionsFor(POOLS_FOR_VOLUME)).toMatchObject({
      timeoutMs: 8_000,
    });
    expect(optionsFor(POOLS_FOR_VOLUME)?.keepPreviousData).toBeUndefined();
  });

  it("uses 8s timeouts for v2 broker volume polling queries", () => {
    renderVolume("v2");

    expect(optionsFor(BROKER_TRADER_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
      keepPreviousData: true,
    });
    expect(optionsFor(BROKER_AGGREGATOR_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
      keepPreviousData: true,
    });
  });

  it("keeps v3 chart, trader, and aggregator skeletons off while retained data revalidates", () => {
    volumeState.range = "90d";
    poolVolumeState.rows = [{ id: "prior-window-row" }];
    poolVolumeState.isLoading = true;
    poolVolumeState.dataAfterTimestamp = 1_690_000_000;
    poolVolumeState.dataRange = "30d";
    poolVolumeState.hasData = true;
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === TRADER_DAILY_TOP) {
        return {
          data: { TraderDailySnapshot: [] },
          error: null,
          isLoading: true,
        };
      }
      if (query === POOLS_FOR_VOLUME) {
        return { data: { Pool: [] }, error: null, isLoading: true };
      }
      if (query === AGGREGATOR_DAILY_TOP) {
        return {
          data: { AggregatorDailySnapshot: [] },
          error: null,
          isLoading: true,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    renderVolume("v3");

    const chartCall = mockTimeSeriesChartCard.mock.calls.find(
      ([props]) => props.title === "Volume by pool",
    );
    expect(chartCall?.[0]).toMatchObject({ isLoading: false });
    expect(mockUsePoolChartViewModel).toHaveBeenCalledWith(
      expect.objectContaining({ cutoff: 1_690_000_000 }),
    );
    expect(mockV3VolumeSection).toHaveBeenCalledWith(
      expect.objectContaining({
        tableState: expect.objectContaining({ isLoading: false }),
        aggregatorState: expect.objectContaining({ isLoading: false }),
      }),
    );
  });

  it("keeps v2 trader and aggregator skeletons off while retained data revalidates", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === BROKER_TRADER_DAILY_TOP) {
        return {
          data: { BrokerTraderDailySnapshot: [] },
          error: null,
          isLoading: true,
        };
      }
      if (query === BROKER_AGGREGATOR_DAILY_TOP) {
        return {
          data: { BrokerAggregatorDailySnapshot: [] },
          error: null,
          isLoading: true,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    renderVolume("v2");

    expect(mockV2VolumeSection).toHaveBeenCalledWith(
      expect.objectContaining({
        tableIsLoading: false,
        v2AggIsLoading: false,
      }),
    );
  });

  it("keeps retained v3 table, aggregator, and pool data visible after replacement errors", () => {
    volumeState.range = "30d";
    poolVolumeState.rows = [{ id: "retained-pool-row" }];
    poolVolumeState.error = new Error("new pool window failed");
    poolVolumeState.dataAfterTimestamp = 1_690_000_000;
    poolVolumeState.dataRange = "30d";
    poolVolumeState.hasData = true;
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === TRADER_DAILY_TOP) {
        return {
          data: { TraderDailySnapshot: [] },
          error: new Error("new trader window failed"),
          isLoading: false,
        };
      }
      if (query === POOLS_FOR_VOLUME) {
        return { data: { Pool: [] }, error: null, isLoading: false };
      }
      if (query === AGGREGATOR_DAILY_TOP) {
        return {
          data: { AggregatorDailySnapshot: [] },
          error: new Error("new aggregator window failed"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    renderVolume("v3");

    const chartCall = mockTimeSeriesChartCard.mock.calls.find(
      ([props]) => props.title === "Volume by pool",
    );
    expect(chartCall?.[0]).toMatchObject({ hasError: false });
    expect(mockV3VolumeSection).toHaveBeenCalledWith(
      expect.objectContaining({
        tableState: expect.objectContaining({ hasError: false }),
        aggregatorState: expect.objectContaining({ hasError: false }),
      }),
    );
  });

  it("keeps retained v2 trader and aggregator data visible after replacement errors", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === BROKER_TRADER_DAILY_TOP) {
        return {
          data: { BrokerTraderDailySnapshot: [] },
          error: new Error("new trader window failed"),
          isLoading: false,
        };
      }
      if (query === BROKER_AGGREGATOR_DAILY_TOP) {
        return {
          data: { BrokerAggregatorDailySnapshot: [] },
          error: new Error("new aggregator window failed"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    renderVolume("v2");

    expect(mockV2VolumeSection).toHaveBeenCalledWith(
      expect.objectContaining({ tableHasError: false, v2AggHasError: false }),
    );
  });

  it("switches the v2 aggregator query ordering with the actor filter", () => {
    renderVolume("v2", true);

    expect(
      optionsFor(BROKER_AGGREGATOR_DAILY_TOP_INCLUDING_PROTOCOL_ACTORS),
    ).toMatchObject({
      timeoutMs: 8_000,
      keepPreviousData: true,
    });
  });

  it("forces external users onto all volume and hides private filters", () => {
    const html = renderVolume("v2", false, false);

    expect(html).toContain(
      "Top legacy-v2 traders on Mento by total USD volume",
    );
    expect(html).not.toContain('aria-label="Protocol actors"');
    expect(html).not.toContain("Filter out internal");
    expect(html).not.toContain("Shows all volume incl.");
    expect(html).not.toContain("Exploratory exclusions");
    expect(variablesFor(BROKER_TRADER_DAILY_TOP)).toMatchObject({
      isProtocolActorIn: [false, true],
    });
    expect(
      optionsFor(BROKER_AGGREGATOR_DAILY_TOP_INCLUDING_PROTOCOL_ACTORS),
    ).toMatchObject({
      timeoutMs: 8_000,
      keepPreviousData: true,
    });
  });

  it("keeps the private volume filters available for logged-in users", () => {
    const html = renderVolume("v3", false, true);

    expect(html).toContain('aria-label="Protocol actors"');
    expect(html).toContain("Organic");
    expect(html).toContain("Filter out internal &amp; rebalancing flows.");
    expect(html).toContain("All");
    expect(html).toContain(
      "Shows all volume incl. internal &amp; rebalancing flows.",
    );
    expect(html).not.toContain("Exploratory exclusions");
    expect(variablesFor(TRADER_DAILY_TOP)).toMatchObject({
      isProtocolActorIn: [false],
    });
  });

  it("renders the daily volume chart before summary KPI tiles", () => {
    const html = renderVolume("v3");

    expect(html.indexOf("Daily traded volume")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Total volume")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Daily traded volume")).toBeLessThan(
      html.indexOf("Total volume"),
    );
  });

  it("keeps analysis sections directly below top-line volume", () => {
    const html = renderVolume("v3");

    expect(html.indexOf("Total volume")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('data-testid="v3-section"')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Total volume")).toBeLessThan(
      html.indexOf('data-testid="v3-section"'),
    );
    expect(html).not.toContain("Exploratory exclusions");
  });

  it("forwards server-prefetched initialData into useHeroRollup", () => {
    const initialData: VolumeHeroInitialData = {
      view: {
        networkId: "celo-mainnet",
        venue: "v3",
        range: "7d",
        includeProtocolActors: false,
        todayMidnight: 1_780_012_800,
      },
      heroV3: { volumeWindowSnapshots: [] },
      todayV3: { volumeTodayTraders: [] },
    };
    volumeState.venue = "v3";
    volumeState.includeProtocolActors = false;
    renderToStaticMarkup(
      <VolumeClient canUseVolumeFilters={false} initialData={initialData} />,
    );

    expect(mockUseHeroRollup).toHaveBeenCalledWith(
      expect.objectContaining({ initialData }),
    );
  });

  it("gates the swaps subtitle while the hero is loading (no happy-path zero)", () => {
    heroState.isLoading = true;
    const html = renderVolume("v3");

    expect(html).toContain("— swaps");
    expect(html).not.toContain("0 swaps");
  });

  it("renders the swap count in the subtitle once the hero resolves", () => {
    const html = renderVolume("v3");

    expect(html).toContain("0 swaps");
    expect(html).not.toContain("— swaps");
  });
});
