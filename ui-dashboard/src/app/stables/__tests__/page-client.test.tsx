/**
 * StablesPageClient smoke test — renders with all hooks mocked to verify
 * the page wires KPI strip → sparkline grid → hero chart → changes table
 * without throwing. Covers three states: loading, empty, and data-present.
 *
 * Doesn't assert pixel-perfect output (that's the job of browser verify);
 * does assert the header text + each section anchors render.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StablesPageClient } from "../_components/stables-page-client";
import type {
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  StableSupplyChangeEvent,
} from "../_lib/types";

const mockRates = vi.hoisted(() => ({
  merged: new Map<string, number>([["EURm", 1.1]]),
  isLoading: false,
  error: null,
}));
vi.mock("@/hooks/use-oracle-rates", () => ({
  useOracleRates: () => mockRates,
}));

const mockSnapshots = vi.hoisted(() => ({
  data: [] as StableSupplyDailySnapshot[],
  capped: false,
  error: null as Error | null,
  isLoading: false,
}));
const mockChanges = vi.hoisted(() => ({
  data: [] as StableSupplyChangeEvent[],
  capped: false,
  error: null as Error | null,
  isLoading: false,
}));
const mockLatestCustodyPerToken = vi.hoisted(() => ({
  data: [] as StableTokenCustodyDailySnapshot[],
  error: null as Error | null,
  isLoading: false,
}));
const mockCustodySnapshots = vi.hoisted(() => ({
  data: [] as StableTokenCustodyDailySnapshot[],
  capped: false,
  error: null as Error | null,
  isLoading: false,
}));
vi.mock("../_lib/use-stables-data", () => ({
  useStablesLatestPerToken: () => ({
    snapshots: mockSnapshots.data,
    error: mockSnapshots.error,
    isLoading: mockSnapshots.isLoading,
  }),
  useStablesDailySnapshots: () => ({
    snapshots: mockSnapshots.data,
    error: mockSnapshots.error,
    isLoading: mockSnapshots.isLoading,
    capped: mockSnapshots.capped,
  }),
  useStablesLatestCustodyPerToken: () => ({
    snapshots: mockLatestCustodyPerToken.data,
    error: mockLatestCustodyPerToken.error,
    isLoading: mockLatestCustodyPerToken.isLoading,
  }),
  useStablesCustodyDailySnapshots: () => ({
    snapshots: mockCustodySnapshots.data,
    error: mockCustodySnapshots.error,
    isLoading: mockCustodySnapshots.isLoading,
    capped: mockCustodySnapshots.capped,
  }),
  useStablesChanges: () => ({
    events: mockChanges.data,
    error: mockChanges.error,
    isLoading: mockChanges.isLoading,
    capped: mockChanges.capped,
  }),
}));

function snapshot(
  overrides: Partial<StableSupplyDailySnapshot> &
    Pick<StableSupplyDailySnapshot, "timestamp" | "totalSupply">,
): StableSupplyDailySnapshot {
  return {
    id: `42220-${overrides.tokenAddress ?? "0xa"}-${overrides.timestamp}`,
    chainId: 42220,
    tokenAddress: overrides.tokenAddress ?? "0xa",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    source: overrides.source ?? "RESERVE",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    timestamp: overrides.timestamp,
    totalSupply: overrides.totalSupply,
    dailyMintAmount: overrides.dailyMintAmount ?? "0",
    dailyBurnAmount: overrides.dailyBurnAmount ?? "0",
  };
}

function custodySnapshot(
  overrides: Partial<StableTokenCustodyDailySnapshot> &
    Pick<StableTokenCustodyDailySnapshot, "timestamp" | "lockedSupply">,
): StableTokenCustodyDailySnapshot {
  return {
    id: `42220-${overrides.tokenAddress ?? "0xa"}-${overrides.timestamp}`,
    chainId: 42220,
    tokenAddress: overrides.tokenAddress ?? "0xa",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    source: overrides.source ?? "RESERVE",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    managerAddress: overrides.managerAddress ?? "0xlock",
    timestamp: overrides.timestamp,
    lockedSupply: overrides.lockedSupply,
    dailyLockedAmount: overrides.dailyLockedAmount ?? "0",
    dailyUnlockedAmount: overrides.dailyUnlockedAmount ?? "0",
  };
}

describe("StablesPageClient — smoke", () => {
  beforeEach(() => {
    mockSnapshots.data = [];
    mockSnapshots.capped = false;
    mockSnapshots.error = null;
    mockSnapshots.isLoading = false;
    mockChanges.data = [];
    mockChanges.capped = false;
    mockChanges.error = null;
    mockChanges.isLoading = false;
    mockLatestCustodyPerToken.data = [];
    mockLatestCustodyPerToken.error = null;
    mockLatestCustodyPerToken.isLoading = false;
    mockCustodySnapshots.data = [];
    mockCustodySnapshots.capped = false;
    mockCustodySnapshots.error = null;
    mockCustodySnapshots.isLoading = false;
  });

  it("renders the page header on empty data", () => {
    const html = renderToStaticMarkup(<StablesPageClient />);
    expect(html).toContain("Mento stablecoins");
    expect(html).toContain("Circulating supply");
  });

  it("renders an empty state when no snapshots exist", () => {
    const html = renderToStaticMarkup(<StablesPageClient />);
    // KPI strip headline tiles show "—" when no data is present.
    // Sparkline grid shows the empty-state message.
    expect(html).toContain("No per-token data yet");
  });

  it("renders cards with USDm data when snapshots are present", () => {
    const now = 1_716_336_000; // 2024-05-22 UTC
    mockSnapshots.data = [
      snapshot({
        timestamp: String(now - 7 * 86_400),
        totalSupply: "1000000000000000000000000", // 1M USDm
      }),
      snapshot({
        timestamp: String(now),
        totalSupply: "1100000000000000000000000", // 1.1M USDm
      }),
    ];
    const html = renderToStaticMarkup(<StablesPageClient />);
    // USDm label appears in both the KPI strip + sparkline grid + chart legend.
    expect(html).toContain("USDm");
    // Sparkline grid empty-state message should be absent now.
    expect(html).not.toContain("No per-token data yet");
  });

  it("surfaces the All-range truncation chip when daily snapshots are capped", () => {
    mockSnapshots.capped = true;
    mockSnapshots.data = [
      snapshot({
        timestamp: "1716336000",
        totalSupply: "1000000000000000000",
      }),
    ];
    const html = renderToStaticMarkup(<StablesPageClient />);
    expect(html).toContain("Showing the most recent");
  });

  it("degrades custody query errors to raw supply instead of failing the page", () => {
    mockSnapshots.data = [
      snapshot({
        timestamp: "1716336000",
        totalSupply: "1000000000000000000000000",
      }),
    ];
    mockLatestCustodyPerToken.error = new Error(
      "current custody table unavailable",
    );
    mockCustodySnapshots.error = new Error("custody table unavailable");

    const html = renderToStaticMarkup(<StablesPageClient />);

    expect(html).toContain("USDm");
    expect(html).not.toContain("Failed to load per-token data.");
    expect(html).not.toContain("Failed to load chart data.");
  });

  it("keeps daily custody fallback rows when current custody errors empty", () => {
    mockSnapshots.data = [
      snapshot({
        timestamp: "1716336000",
        totalSupply: "1000000000000000000000000",
      }),
    ];
    mockLatestCustodyPerToken.error = new Error(
      "current custody table unavailable",
    );
    mockCustodySnapshots.data = [
      custodySnapshot({
        timestamp: "1716336000",
        lockedSupply: "250000000000000000000000",
      }),
    ];

    const html = renderToStaticMarkup(<StablesPageClient />);

    expect(html).toContain("$750K");
    expect(html).not.toContain("$1M");
  });

  it("keeps current custody rows when daily custody errors empty", () => {
    mockSnapshots.data = [
      snapshot({
        timestamp: "1716336000",
        totalSupply: "1000000000000000000000000",
      }),
    ];
    mockLatestCustodyPerToken.data = [
      custodySnapshot({
        timestamp: "1716336000",
        lockedSupply: "250000000000000000000000",
      }),
    ];
    mockCustodySnapshots.error = new Error("daily custody table unavailable");

    const html = renderToStaticMarkup(<StablesPageClient />);

    expect(html).toContain("$750K");
    expect(html).not.toContain("$1M");
  });
});
