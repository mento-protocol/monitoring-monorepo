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

// GlobalPoolsTable has complex deps — stub it, but capture props for assertions
interface CapturedTableProps {
  entries: { pool: { id: string }; network: { id: string } }[];
  volume24hByKey?: Map<string, number | null>;
}
let capturedProps: CapturedTableProps | null = null;
vi.mock("@/components/global-pools-table", () => ({
  GlobalPoolsTable: (props: CapturedTableProps) => {
    capturedProps = props;
    return <div data-testid="global-pools-table" />;
  },
  globalPoolKey: (entry: { pool: { id: string }; network: { id: string } }) =>
    `${entry.network.id}:${entry.pool.id}`,
}));

import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import * as volumeModule from "@/lib/volume";
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

import type { Pool } from "@/lib/types";

function makePool(id: string): Pool {
  return {
    id,
    chainId: 42220,
    token0: null,
    token1: null,
    source: "FPMM",
    createdAtBlock: "0",
    createdAtTimestamp: "0",
    updatedAtBlock: "0",
    updatedAtTimestamp: "0",
  };
}

function makeNetworkData(overrides: Partial<NetworkData> = {}): NetworkData {
  return {
    network: BASE_NETWORK,
    pools: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    fees: null,
    error: null,
    feesError: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
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
  capturedProps = null;
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
          fees7dUSD: 200,
          fees30dUSD: 800,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("Swap Fees Earned");
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
          fees7dUSD: 0,
          fees30dUSD: 0,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain(">Volume<");
    expect(html).toContain("N/A");
    // All-time fees should still show (not N/A)
    expect(html).toContain("Swap Fees Earned");
  });

  it("shows N/A for 30d only when snapshots30dError fires, 24h/7d values survive", () => {
    const html = render([
      makeNetworkData({
        snapshots30dError: new Error("30d timeout"),
        fees: {
          totalFeesUSD: 500,
          fees24hUSD: 20,
          fees7dUSD: 100,
          fees30dUSD: 400,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
          isTruncated: false,
        },
      }),
    ]);
    // 30d values should show N/A
    expect(html).toContain("N/A");
    // Subtitle should explain partial failure
    expect(html).toContain("Some chains failed to load");
    // 24h values should still render — $0.00 appears before N/A (24h renders first)
    expect(html).toContain("$0.00");
    const firstValue = html.indexOf("$0.00");
    const firstNA = html.indexOf("N/A");
    expect(firstValue).toBeLessThan(firstNA);
  });

  it("shows N/A for 7d only when snapshots7dError fires, 24h values survive", () => {
    const html = render([
      makeNetworkData({
        snapshots7dError: new Error("7d timeout"),
        fees: {
          totalFeesUSD: 500,
          fees24hUSD: 20,
          fees7dUSD: 100,
          fees30dUSD: 400,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("N/A");
    expect(html).toContain("Some chains failed to load");
    // 24h values should still render — $0.00 appears before N/A (24h renders first)
    expect(html).toContain("$0.00");
    const firstValue = html.indexOf("$0.00");
    const firstNA = html.indexOf("N/A");
    expect(firstValue).toBeLessThan(firstNA);
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
          fees7dUSD: 200,
          fees30dUSD: 800,
          unpricedSymbols: ["FOO"],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
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
          fees7dUSD: 200,
          fees30dUSD: 800,
          // FOO appears in all-time history but NOT in last 24h
          unpricedSymbols: ["FOO"],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
          isTruncated: false,
        },
      }),
    ]);
    // All-time tile should show ≈
    expect(html).toContain("≈");
    // 24h fees section should NOT show approximation subtitle
    // The all-time subtitle has "Approximate — unpriced: FOO" but not the
    // per-period Swap Fees tile (since unpricedSymbols24h is empty).
    const unpricedIdx = html.indexOf("Approximate — unpriced:");
    expect(unpricedIdx).toBeGreaterThan(-1);
    // The MultiPeriodTile "Swap Fees" section is after the "Volume" tile.
    // Find it by searching for the period tile label.
    const swapFeesMultiIdx = html.indexOf(">Swap Fees<");
    expect(swapFeesMultiIdx).toBeGreaterThan(-1);
    // Approximation should not appear in the per-period Swap Fees tile
    const afterSwapFeesTile = html.slice(swapFeesMultiIdx);
    expect(afterSwapFeesTile).not.toContain("Approximate — unpriced");
  });

  it("shows approximate on 24h tile when unresolvedCount24h > 0", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 100,
          fees24hUSD: 50,
          fees7dUSD: 50,
          fees30dUSD: 100,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 1,
          unresolvedCount24h: 1, // UNKNOWN transfer was in last 24h
          unresolvedCount7d: 1,
          unresolvedCount30d: 1,
          isTruncated: false,
        },
      }),
    ]);
    // 24h fees should be marked approximate
    expect(html).toContain("Approximate — some tokens unresolved");
  });

  it("shows 'some tokens unresolved' subtitle on all-time tile when unresolvedCount > 0 with no unpricedSymbols", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 100,
          fees24hUSD: 10,
          fees7dUSD: 50,
          fees30dUSD: 100,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 3,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("≈");
    expect(html).toContain("Approximate — some tokens unresolved");
    // But NOT the 'unpriced: ...' variant since unpricedSymbols is empty
    expect(html).not.toContain("unpriced:");
  });

  it("renders DeBank link on Swap Fees Earned tile", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 500,
          fees24hUSD: 20,
          fees7dUSD: 0,
          fees30dUSD: 0,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unpricedSymbols7d: [],
          unpricedSymbols30d: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          unresolvedCount7d: 0,
          unresolvedCount30d: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("debank.com");
    expect(html).toContain("Swap Fees Earned");
  });
});

// ---------------------------------------------------------------------------
// Cross-chain key collision — same pool ID on two different chains
// ---------------------------------------------------------------------------

describe("GlobalPage — cross-chain key collision", () => {
  it("produces distinct volume24hByKey entries for same pool ID on different networks", () => {
    const pool = makePool("0xpool1");
    render([
      makeNetworkData({ network: BASE_NETWORK, pools: [pool] }),
      makeNetworkData({ network: NETWORK_2, pools: [pool] }),
    ]);
    expect(capturedProps).not.toBeNull();
    const map = capturedProps!.volume24hByKey as Map<string, number | null>;
    expect(map.has("celo-mainnet-hosted:0xpool1")).toBe(true);
    expect(map.has("celo-sepolia-hosted:0xpool1")).toBe(true);
    expect(map.size).toBe(2);
  });

  it("preserves undefined volume entries instead of coercing them to null", () => {
    const pool = makePool("0xpool1");
    const spy = vi
      .spyOn(volumeModule, "buildPoolVolumeMap")
      .mockReturnValue(new Map());

    render([makeNetworkData({ network: BASE_NETWORK, pools: [pool] })]);

    spy.mockRestore();

    expect(capturedProps).not.toBeNull();
    const map = capturedProps!.volume24hByKey as Map<string, number | null>;
    expect(map.has("celo-mainnet-hosted:0xpool1")).toBe(true);
    expect(map.get("celo-mainnet-hosted:0xpool1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// All-networks-failed — EmptyBox must NOT render
// ---------------------------------------------------------------------------

describe("GlobalPage — all networks failed", () => {
  it("shows ErrorBox notices but no EmptyBox when every network fails", () => {
    const html = render([
      makeNetworkData({
        network: BASE_NETWORK,
        error: new Error("mainnet down"),
      }),
      makeNetworkData({
        network: NETWORK_2,
        error: new Error("sepolia down"),
      }),
    ]);
    expect(html).toContain("Failed to load pools");
    expect(html).not.toContain("No pools found across any chain.");
  });
});
