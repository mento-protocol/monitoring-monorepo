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
  chainId: null as number | null,
  chainIdIn: [42220, 143, 137] as number[],
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
const resolvedIdentityOverrides = vi.hoisted(() => ({
  v3Trader: undefined as string | undefined,
  v3Aggregator: undefined as string | undefined,
  v2Trader: undefined as string | undefined,
  v2Aggregator: undefined as string | undefined,
}));

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
    ) => {
      const data = result.data as Record<string, unknown> | undefined;
      const identityOverride = data?.TraderDailySnapshot
        ? resolvedIdentityOverrides.v3Trader
        : data?.AggregatorDailySnapshot
          ? resolvedIdentityOverrides.v3Aggregator
          : data?.BrokerTraderDailySnapshot
            ? resolvedIdentityOverrides.v2Trader
            : data?.BrokerAggregatorDailySnapshot
              ? resolvedIdentityOverrides.v2Aggregator
              : undefined;
      return {
        data: result.data,
        dataIdentity:
          result.data === undefined
            ? undefined
            : (identityOverride ?? currentIdentity),
        isLoading: result.isLoading && result.data === undefined,
        hasError: result.error != null && result.data === undefined,
      };
    },
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
      chainId: volumeState.chainId,
      chainIdIn: volumeState.chainIdIn,
      chainOptions: [
        { chainId: 42220, label: "Celo" },
        { chainId: 143, label: "Monad" },
        { chainId: 137, label: "Polygon" },
      ],
      cutoff: 1_700_000_000,
      utcDayKey: 20_000,
      updateRange: vi.fn(),
      updateIncludeProtocolActors: vi.fn(),
      updateVenue: vi.fn(),
      updateChainId: vi.fn(),
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
const heroState = vi.hoisted(() => ({
  isLoading: false,
  hasError: false,
  totalVolume: 0,
  concentration: 0,
  displayIdentity: undefined as string | undefined,
  isKpiSourceCapHit: false,
}));

vi.mock("../_lib/use-hero-rollup", () => ({
  useHeroRollup: (args: unknown) => {
    mockUseHeroRollup(args);
    return {
      isLoading: heroState.isLoading,
      hasError: heroState.hasError,
      totalVolume: heroState.totalVolume,
      totalTraders: 0,
      totalSwaps: 0,
      concentration: heroState.concentration,
      staleChains: [],
      degradedChains: [],
      displayRange: volumeState.range,
      displayIdentity: heroState.displayIdentity,
      isKpiSourceCapHit: heroState.isKpiSourceCapHit,
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
    resolvedIdentityOverrides.v3Trader = undefined;
    resolvedIdentityOverrides.v3Aggregator = undefined;
    resolvedIdentityOverrides.v2Trader = undefined;
    resolvedIdentityOverrides.v2Aggregator = undefined;
    heroState.isLoading = false;
    heroState.hasError = false;
    heroState.totalVolume = 0;
    heroState.concentration = 0;
    heroState.displayIdentity = undefined;
    heroState.isKpiSourceCapHit = false;
    volumeState.range = "7d";
    volumeState.chainId = null;
    volumeState.chainIdIn = [42220, 143, 137];
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

  it("scopes every capped v3 query and the hero to the selected chain", () => {
    volumeState.chainId = 137;
    volumeState.chainIdIn = [137];
    renderVolume("v3");

    expect(variablesFor(TRADER_DAILY_TOP)).toMatchObject({ chainIdIn: [137] });
    expect(variablesFor(AGGREGATOR_DAILY_TOP)).toMatchObject({
      chainIdIn: [137],
    });
    expect(variablesFor(POOLS_FOR_VOLUME)).toEqual({ chainIdIn: [137] });
    expect(mockUseHeroRollup).toHaveBeenCalledWith(
      expect.objectContaining({ chainIdIn: [137] }),
    );
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

  it("labels v2 trader and aggregator rows with their independent resolved ranges", () => {
    volumeState.range = "90d";
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === BROKER_TRADER_DAILY_TOP) {
        return {
          data: { BrokerTraderDailySnapshot: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === BROKER_AGGREGATOR_DAILY_TOP) {
        return {
          data: { BrokerAggregatorDailySnapshot: [] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    resolvedIdentityOverrides.v2Trader = "90d|100|organic";
    resolvedIdentityOverrides.v2Aggregator = "30d|200|organic";

    renderVolume("v2");
    expect(mockV2VolumeSection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rangeLabel: "3M",
        aggregatorRangeLabel: "1M",
      }),
    );

    mockV2VolumeSection.mockClear();
    resolvedIdentityOverrides.v2Trader = "30d|200|organic";
    resolvedIdentityOverrides.v2Aggregator = "90d|100|organic";
    renderVolume("v2");
    expect(mockV2VolumeSection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rangeLabel: "1M",
        aggregatorRangeLabel: "3M",
      }),
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

  it("withholds the daily-chart headline until the full trader and hero identities match", () => {
    volumeState.range = "90d";
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === BROKER_TRADER_DAILY_TOP) {
        return {
          data: { BrokerTraderDailySnapshot: [] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    resolvedIdentityOverrides.v2Trader = "90d|200|organic";
    heroState.totalVolume = 123;
    heroState.displayIdentity = "90d|100|organic";

    renderVolume("v2");
    let chartCall = mockTimeSeriesChartCard.mock.calls.find(
      ([props]) => props.title === "Daily v2 traded volume",
    );
    expect(chartCall?.[0]).toMatchObject({ headline: "" });

    mockTimeSeriesChartCard.mockClear();
    heroState.displayIdentity = "90d|200|organic";
    renderVolume("v2");
    chartCall = mockTimeSeriesChartCard.mock.calls.find(
      ([props]) => props.title === "Daily v2 traded volume",
    );
    expect(chartCall?.[0].headline).not.toBe("");
  });

  it("keeps the displayed concentration cap state separate from the current table cap", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === TRADER_DAILY_TOP) {
        return {
          data: { TraderDailySnapshot: [] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    heroState.displayIdentity = "7d|100|organic";
    heroState.isKpiSourceCapHit = true;

    const html = renderVolume("v3");

    expect(html).toContain("Top-10 concentration (≈)");
    expect(mockV3VolumeSection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tableState: expect.objectContaining({ isCapHit: false }),
      }),
    );
  });

  it("withholds concentration while no coherent hero and trader identity exists", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === TRADER_DAILY_TOP) {
        return {
          data: { TraderDailySnapshot: [] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    heroState.concentration = 42;
    heroState.displayIdentity = undefined;

    const html = renderVolume("v3");

    expect(html).not.toContain("42.0%");
    expect(html).toContain(">…</p>");
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
        chainIdIn: [],
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

  it("passes the trader range, cutoff, and actor scope into the hero KPI identity", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === TRADER_DAILY_TOP) {
        return {
          data: { TraderDailySnapshot: [] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    renderVolume("v3");

    expect(mockUseHeroRollup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kpiSourceIdentity: "7d|1700000000|organic",
      }),
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
