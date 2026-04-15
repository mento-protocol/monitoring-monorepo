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
import {
  BASE_NETWORK,
  NETWORK_2,
  TVL_NETWORK,
  makeNetworkData,
  makeSnapshot,
  makeTvlPool,
} from "@/test-utils/network-fixtures";

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
import { buildSnapshotWindows } from "@/lib/volume";
import GlobalPage from "../page";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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
  it("renders the summary tiles without error state on all-success", () => {
    const html = render([
      makeNetworkData({ pools: [], fees: null }),
      makeNetworkData({ network: NETWORK_2, pools: [], fees: null }),
    ]);
    // Volume and Swap Fees tiles present; no fallback-error UI.
    expect(html).toContain("Volume");
    expect(html).toContain("Swap Fees");
    expect(html).not.toContain("N/A");
    expect(html).not.toContain("partial data");
  });

  it("shows fees when fees succeed on all networks", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 1000,
          fees24hUSD: 50,
          fees7dUSD: 50,
          fees30dUSD: 50,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("Swap Fees");
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
  it("shows N/A on fee-tile failure but leaves other tiles alone", () => {
    const html = render([
      makeNetworkData({ feesError: new Error("fees timeout") }),
    ]);
    expect(html).toContain("N/A");
    // LPs/Swaps tiles still render their headers.
    expect(html).toContain("LPs");
    expect(html).toContain("Swaps");
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
// LP query failure
// ---------------------------------------------------------------------------

describe("GlobalPage — LP query failure", () => {
  it("shows N/A when all LP queries fail", () => {
    const html = render([
      makeNetworkData({
        uniqueLpCount: null,
        lpError: new Error("LP aggregate timeout"),
      }),
    ]);
    expect(html).toContain("LPs");
    expect(html).toContain("N/A");
    expect(html).toContain("Partial");
  });

  it("shows 0 when a chain reports 0 LPs and another fails", () => {
    const html = render([
      makeNetworkData({ uniqueLpCount: 0 }),
      makeNetworkData({
        uniqueLpCount: null,
        lpError: new Error("LP aggregate timeout"),
      }),
    ]);
    expect(html).not.toContain("N/A");
    expect(html).toContain("0");
    expect(html).toContain("Partial");
  });

  it("sums LP counts from successful chains even when one fails", () => {
    const html = render([
      makeNetworkData({ uniqueLpCount: 42 }),
      makeNetworkData({
        uniqueLpCount: null,
        lpError: new Error("LP aggregate timeout"),
      }),
    ]);
    expect(html).toContain("42");
    expect(html).toContain("Partial");
  });
});

// ---------------------------------------------------------------------------
// Snapshots-only failure
// ---------------------------------------------------------------------------

describe("GlobalPage — snapshots-only failure", () => {
  it("shows error subtitle on volume tile but fees still render", () => {
    const html = render([
      makeNetworkData({
        snapshotsError: new Error("snapshots timeout"),
        fees: {
          totalFeesUSD: 500,
          fees24hUSD: 20,
          fees7dUSD: 20,
          fees30dUSD: 20,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          isTruncated: false,
        },
      }),
    ]);
    // Volume tile shows all-time total (from pool counters) with error subtitle
    expect(html).toContain("Volume");
    expect(html).toContain("Some chains failed to load");
    // Sub-rows (24h/7d/30d) are hidden when hasError is true
    // Fees should still render normally
    expect(html).toContain("Swap Fees");
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
          fees7dUSD: 50,
          fees30dUSD: 50,
          unpricedSymbols: ["FOO"],
          unpricedSymbols24h: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("Approximate — unpriced: FOO");
    expect(html).toContain("≈");
  });

  it("shows approximation subtitle only once when unpriced symbols are outside 24h", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 1000,
          fees24hUSD: 50,
          fees7dUSD: 50,
          fees30dUSD: 50,
          // FOO appears in all-time history but NOT in last 24h
          unpricedSymbols: ["FOO"],
          unpricedSymbols24h: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          isTruncated: false,
        },
      }),
    ]);
    // Total should show ≈ prefix and approximation subtitle
    expect(html).toContain("≈");
    expect(html).toContain("Approximate — unpriced: FOO");
  });

  it("shows approximate on 24h tile when unresolvedCount24h > 0", () => {
    const html = render([
      makeNetworkData({
        fees: {
          totalFeesUSD: 100,
          fees24hUSD: 50,
          fees7dUSD: 50,
          fees30dUSD: 50,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unresolvedCount: 1,
          unresolvedCount24h: 1, // UNKNOWN transfer was in last 24h
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
          fees7dUSD: 10,
          fees30dUSD: 10,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unresolvedCount: 3,
          unresolvedCount24h: 0,
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
          fees7dUSD: 20,
          fees30dUSD: 20,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
          isTruncated: false,
        },
      }),
    ]);
    expect(html).toContain("debank.com");
    expect(html).toContain("Swap Fees");
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
    expect(map.has("celo-mainnet:0xpool1")).toBe(true);
    expect(map.has("celo-sepolia:0xpool1")).toBe(true);
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
    expect(map.has("celo-mainnet:0xpool1")).toBe(true);
    expect(map.get("celo-mainnet:0xpool1")).toBeUndefined();
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

// ---------------------------------------------------------------------------
// TVL delta sub-KPIs
// ---------------------------------------------------------------------------

describe("GlobalPage — TVL delta sub-KPIs", () => {
  it("renders percentage changes when snapshots have historical reserves", () => {
    // Current reserves: 200 USDm + 100 KESm at 1:1 = $300 TVL
    // Historical (24h): 100 USDm + 50 KESm = $150 TVL → +100%
    const pool = makeTvlPool({
      id: "pool-tvl",
      reserves0: "200000000000000000000",
      reserves1: "100000000000000000000",
    });
    const snap24h = makeSnapshot({
      poolId: "pool-tvl",
      timestamp: "1000",
      reserves0: "100000000000000000000",
      reserves1: "50000000000000000000",
    });
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots: [snap24h],
        snapshots7d: [snap24h],
        snapshots30d: [snap24h],
      }),
    ]);
    // Chart formats deltas with .toFixed(2) and labels the headline "Total Value Locked"
    expect(html).toContain("+100.00%");
    expect(html).toContain("Total Value Locked");
  });

  it("shows dash when no snapshots are available", () => {
    const pool = makeTvlPool({
      id: "pool-tvl",
      reserves0: "200000000000000000000",
      reserves1: "100000000000000000000",
    });
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        // No snapshots → deltas should be null → dashes
      }),
    ]);
    // Should not show any percentage, but should show TVL value
    expect(html).toContain("Total Value Locked");
    expect(html).not.toContain("%");
  });

  it("shows negative percentage for TVL decrease", () => {
    // Current: 50 USDm + 50 KESm = $100
    // Historical: 100 USDm + 100 KESm = $200 → -50%
    const pool = makeTvlPool({
      id: "pool-tvl",
      reserves0: "50000000000000000000",
      reserves1: "50000000000000000000",
    });
    const snap = makeSnapshot({
      poolId: "pool-tvl",
      timestamp: "1000",
      reserves0: "100000000000000000000",
      reserves1: "100000000000000000000",
    });
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots: [snap],
        snapshots7d: [snap],
        snapshots30d: [snap],
      }),
    ]);
    expect(html).toContain("-50.00%");
  });

  it("shows snapshot error subtitle when snapshot queries fail", () => {
    const pool = makeTvlPool({
      id: "pool-tvl",
      reserves0: "200000000000000000000",
      reserves1: "100000000000000000000",
    });
    // Chart's `hasSnapshotError` is wired to `anySnapshotsAllError` in page.tsx,
    // so we trigger the partial-data badge via snapshotsAllError specifically.
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshotsAllError: new Error("timeout"),
      }),
    ]);
    expect(html).toContain("· partial data");
  });

  it("computes correct delta with matched numerator/denominator across chains", () => {
    // Chain A: current $300, historical $150 → +100%
    // Chain B: has pools but no snapshots → excluded from delta
    const poolA = makeTvlPool({
      id: "pool-a",
      reserves0: "200000000000000000000",
      reserves1: "100000000000000000000",
    });
    const snapA = makeSnapshot({
      poolId: "pool-a",
      timestamp: "1000",
      reserves0: "100000000000000000000",
      reserves1: "50000000000000000000",
    });
    const poolB = makeTvlPool({
      id: "pool-b",
      reserves0: "500000000000000000000",
      reserves1: "500000000000000000000",
    });
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [poolA],
        snapshots: [snapA],
        snapshots7d: [snapA],
        snapshots30d: [snapA],
      }),
      makeNetworkData({
        network: NETWORK_2,
        pools: [poolB],
        // No snapshots for chain B — should NOT inflate the delta
      }),
    ]);
    // Delta should be +100% (only chain A), not inflated by chain B's TVL
    expect(html).toContain("+100.00%");
  });

  it("excludes new pools without snapshots on the same chain from delta", () => {
    // Pool A: has snapshot, current $300, historical $150 → +100%
    // Pool B: same chain, no snapshot (newly created) — must NOT inflate delta
    const poolA = makeTvlPool({
      id: "pool-a",
      reserves0: "200000000000000000000",
      reserves1: "100000000000000000000",
    });
    const poolB = makeTvlPool({
      id: "pool-b",
      reserves0: "500000000000000000000",
      reserves1: "500000000000000000000",
    });
    const snapA = makeSnapshot({
      poolId: "pool-a",
      timestamp: "1000",
      reserves0: "100000000000000000000",
      reserves1: "50000000000000000000",
    });
    // Only pool-a has a snapshot; pool-b is new (no snapshot in window)
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [poolA, poolB],
        snapshots: [snapA],
        snapshots7d: [snapA],
        snapshots30d: [snapA],
      }),
    ]);
    // Delta should be +100% (pool A only), not ~+766% if pool B's $1000 leaked in
    expect(html).toContain("+100.00%");
  });
});

describe("GlobalPage — Volume chart wiring", () => {
  it("uses the 'Volume' label without a time-range suffix in the title", () => {
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [makeTvlPool({ id: "pool-volume" })],
      }),
    ]);

    expect(html).toContain(">Volume<");
    expect(html).not.toContain("Volume (past 7d)");
    expect(html).not.toContain("Volume (24h)");
  });

  it("suppresses the Volume delta at the default 1M range", () => {
    // At default 1M range, we don't have two full 7-day windows' worth of
    // comparable data, so the chart intentionally suppresses the delta pill.
    // week-over-week text only appears in the Volume card's delta — the TVL
    // card's delta has its own week-over-week label when a TVL delta exists.
    const queryAnchor = Date.UTC(2026, 3, 14, 10, 30, 0, 0);
    const snapshotWindows = buildSnapshotWindows(queryAnchor);
    const pool = makeTvlPool({
      id: "pool-volume",
      reserves0: "0",
      reserves1: "0",
    });
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        snapshotWindows,
        pools: [pool],
        snapshots30d: [
          makeSnapshot({
            poolId: "pool-volume",
            timestamp: snapshotWindows.w7d.from + 3600,
            swapVolume0: "20000000000000000000",
          }),
        ],
      }),
    ]);

    // Volume card at 1M range: no delta pill from volume. TVL card has no
    // 7d-ago snapshot in this fixture, so its delta is also null.
    expect(html).not.toContain("week-over-week");
  });

  it("wires an all-history snapshots failure through to both chart cards", () => {
    // snapshotsAll is the series source for both TVL and Volume, so a failure
    // partial-badges both cards.
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        snapshotsAllError: new Error("all-history timeout"),
      }),
    ]);

    expect(html.split("· partial data").length - 1).toBe(2);
  });

  it("only partial-badges the TVL card when the 7d-only snapshot query fails", () => {
    // The 7d window is only used by the TVL delta (matchedTvl). Volume depends
    // solely on snapshotsAll — a 7d-only failure must NOT leak into the Volume
    // card's partial-data state.
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        snapshots7dError: new Error("7d timeout"),
      }),
    ]);

    expect(html.split("· partial data").length - 1).toBe(1);
  });
});
