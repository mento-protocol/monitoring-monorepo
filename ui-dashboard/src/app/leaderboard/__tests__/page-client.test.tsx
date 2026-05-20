import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BROKER_AGGREGATOR_DAILY_TOP,
  BROKER_TRADER_DAILY_TOP,
  POOLS_FOR_LEADERBOARD,
  TRADER_DAILY_TOP,
} from "@/lib/queries/leaderboard";

const mockUseGQL = vi.hoisted(() => vi.fn());
const leaderboardState = vi.hoisted(() => ({
  venue: "v3" as "v3" | "v2",
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("../_lib/url-state", () => ({
  useLeaderboardUrlState: () => ({
    range: "7d",
    showSystem: false,
    venue: leaderboardState.venue,
    cutoff: 1_700_000_000,
    utcDayKey: 20_000,
    updateRange: vi.fn(),
    updateShowSystem: vi.fn(),
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
  TimeSeriesChartCard: () => <div data-testid="chart" />,
}));

vi.mock("../_components/hero-data-quality-banners", () => ({
  HeroDataQualityBanners: () => <div data-testid="hero-banners" />,
}));

vi.mock("../_components/top-pools-list", () => ({
  TopPoolsList: () => <div data-testid="top-pools" />,
}));

vi.mock("../_components/v2-leaderboard-section", () => ({
  V2LeaderboardSection: () => <div data-testid="v2-section" />,
}));

vi.mock("../_components/v3-leaderboard-section", () => ({
  V3LeaderboardSection: () => <div data-testid="v3-section" />,
}));

import { LeaderboardClient } from "../page-client";

function renderLeaderboard(venue: "v3" | "v2") {
  leaderboardState.venue = venue;
  renderToStaticMarkup(<LeaderboardClient />);
}

function optionsFor(query: string) {
  const call = mockUseGQL.mock.calls.find(([document]) => document === query);
  expect(call, `missing useGQL call for ${query}`).toBeDefined();
  return call ? call[call.length - 1] : undefined;
}

describe("LeaderboardClient useGQL wiring", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
    mockUseGQL.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });
  });

  it("uses 8s timeouts for v3 leaderboard polling queries", () => {
    renderLeaderboard("v3");

    expect(optionsFor(TRADER_DAILY_TOP)).toMatchObject({ timeoutMs: 8_000 });
    expect(optionsFor(POOLS_FOR_LEADERBOARD)).toMatchObject({
      timeoutMs: 8_000,
    });
  });

  it("uses 8s timeouts for v2 broker leaderboard polling queries", () => {
    renderLeaderboard("v2");

    expect(optionsFor(BROKER_TRADER_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
    });
    expect(optionsFor(BROKER_AGGREGATOR_DAILY_TOP)).toMatchObject({
      timeoutMs: 8_000,
    });
  });
});
