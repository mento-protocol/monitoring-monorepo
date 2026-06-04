import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BROKER_AGGREGATOR_DAILY_TOP,
  BROKER_TRADER_DAILY_TOP,
  POOLS_FOR_VOLUME,
  TRADER_DAILY_TOP,
} from "@/lib/queries/volume";

const mockUseGQL = vi.hoisted(() => vi.fn());
const volumeState = vi.hoisted(() => ({
  venue: "v3" as "v3" | "v2",
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("../_lib/url-state", () => ({
  useVolumeUrlState: () => ({
    range: "7d",
    actorFilter: "organic",
    includeProtocolActors: false,
    exclusions: { addresses: [], sources: [] },
    venue: volumeState.venue,
    cutoff: 1_700_000_000,
    utcDayKey: 20_000,
    updateRange: vi.fn(),
    updateIncludeProtocolActors: vi.fn(),
    updateExclusions: vi.fn(),
    updateVenue: vi.fn(),
  }),
}));

vi.mock("../_lib/use-pool-volume-snapshots", () => ({
  usePoolVolumeSnapshots: () => ({
    rows: [],
    isLoading: false,
    error: null,
    partial: false,
  }),
}));

vi.mock("../_lib/pool-chart-vm", () => ({
  usePoolChartViewModel: () => ({
    poolVolumeBreakdown: { totalSeries: [], breakdown: [] },
    chartBreakdown: [],
    topPoolsListEntries: [],
  }),
}));

vi.mock("../_lib/use-hero-rollup", () => ({
  useHeroRollup: () => ({
    isLoading: false,
    hasError: false,
    totalVolume: 0,
    totalTraders: 0,
    totalSwaps: 0,
    concentration: 0,
    staleChains: [],
    degradedChains: [],
  }),
}));

vi.mock("@/components/time-series-chart-card", () => ({
  TimeSeriesChartCard: ({ title }: { title: string }) => (
    <div data-testid="chart">{title}</div>
  ),
}));

vi.mock("../_components/hero-data-quality-banners", () => ({
  HeroDataQualityBanners: () => <div data-testid="hero-banners" />,
}));

vi.mock("../_components/top-pools-list", () => ({
  TopPoolsList: () => <div data-testid="top-pools" />,
}));

vi.mock("../_components/v2-volume-section", () => ({
  V2VolumeSection: () => <div data-testid="v2-section" />,
}));

vi.mock("../_components/v3-volume-section", () => ({
  V3VolumeSection: () => <div data-testid="v3-section" />,
}));

import { VolumeClient } from "../page-client";

function renderVolume(venue: "v3" | "v2") {
  volumeState.venue = venue;
  return renderToStaticMarkup(<VolumeClient />);
}

function optionsFor(query: string) {
  const call = mockUseGQL.mock.calls.find(([document]) => document === query);
  expect(call, `missing useGQL call for ${query}`).toBeDefined();
  return call ? call[call.length - 1] : undefined;
}

describe("VolumeClient useGQL wiring", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
    mockUseGQL.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });
  });

  it("uses 8s timeouts for v3 volume polling queries", () => {
    renderVolume("v3");

    expect(optionsFor(TRADER_DAILY_TOP)).toMatchObject({ timeoutMs: 8_000 });
    expect(optionsFor(POOLS_FOR_VOLUME)).toMatchObject({
      timeoutMs: 8_000,
    });
  });

  it("uses 8s timeouts for v2 broker volume polling queries", () => {
    renderVolume("v2");

    expect(optionsFor(BROKER_TRADER_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
    });
    expect(optionsFor(BROKER_AGGREGATOR_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
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
});
