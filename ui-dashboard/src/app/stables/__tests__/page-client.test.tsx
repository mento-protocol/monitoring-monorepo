/** @vitest-environment jsdom */

/**
 * StablesPageClient smoke test — renders with all hooks mocked to verify
 * the page wires KPI strip → hero chart → sparkline grid → changes table
 * without throwing. Covers three states: loading, empty, and data-present.
 *
 * Doesn't assert pixel-perfect output (that's the job of browser verify);
 * does assert the header text + each section anchors render.
 */
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StablesPageClient } from "../_components/stables-page-client";
import type {
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  StableSupplyChangeEvent,
} from "../_lib/types";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
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
  error: null as Error | null,
  isLoading: false,
}));
const mockChanges = vi.hoisted(() => ({
  data: [] as StableSupplyChangeEvent[],
  capped: false,
  error: null as Error | null,
  isLoading: false,
  hasPendingPage: false,
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
    unpricedEventsCount: 0,
    hasPendingPage: mockChanges.hasPendingPage,
  }),
}));

vi.mock("../_lib/use-supply-change-threshold", () => ({
  useSupplyChangeThreshold: () => ({
    minimumUsdValue: 1000,
    updateMinimumUsdValue: () => undefined,
    resetMinimumUsdValue: () => undefined,
  }),
}));

function snapshot(
  overrides: Partial<StableSupplyDailySnapshot> &
    Pick<StableSupplyDailySnapshot, "timestamp" | "totalSupply">,
): StableSupplyDailySnapshot {
  const row: StableSupplyDailySnapshot = {
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
  if (overrides.isCurrentState !== undefined) {
    row.isCurrentState = overrides.isCurrentState;
  }
  return row;
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

function changeEvent(
  overrides: Partial<StableSupplyChangeEvent> = {},
): StableSupplyChangeEvent {
  return {
    id: overrides.id ?? "change-1",
    chainId: overrides.chainId ?? 42220,
    tokenAddress: overrides.tokenAddress ?? "0xusd",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    source: overrides.source ?? "RESERVE",
    kind: overrides.kind ?? "RESERVE_MINT",
    counterparty: overrides.counterparty ?? "0xcounterparty",
    caller: overrides.caller ?? "0xcaller",
    txTo: overrides.txTo ?? "0xto",
    isProtocolOwnedCaller: overrides.isProtocolOwnedCaller ?? true,
    amount: overrides.amount ?? "1000000000000000000",
    txHash: overrides.txHash ?? "0xtx",
    blockNumber: overrides.blockNumber ?? "1",
    blockTimestamp: overrides.blockTimestamp ?? "1780617600",
  };
}

describe("StablesPageClient — smoke", () => {
  beforeEach(() => {
    mockRates.merged = new Map<string, number>([["EURm", 1.1]]);
    mockRates.isLoading = false;
    mockRates.error = null;
    mockSnapshots.data = [];
    mockSnapshots.capped = false;
    mockSnapshots.error = null;
    mockSnapshots.isLoading = false;
    mockChanges.data = [];
    mockChanges.capped = false;
    mockChanges.error = null;
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;
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

  it("surfaces the 3M range control for 90d stablecoin supply URLs", () => {
    const html = renderToStaticMarkup(<StablesPageClient />);
    expect(html).toContain(">3M</button>");
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
    expect(html.indexOf("Mento stablecoin supply")).toBeLessThan(
      html.indexOf("Per-token supply detail"),
    );
    expect(html.indexOf("Per-token supply detail")).toBeLessThan(
      html.indexOf("Supply changes"),
    );
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
    const noticeIndex = html.indexOf("Showing the most recent");
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(html.indexOf("Per-token supply detail")).toBeLessThan(noticeIndex);
    expect(noticeIndex).toBeLessThan(html.indexOf("Supply changes"));
  });

  it("degrades custody query errors to raw supply instead of failing the page", () => {
    mockSnapshots.data = [
      snapshot({
        timestamp: "1716336000",
        totalSupply: "1000000000000000000000000",
        isCurrentState: true,
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

  it("holds the supply-changes skeleton on a cold load while oracle rates are still pending", () => {
    // Rates gate the visibility predicate — isVisibleSupplyChangeEvent
    // fail-opens non-USD rows while `rates` is empty. If the changes page
    // resolves before rates, the section must keep the skeleton until rates
    // arrive instead of revealing a fail-open partial set that then re-filters
    // and grows in waves. So even with first-page rows in hand and no pending
    // page, a still-loading rates fetch keeps the skeleton up on initial load.
    mockRates.isLoading = true;
    mockChanges.data = [changeEvent()];
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;

    const html = renderToStaticMarkup(<StablesPageClient />);

    expect(html).toContain("Supply changes");
    expect(html).toContain('aria-label="Loading table"');
    // The fail-open row must not be revealed yet (its Token cell would show
    // "USDm"; no snapshots are present, so USDm cannot appear elsewhere).
    expect(html).not.toContain("USDm");
  });

  it("does not settle early when the changes page resolves before oracle rates, keeping the reveal single", () => {
    // Step 1 — cold load: changes page 1 resolved with a (fail-open) row while
    // rates are still loading and no follow-up page is pending yet. The latch
    // must NOT fire, so the skeleton holds instead of revealing the row.
    mockRates.isLoading = true;
    mockChanges.data = [changeEvent()];
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;

    const div = document.createElement("div");
    document.body.appendChild(div);
    const localRoot = createRoot(div);
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).not.toBeNull();

    // Step 2 — rates arrive and re-enable a follow-up page for the USD
    // threshold (the wave that early-settle would have exposed). Because the
    // latch never fired, the skeleton still holds rather than growing.
    mockRates.isLoading = false;
    mockChanges.hasPendingPage = true;
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).not.toBeNull();

    // Step 3 — every page and rates have settled: the table reveals its full
    // row set once, in a single reveal.
    mockChanges.hasPendingPage = false;
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).toBeNull();

    act(() => {
      localRoot.unmount();
    });
    div.remove();
  });

  it("keeps the supply-changes skeleton up while a follow-up raw page is still pending, even with first-page rows in hand", () => {
    // useStablesChanges.isLoading already flipped false once the first raw
    // page had visible rows (existing, tested hook behavior), but a 2nd/3rd
    // page can still be in flight — hasPendingPage surfaces that so the
    // table doesn't reveal a partial row set and then grow again.
    mockChanges.data = [changeEvent()];
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = true;

    const html = renderToStaticMarkup(<StablesPageClient />);

    expect(html).toContain("Supply changes");
    expect(html).not.toContain("0xcaller");
  });

  it("keeps already-loaded rows visible when a filter change re-triggers a follow-up page after the first settle", () => {
    // First settle: table fully loaded with real rows, no page pending.
    mockChanges.data = [changeEvent()];
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;

    const div = document.createElement("div");
    document.body.appendChild(div);
    const localRoot = createRoot(div);
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    // Real row is on screen; the loading-table skeleton is not.
    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).toBeNull();

    // Interactive "Min value" raise re-enables page 2 → hasPendingPage flips
    // true while page-1 rows are unchanged. After the first settle this must
    // NOT drop the visible rows back to the 20-row skeleton.
    mockChanges.hasPendingPage = true;
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).toBeNull();

    act(() => {
      localRoot.unmount();
    });
    div.remove();
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
        isCurrentState: true,
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
