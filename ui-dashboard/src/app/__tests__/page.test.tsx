/**
 * Tests for GlobalContent aggregation and partial-failure display logic.
 *
 * We render the component server-side (renderToStaticMarkup) with a mocked
 * useAllNetworksData hook and assert that KPI tiles show the correct values,
 * N/A, or "partial data" subtitles depending on error state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Network } from "@/lib/networks";

// ---------------------------------------------------------------------------
// Mock hooks that have side effects / SWR dependency
// ---------------------------------------------------------------------------
vi.mock("@/hooks/use-all-networks-data", () => ({
  useAllNetworksData: vi.fn(),
}));

// NetworkProvider reads URL params — stub it out
vi.mock("@/components/network-provider", () => ({
  StaticNetworkProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useNetwork: vi.fn(() => ({
    network: {
      id: "celo-mainnet-hosted",
      tokenSymbols: {},
      addressLabels: {},
      hasVirtualPools: false,
      testnet: false,
    },
    networkId: "celo-mainnet-hosted",
    setNetworkId: vi.fn(),
  })),
}));

// PoolsTable has complex deps — stub it
vi.mock("@/components/pools-table", () => ({
  PoolsTable: () => <div data-testid="pools-table" />,
}));

import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import GlobalPage from "../page";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_NETWORK: Network = {
  id: "celo-mainnet-hosted",
  label: "Celo Mainnet",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://mainnet.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  hasVirtualPools: false,
  testnet: false,
};

const NETWORK_2: Network = {
  ...BASE_NETWORK,
  id: "celo-sepolia-hosted",
  label: "Celo Sepolia",
  chainId: 11142220,
};

function makeNetworkData(overrides: Partial<NetworkData> = {}): NetworkData {
  return {
    network: BASE_NETWORK,
    pools: [],
    snapshots: [],
    fees: null,
    error: null,
    feesError: null,
    snapshotsError: null,
    ...overrides,
  };
}

function render(networkData: NetworkData[], isLoading = false): string {
  (useAllNetworksData as ReturnType<typeof vi.fn>).mockReturnValue({
    networkData,
    isLoading,
    error: null,
  });
  return renderToStaticMarkup(<GlobalPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe("GlobalPage — loading state", () => {
  it("shows ellipsis in all KPI tiles while loading", () => {
    const html = render([], true);
    // Should have multiple "…" placeholders
    expect(html.split("…").length - 1).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// All networks succeed
// ---------------------------------------------------------------------------

describe("GlobalPage — all networks succeed", () => {
  it("shows pool count tile", () => {
    const html = render([
      makeNetworkData({ pools: [], fees: null }),
      makeNetworkData({ network: NETWORK_2, pools: [], fees: null }),
    ]);
    expect(html).toContain("Total Pools");
    expect(html).not.toContain("N/A");
    expect(html).not.toContain("partial data");
  });

  it("shows fees when fees succeed on all networks", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 1000,
          fees24hUSD: 50,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("Total Fees Earned");
    expect(html).not.toContain("N/A");
  });
});

// ---------------------------------------------------------------------------
// Network-level failure (pools query fails)
// ---------------------------------------------------------------------------

describe("GlobalPage — network-level failure", () => {
  it("shows 'partial data' subtitle on pools and TVL tiles", () => {
    const html = render([
      makeNetworkData({ error: new Error("mainnet down") }),
      makeNetworkData({ network: NETWORK_2 }),
    ]);
    expect(html).toContain("partial data");
  });

  it("shows N/A for fees when any network fails", () => {
    const html = render([
      makeNetworkData({ error: new Error("mainnet down") }),
      makeNetworkData({ network: NETWORK_2 }),
    ]);
    // Fees should be N/A since one network is down
    expect(html).toContain("N/A");
  });
});

// ---------------------------------------------------------------------------
// Fees-only failure
// ---------------------------------------------------------------------------

describe("GlobalPage — fees-only failure", () => {
  it("shows N/A for fee tiles but normal values for pools/TVL", () => {
    const html = render([
      makeNetworkData({ feesError: new Error("fees timeout") }),
    ]);
    expect(html).toContain("N/A");
    // Pool count tile should still show "0", not N/A
    expect(html).toContain("Total Pools");
    expect(html).not.toContain("partial data");
  });

  it("shows 'Some chains failed to load' subtitle for fee tiles", () => {
    const html = render([
      makeNetworkData({ feesError: new Error("fees timeout") }),
    ]);
    expect(html).toContain("Some chains failed to load");
  });
});

// ---------------------------------------------------------------------------
// Snapshots-only failure
// ---------------------------------------------------------------------------

describe("GlobalPage — snapshots-only failure", () => {
  it("shows N/A for volume/swaps but not for fees", () => {
    const html = render([
      makeNetworkData({
        snapshotsError: new Error("snapshots timeout"),
        fees: {
          totalFeesUSD: 500,
          fees24hUSD: 20,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("24h Volume");
    expect(html).toContain("N/A");
    // All-time fees should still show (not N/A)
    expect(html).toContain("Total Fees Earned");
  });
});

// ---------------------------------------------------------------------------
// Unpriced symbols — subtitle and 24h scoping
// ---------------------------------------------------------------------------

describe("GlobalPage — unpriced symbols behavior", () => {
  it("shows 'Approximate — unpriced: FOO' subtitle when all-time unpriced symbols exist", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 1000,
          fees24hUSD: 50,
          unpricedSymbols: ["FOO"],
          unpricedSymbols24h: [],
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("Approximate — unpriced: FOO");
    expect(html).toContain("≈");
  });

  it("does NOT show approximation on 24h tile when unpriced symbols are outside 24h", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 1000,
          fees24hUSD: 50,
          // FOO appears in all-time history but NOT in last 24h
          unpricedSymbols: ["FOO"],
          unpricedSymbols24h: [],
          isTruncated: false,
        },
      }),
    ]);
    // All-time tile should show ≈
    expect(html).toContain("≈");
    // 24h fees section should NOT show approximation subtitle
    // The all-time subtitle has "Approximate — unpriced: FOO" but not 24h
    const unpricedIdx = html.indexOf("Approximate — unpriced:");
    expect(unpricedIdx).toBeGreaterThan(-1);
    // 24h Fees Earned label appears after the all-time fees section
    const fees24hIdx = html.indexOf("24h Fees Earned");
    // Approximation should not appear after the 24h section start
    // (i.e. it appears only in the all-time section)
    const afterFees24h = html.slice(fees24hIdx);
    expect(afterFees24h).not.toContain("Approximate — unpriced");
  });

  it("renders DeBank link on Total Fees Earned tile", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 500,
          fees24hUSD: 20,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("debank.com");
    expect(html).toContain("Total Fees Earned");
  });
});
