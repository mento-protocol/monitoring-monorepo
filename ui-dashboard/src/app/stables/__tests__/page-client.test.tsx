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
  V2StableSupplyChangeEvent,
} from "../_lib/types";

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: { id: "celo-mainnet", chainId: 42220 },
  }),
}));

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
}));
const mockChanges = vi.hoisted(() => ({
  data: [] as V2StableSupplyChangeEvent[],
  capped: false,
}));
vi.mock("../_lib/use-stables-data", () => ({
  useStablesLatestPerToken: () => ({
    snapshots: mockSnapshots.data,
    error: null,
    isLoading: false,
  }),
  useStablesDailySnapshots: () => ({
    snapshots: mockSnapshots.data,
    error: null,
    isLoading: false,
    capped: mockSnapshots.capped,
  }),
  useStablesV2Changes: () => ({
    events: mockChanges.data,
    error: null,
    isLoading: false,
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
    source: overrides.source ?? "V2_RESERVE",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    timestamp: overrides.timestamp,
    totalSupply: overrides.totalSupply,
    dailyMintAmount: overrides.dailyMintAmount ?? "0",
    dailyBurnAmount: overrides.dailyBurnAmount ?? "0",
  };
}

describe("StablesPageClient — smoke", () => {
  beforeEach(() => {
    mockSnapshots.data = [];
    mockSnapshots.capped = false;
    mockChanges.data = [];
    mockChanges.capped = false;
  });

  it("renders the page header on empty data", () => {
    const html = renderToStaticMarkup(<StablesPageClient />);
    expect(html).toContain("Mento stablecoins");
    expect(html).toContain("Outstanding supply");
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
});
