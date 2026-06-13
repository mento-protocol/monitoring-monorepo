/**
 * Tests for GlobalContent aggregation and partial-failure display logic.
 *
 * We render the component server-side (renderToStaticMarkup) with a mocked
 * useAllNetworksData hook and assert that KPI tiles show the correct values,
 * N/A, or "partial data" subtitles depending on error state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SWRResponse } from "swr";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import {
  BASE_NETWORK,
  NETWORK_2,
  TVL_NETWORK,
  makeNetworkData,
  makeSnapshot,
  makeTvlPool,
} from "@/test-utils/network-fixtures";

// Mock hooks that have side effects / SWR dependency
// Keep the real `showInitialSkeleton` (a pure helper) and mock only the hook —
// a bare factory would leave the new named export undefined, crashing render.
vi.mock("@/hooks/use-all-networks-data", async () => ({
  ...(await vi.importActual<typeof import("@/hooks/use-all-networks-data")>(
    "@/hooks/use-all-networks-data",
  )),
  useAllNetworksData: vi.fn(),
}));

// `useGQL` (Traders tile) is wired through SWR + useNetwork; without a mock
// the call throws "useNetwork must be used within <NetworkProvider>" at
// render time, blanking the markup. Mock with a stable default and override
// per-test via `vi.mocked(useGQL).mockReturnValueOnce(...)` for the new
// homepage Traders tile coverage below.
vi.mock("@/lib/graphql", () => ({
  useGQL: vi.fn(),
}));

// GlobalPoolsTable has complex deps — stub it, but capture props for assertions
interface CapturedTableProps {
  entries: { pool: { id: string }; network: { id: string } }[];
  volume24hByKey?: Map<string, number | null>;
  tvlChangeWoWByKey?: Map<string, number | null>;
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
import { useGQL } from "@/lib/graphql";
import * as volumeModule from "@/lib/volume";
import { buildSnapshotWindows } from "@/lib/volume";
// Import from page-client (not page.tsx): page.tsx is now an async Server
// Component that awaits fetchAllNetworks() and hands the result through
// SWRConfig's fallback. renderToStaticMarkup can't execute async components,
// and the rendering logic we actually want to exercise lives in page-client.
import GlobalPage from "../page-client";

// Fixture helpers

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
  // Default `useGQL` mock for the Traders tile — one fresh snapshot row
  // per chain in the fixtures' BASE_NETWORK + NETWORK_2 (chainIds 42220
  // and 11142220) keyed at yesterday's UTC midnight so the tile renders
  // a deterministic count without tripping the missing-chain /
  // stale-chain / empty-rows guards. Tests that exercise the Traders
  // tile's partial paths override via `mockReturnValueOnce` /
  // `mockReturnValue` directly.
  const yesterdaySec = String(
    Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400,
  );
  vi.mocked(useGQL).mockReturnValue({
    data: {
      volumeWindowTraderSnapshots: [
        { chainId: 42220, snapshotDay: yesterdaySec, windowTraders: [] },
        { chainId: 11142220, snapshotDay: yesterdaySec, windowTraders: [] },
      ],
      volumeTodayTraders: [],
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  } as unknown as SWRResponse);
});

// Loading state

describe("GlobalPage — loading state", () => {
  it("shows ellipsis in all KPI tiles while loading", () => {
    const html = render([], true);
    // Should have multiple "…" placeholders
    expect(html.split("…").length - 1).toBeGreaterThanOrEqual(4);
  });
});

// All networks succeed

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
        },
      }),
    ]);
    expect(html).toContain("Swap Fees");
    expect(html).not.toContain("N/A");
  });
});

// Network-level failure (pools query fails)

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

// Fees-only failure

describe("GlobalPage — fees-only failure", () => {
  it("shows N/A on fee-tile failure but leaves other tiles alone", () => {
    const html = render([
      makeNetworkData({ ratesError: new Error("rates timeout") }),
    ]);
    expect(html).toContain("N/A");
    // LPs/Swaps tiles still render their headers.
    expect(html).toContain("LPs");
    expect(html).toContain("Swaps");
    expect(html).not.toContain("partial data");
  });

  it("shows 'Some chains failed to load' subtitle for fee tiles", () => {
    const html = render([
      makeNetworkData({ ratesError: new Error("rates timeout") }),
    ]);
    expect(html).toContain("Some chains failed to load");
  });
});

// LP query failure

describe("GlobalPage — LP query failure", () => {
  it("shows N/A when all LP queries fail", () => {
    const html = render([
      makeNetworkData({
        uniqueLpAddresses: null,
        lpError: new Error("LP aggregate timeout"),
      }),
    ]);
    expect(html).toContain("LPs");
    expect(html).toContain("N/A");
    expect(html).toContain("Partial");
  });

  it("shows 0 when a chain reports 0 LPs and another fails", () => {
    const html = render([
      makeNetworkData({ uniqueLpAddresses: [] }),
      makeNetworkData({
        uniqueLpAddresses: null,
        lpError: new Error("LP aggregate timeout"),
      }),
    ]);
    expect(html).not.toContain("N/A");
    expect(html).toContain("0");
    expect(html).toContain("Partial");
  });

  it("unions LP addresses across successful chains even when one fails", () => {
    const addrs = Array.from({ length: 42 }, (_, i) => `0x${i}`);
    const html = render([
      makeNetworkData({ uniqueLpAddresses: addrs }),
      makeNetworkData({
        uniqueLpAddresses: null,
        lpError: new Error("LP aggregate timeout"),
      }),
    ]);
    // Match the tile value surrounded by > < so we don't collide with Tailwind
    // class digits (e.g. border-4, gap-4). 42 is deliberately chosen to avoid
    // collision with common Tailwind spacing scales.
    expect(html).toContain(">42<");
    expect(html).toContain("Partial");
  });

  it("deduplicates LP addresses that appear on multiple chains", () => {
    // Craft two chains with a deliberate overlap so the union size (13) is
    // distinctive and won't collide with Tailwind spacing classes. Sum of
    // counts would be 20 (the bug signal).
    const chain1 = Array.from({ length: 10 }, (_, i) => `0xlp1-${i}`);
    const chain2 = [
      // 7 addresses shared with chain1
      ...chain1.slice(0, 7),
      // 3 addresses unique to chain2
      ...Array.from({ length: 3 }, (_, i) => `0xlp2-${i}`),
    ];
    // |chain1 ∪ chain2| = 10 + 3 = 13
    const html = render([
      makeNetworkData({ uniqueLpAddresses: chain1 }),
      makeNetworkData({ uniqueLpAddresses: chain2 }),
    ]);
    expect(html).toContain("LPs");
    // Angle-bracketed match guards against false positives from Tailwind classes.
    expect(html).toContain(">13<");
    // Rule out the un-deduped sum (10 + 10 = 20).
    expect(html).not.toContain(">20<");
  });
});

// LP truncation

describe("GlobalPage — LP address truncation", () => {
  it("shows ≈ prefix and truncated subtitle when uniqueLpAddressesTruncated is true", () => {
    const addrs = Array.from({ length: 37 }, (_, i) => `0xlp${i}`);
    const html = render([
      makeNetworkData({
        uniqueLpAddresses: addrs,
        uniqueLpAddressesTruncated: true,
      }),
    ]);
    expect(html).toContain("LPs");
    // ≈ prefix before the count (37 is unlikely to collide with Tailwind classes).
    expect(html).toContain("≈");
    expect(html).toContain("37");
    expect(html).toContain(
      "Approximate — full LP history exceeds pagination cap",
    );
  });

  it("shows exact count and normal subtitle when not truncated", () => {
    const addrs = Array.from({ length: 37 }, (_, i) => `0xlp${i}`);
    const html = render([
      makeNetworkData({
        uniqueLpAddresses: addrs,
        uniqueLpAddressesTruncated: false,
      }),
    ]);
    expect(html).not.toContain("≈");
    expect(html).toContain("Unique LP addresses across all chains");
  });
});

// Snapshots-only failure

describe("GlobalPage — snapshots-only failure", () => {
  it("fees tile still renders normally when only snapshots failed", () => {
    // Volume tile was removed from the Summary — the chart card handles
    // snapshot-failure UX now. Fees come from a separate query, so a
    // snapshot-only failure shouldn't affect fees rendering.
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
        },
      }),
    ]);
    expect(html).toContain("Swap Fees");
    expect(html).not.toContain("Some chains failed to load");
  });
});

// Unpriced symbols — subtitle and 24h scoping

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
        },
      }),
    ]);
    expect(html).toContain("debank.com");
    expect(html).toContain("Swap Fees");
  });
});

// Cross-chain key collision — same pool ID on two different chains

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
    expect(map.has("celo-sepolia-local:0xpool1")).toBe(true);
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

// All-networks-failed — EmptyBox must NOT render

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

// TVL delta sub-KPIs

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
    // Chart's `hasSnapshotError` is wired to `anySnapshotsAllDailyError` in
    // page.tsx, so we trigger the partial-data badge via
    // snapshotsAllDailyError specifically.
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshotsAllDailyError: new Error("timeout"),
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

  it("builds tvlChangeWoWByKey: number for pools with snapshot, absent for pools without", () => {
    // Pool A has a 7d snapshot — should produce a real WoW number.
    // Pool B has no snapshot but no error either — absent key (renders "—" downstream).
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
    render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [poolA, poolB],
        snapshots7d: [snapA],
      }),
    ]);
    expect(capturedProps).not.toBeNull();
    const wow = capturedProps!.tvlChangeWoWByKey!;
    const keyA = `${TVL_NETWORK.id}:pool-a`;
    const keyB = `${TVL_NETWORK.id}:pool-b`;
    expect(wow.get(keyA)).toBeCloseTo(100, 2);
    expect(wow.has(keyB)).toBe(false);
  });

  it("builds tvlChangeWoWByKey: explicit null for every pool when snapshots7dError is set", () => {
    // When the 7d snapshot query fails, the table must render "N/A" — not "—".
    // The page surfaces this by setting an explicit null per pool.
    const poolA = makeTvlPool({ id: "pool-a" });
    const poolB = makeTvlPool({ id: "pool-b" });
    render([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [poolA, poolB],
        snapshots7dError: new Error("hasura timeout"),
      }),
    ]);
    expect(capturedProps).not.toBeNull();
    const wow = capturedProps!.tvlChangeWoWByKey!;
    const keyA = `${TVL_NETWORK.id}:pool-a`;
    const keyB = `${TVL_NETWORK.id}:pool-b`;
    expect(wow.has(keyA)).toBe(true);
    expect(wow.get(keyA)).toBeNull();
    expect(wow.has(keyB)).toBe(true);
    expect(wow.get(keyB)).toBeNull();
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

  it("partial-badges both the TVL and Volume card when the daily all-history fetch fails", () => {
    // Both charts read from the shared `snapshotsAllDaily` fetch now that the
    // hourly paginated fetch has been removed (to keep the homepage under the
    // Envio tier quota). A daily-rollup failure therefore affects both cards.
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        snapshotsAllDailyError: new Error("all-history daily timeout"),
      }),
    ]);

    expect(html.split("· partial data").length - 1).toBe(2);
  });

  it("only partial-badges the TVL card when the 7d-only snapshot query fails", () => {
    // The 7d window is only used by the TVL delta (matchedTvl). Volume depends
    // solely on snapshotsAllDaily — a 7d-only failure must NOT leak into the
    // Volume card's partial-data state.
    const html = render([
      makeNetworkData({
        network: TVL_NETWORK,
        snapshots7dError: new Error("7d timeout"),
      }),
    ]);

    expect(html.split("· partial data").length - 1).toBe(1);
  });
});

// Traders tile — sources its count from the isolated
// VOLUME_WINDOW_TRADERS_LATEST query. Cross-chain Set-deduplication
// (a wallet active on multiple chains counts once) is the load-bearing
// invariant for this tile; the existing `uniqueTraders` field on the hero
// snapshot can't satisfy it because naïve summing double-counts.

describe("GlobalPage — Traders tile", () => {
  it("counts cross-chain overlapping addresses once (Set-deduplicates)", () => {
    // Two chains each contribute 3 traders with 2 overlaps (case-insensitive).
    // Expected unique count = |{A, B, C, D}| = 4. `snapshotDay` set to
    // yesterday's UTC midnight so the stale-chain detection stays off.
    // Uses NETWORK_2's chainId (11142220) so both rows fall inside
    // `expectedChainIds` for the network-scope filter.
    const todaySec = Math.floor(Date.now() / 1000 / 86400) * 86400;
    const yesterdaySec = String(todaySec - 86400);
    vi.mocked(useGQL).mockReturnValue({
      data: {
        volumeWindowTraderSnapshots: [
          {
            chainId: 42220,
            snapshotDay: yesterdaySec,
            windowTraders: [
              "0xAAAA000000000000000000000000000000000001",
              "0xBBBB000000000000000000000000000000000002",
              "0xCCCC000000000000000000000000000000000003",
            ],
          },
          {
            chainId: 11142220,
            snapshotDay: yesterdaySec,
            windowTraders: [
              // First two overlap with Celo (mixed case on purpose — the page
              // lowercases before dedupe).
              "0xaaaa000000000000000000000000000000000001",
              "0xbbbb000000000000000000000000000000000002",
              "0xDDDD000000000000000000000000000000000004",
            ],
          },
        ],
        volumeTodayTraders: [],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    // Both networks pass so `expectedChainIds` covers Celo (42220) and
    // Monad (143) and neither chain's snapshot rows are filtered out by
    // the network-scope guard.
    const html = render([
      makeNetworkData({ pools: [], fees: null }),
      makeNetworkData({ network: NETWORK_2, pools: [], fees: null }),
    ]);
    expect(html).toContain("Traders");
    // Angle-bracket match guards against Tailwind class digits.
    expect(html).toContain(">4<");
  });

  it("renders N/A when the Traders query errors", () => {
    vi.mocked(useGQL).mockReturnValue({
      data: undefined,
      error: new Error("Hasura schema-drift: field not found"),
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    expect(html).toContain("Traders");
    expect(html).toContain("N/A");
  });

  it("renders 0 when every chain returns an empty windowTraders array", () => {
    const yesterdaySec = String(
      Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400,
    );
    vi.mocked(useGQL).mockReturnValue({
      data: {
        volumeWindowTraderSnapshots: [
          { chainId: 42220, snapshotDay: yesterdaySec, windowTraders: [] },
          { chainId: 11142220, snapshotDay: yesterdaySec, windowTraders: [] },
        ],
        volumeTodayTraders: [],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    expect(html).toContain("Traders");
    expect(html).toContain(">0<");
    expect(html).not.toContain(">N/A<");
  });

  // Per AGENTS.md "Loading vs zero vs empty" — a `data === undefined &&
  // !error` SWR slice must NOT render a happy-path zero. Without an
  // explicit `isLoading: true` mock, the prior tests don't exercise
  // this branch and a regression that swallowed the loading sentinel
  // would silently ship `0` instead of `…`. We isolate the Traders
  // tile via its label + the adjacent value markup so the LPs / Swaps
  // tiles (which also render `0` against the empty fixture) don't
  // bleed into the assertion.
  it("renders '…' while the Traders query is loading", () => {
    vi.mocked(useGQL).mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      isValidating: true,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("…");
  });

  // When the snapshot has resolved but the today-partial query is
  // still in flight, the displayed count would be the snapshot-only
  // subtotal — missing today's first-time traders. Render "…" until
  // BOTH halves settle so the user never sees a transient understated
  // count as if it were complete.
  it("renders '…' while the today-partial query is still loading", () => {
    const yesterdaySec = String(
      Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400,
    );
    vi.mocked(useGQL)
      .mockReturnValueOnce({
        data: {
          volumeWindowTraderSnapshots: [
            {
              chainId: 42220,
              snapshotDay: yesterdaySec,
              windowTraders: ["0xaaaa000000000000000000000000000000000001"],
            },
          ],
        },
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      } as unknown as SWRResponse)
      .mockReturnValueOnce({
        data: undefined,
        error: undefined,
        isLoading: true,
        isValidating: true,
        mutate: vi.fn(),
      } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("…");
  });

  // The traders snapshot is a single Hasura query that routinely
  // finishes BEFORE `useAllNetworksData`'s per-network fan-out, so
  // even when the snapshot result is already in (here: empty
  // `windowTraders` arrays), the page-level loading state must keep
  // the tile on "…" until the siblings catch up. Without this, the
  // tile would render a confirmed "0" while LPs / Swaps still show
  // "…", which reads as a real count instead of a load race.
  it("renders '…' while the page is still loading even if the traders query has settled", () => {
    const yesterdaySec = String(
      Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400,
    );
    vi.mocked(useGQL).mockReturnValue({
      data: {
        volumeWindowTraderSnapshots: [
          { chainId: 42220, snapshotDay: yesterdaySec, windowTraders: [] },
        ],
        volumeTodayTraders: [],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    // Second arg passes `isLoading: true` to `useAllNetworksData`.
    const html = render([], true);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("…");
  });

  // The closed-day snapshot only refreshes at the per-chain UTC-midnight
  // heartbeat, so today's brand-new traders are missing without the
  // today-partial union. This test pins the union: a trader present
  // ONLY in `volumeTodayTraders` (today's partial) but absent from
  // every chain's `windowTraders` must still count, and a trader
  // present in both must dedupe to one. `snapshotDay` is set to
  // yesterday's UTC midnight so the stale-chain detection stays off.
  it("merges today's partial trader set on top of the closed-day snapshot", () => {
    const todaySec = Math.floor(Date.now() / 1000 / 86400) * 86400;
    const yesterdaySec = String(todaySec - 86400);
    vi.mocked(useGQL).mockReturnValue({
      data: {
        volumeWindowTraderSnapshots: [
          {
            chainId: 42220,
            snapshotDay: yesterdaySec,
            windowTraders: [
              "0xaaaa000000000000000000000000000000000001",
              "0xbbbb000000000000000000000000000000000002",
            ],
          },
        ],
        volumeTodayTraders: [
          // Overlaps Celo's TRADER_B from the snapshot — should dedupe.
          {
            chainId: 42220,
            trader: "0xBBBB000000000000000000000000000000000002",
          },
          // Brand-new today (no snapshot row) — must still count.
          {
            chainId: 42220,
            trader: "0xeeee000000000000000000000000000000000005",
          },
        ],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("3");
    // Subtitle should stay on the canonical copy — no "Approximate"
    // marker because the snapshot is fresh (snapshotDay = yesterday).
    expect(html).toContain("Unique addresses that traded on v3");
    expect(html).not.toContain("Approximate — chain snapshot catching up");
  });

  // A snapshot whose snapshotDay lags behind yesterday's UTC midnight
  // leaves a gap (closed days between snapshotDay and yesterday are
  // missing from BOTH windowTraders and the today-partial query).
  // Tile must signal approximation with a "≈" prefix + an explanatory
  // subtitle until the indexer catches up.
  it("flags the tile as approximate when any chain snapshot is stale", () => {
    const todaySec = Math.floor(Date.now() / 1000 / 86400) * 86400;
    const threeDaysAgo = String(todaySec - 3 * 86400);
    vi.mocked(useGQL).mockReturnValue({
      data: {
        volumeWindowTraderSnapshots: [
          {
            chainId: 42220,
            snapshotDay: threeDaysAgo,
            windowTraders: ["0xaaaa000000000000000000000000000000000001"],
          },
        ],
        volumeTodayTraders: [],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("≈ 1");
    expect(html).toContain("Approximate — chain snapshot catching up");
  });

  // When the today-partial query errors (timeout / Hasura error / schema
  // drift) we still render the snapshot half, but any wallet whose
  // first-ever v3 swap is today is silently dropped. Tile must surface
  // the partial state so the count isn't read as exact. Mocks the
  // snapshot result on first call and a today-partial ERROR on the
  // second — `mockReturnValueOnce` chains in call order: snapshot,
  // then today-partial.
  it("flags the tile as approximate when the today-partial query errors", () => {
    const yesterdaySec = String(
      Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400,
    );
    vi.mocked(useGQL)
      .mockReturnValueOnce({
        data: {
          volumeWindowTraderSnapshots: [
            {
              chainId: 42220,
              snapshotDay: yesterdaySec,
              windowTraders: [
                "0xaaaa000000000000000000000000000000000001",
                "0xbbbb000000000000000000000000000000000002",
              ],
            },
          ],
        },
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      } as unknown as SWRResponse)
      .mockReturnValueOnce({
        data: undefined,
        error: new Error("Hasura timeout"),
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("≈ 2");
    // When the partial reason is specifically today-error (no stale
    // chain), the subtitle reads "today's partial unavailable" — not
    // "chain snapshot catching up", which would mislead about the
    // actual degradation. `renderToStaticMarkup` HTML-encodes the
    // apostrophe (`&#x27;`), so match a prefix that's stable across
    // encodings.
    expect(html).toContain("Approximate — today");
    expect(html).toContain("partial unavailable");
    expect(html).not.toContain("Approximate — chain snapshot catching up");
  });

  // Variant of the stale-chain branch: when a configured chain has NO
  // snapshot row at all (heartbeat hasn't fired, indexer not yet
  // populated for that chain), `hasMissingOrStaleChain` must still
  // fire — closed-day data for that chain is structurally absent.
  // Renders `≈ N` with the chain-catching-up subtitle.
  it("flags the tile as approximate when a configured chain has no snapshot row", () => {
    const yesterdaySec = String(
      Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400,
    );
    vi.mocked(useGQL).mockReturnValue({
      data: {
        // Only Celo's snapshot row — Monad is configured (passed via
        // networkData below) but missing from the snapshot feed.
        volumeWindowTraderSnapshots: [
          {
            chainId: 42220,
            snapshotDay: yesterdaySec,
            windowTraders: ["0xaaaa000000000000000000000000000000000001"],
          },
        ],
        volumeTodayTraders: [],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    const html = render([
      makeNetworkData({ pools: [], fees: null }),
      makeNetworkData({ network: NETWORK_2, pools: [], fees: null }),
    ]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("≈ 1");
    expect(html).toContain("Approximate — chain snapshot catching up");
  });

  // Hasura may return snapshot or today-partial rows for chains the
  // indexer covers but the dashboard hasn't wired into `networkData`
  // (e.g. an experimental chain). Counting those would inflate the
  // tile vs LPs/Swaps (which are network-scoped) AND a stale row for
  // a non-configured chain would spuriously flip the approximate
  // badge. The fix filters both halves of the union by
  // `expectedChainIds`. This test pins the filter: a snapshot row +
  // a today-partial row, both on an unconfigured chain (chainId
  // 99999, not Celo or Monad), should be dropped from the count.
  it("scopes both halves of the union to expectedChainIds (drops unconfigured chains)", () => {
    const yesterdaySec = String(
      Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400,
    );
    vi.mocked(useGQL).mockReturnValue({
      data: {
        volumeWindowTraderSnapshots: [
          {
            chainId: 42220,
            snapshotDay: yesterdaySec,
            windowTraders: ["0xaaaa000000000000000000000000000000000001"],
          },
          // Unconfigured chain — must be filtered out before counting.
          {
            chainId: 99999,
            snapshotDay: yesterdaySec,
            windowTraders: [
              "0xcccc000000000000000000000000000000000003",
              "0xdddd000000000000000000000000000000000004",
            ],
          },
        ],
        volumeTodayTraders: [
          {
            chainId: 42220,
            trader: "0xbbbb000000000000000000000000000000000002",
          },
          // Unconfigured chain's today partial — must also drop.
          {
            chainId: 99999,
            trader: "0xeeee000000000000000000000000000000000005",
          },
        ],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    // Only Celo is configured; Monad isn't passed either, but the
    // unconfigured chain (99999) is what the scope filter must catch.
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    // Only 2 traders count: 0xaaa…1 (snapshot, Celo) + 0xbbb…2
    // (today-partial, Celo). The 99999-chain rows are dropped.
    expect(tradersMatch?.[1]).toBe("2");
  });

  // Snapshot returns the right shape but with no rows (fresh indexer
  // pre-first-heartbeat, schema-lag returning the shape with zero
  // rows, or a wholesale outage on all chains). Must NOT render a
  // confirmed `0` — that would read as a real metric. Falls back to
  // `N/A` with the canonical subtitle (no partial number to qualify).
  it("renders N/A when the snapshot response has no rows at all", () => {
    vi.mocked(useGQL).mockReturnValue({
      data: {
        volumeWindowTraderSnapshots: [],
        volumeTodayTraders: [],
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    } as unknown as SWRResponse);
    const html = render([makeNetworkData({ pools: [], fees: null })]);
    const tradersMatch = html.match(/Traders<\/p>[\s\S]{0,200}?>([^<]+)</);
    expect(tradersMatch?.[1]).toBe("N/A");
    // Canonical subtitle — no "Approximate" qualifier when the value
    // itself is the missing-data signal.
    expect(html).toContain("Unique addresses that traded on v3");
  });
});
