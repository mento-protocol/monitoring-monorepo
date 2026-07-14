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

// JSDOM does not compute real layout, so `getBoundingClientRect().top` is
// always 0 — no direct stand-in for "did this element move down the page".
// Counts every earlier-in-document-order element across all ancestor levels
// instead: under this page's normal top-to-bottom flow (no floats/absolute
// positioning), an element gaining or losing preceding elements is exactly
// an element gaining or losing vertical position above it.
function precedingElementCount(el: Element): number {
  let count = 0;
  let node: Node | null = el;
  while (node?.parentNode) {
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE) count++;
      sibling = sibling.previousSibling;
    }
    node = node.parentNode;
  }
  return count;
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
    const noticeIndex = html.indexOf("Showing the most recent 1,000");
    expect(noticeIndex).toBeGreaterThan(-1);
    // Folded into the supply-changes card's header (issue #1239) so it
    // never displaces the card's position — it renders just after the
    // "Supply changes" heading, not as a standalone block before it.
    expect(html.indexOf("Per-token supply detail")).toBeLessThan(noticeIndex);
    expect(html.indexOf("Supply changes")).toBeLessThan(noticeIndex);
  });

  it("does not render the snapshot-limit notice, and does not insert a sibling before the supply-changes card, when the cap is not hit", () => {
    mockSnapshots.data = [
      snapshot({
        timestamp: "1716336000",
        totalSupply: "1000000000000000000",
      }),
    ];

    const div = document.createElement("div");
    document.body.appendChild(div);
    const localRoot = createRoot(div);

    // Uncapped: no notice anywhere, and the changes card is the last of the
    // page's five top-level sections (header, KPI strip, hero chart,
    // sparkline grid, changes card) — no phantom sibling reserved for it.
    mockSnapshots.capped = false;
    act(() => {
      localRoot.render(<StablesPageClient />);
    });
    const rootContainer = div.querySelector<HTMLDivElement>(".space-y-8");
    expect(rootContainer).toBeTruthy();
    expect(div.textContent).not.toContain("Showing the most recent 1,000");
    const childCountUncapped = rootContainer!.children.length;
    const lastChildUncapped = rootContainer!.lastElementChild;
    expect(lastChildUncapped?.textContent).toContain("Supply changes");

    act(() => {
      localRoot.unmount();
    });
    div.remove();

    // Capped (on a FRESH mount — post-settle in-place flips are frozen out,
    // see the "freezes the truncation notice" test below): the notice
    // appears, but folded into the card's own header — the card stays the
    // same last child at the same sibling index, so its top position
    // relative to the sparkline grid above it is unchanged.
    mockSnapshots.capped = true;
    const cappedMountDiv = document.createElement("div");
    document.body.appendChild(cappedMountDiv);
    const cappedMountRoot = createRoot(cappedMountDiv);
    act(() => {
      cappedMountRoot.render(<StablesPageClient />);
    });
    const cappedContainer =
      cappedMountDiv.querySelector<HTMLDivElement>(".space-y-8");
    expect(cappedMountDiv.textContent).toContain(
      "Showing the most recent 1,000",
    );
    expect(cappedContainer!.children.length).toBe(childCountUncapped);
    expect(cappedContainer!.lastElementChild?.textContent).toContain(
      "Supply changes",
    );
    // The notice text lives inside the same card element that was already
    // the last child, not in a new sibling ahead of it.
    expect(cappedContainer!.lastElementChild?.textContent).toContain(
      "Showing the most recent 1,000",
    );

    act(() => {
      cappedMountRoot.unmount();
    });
    cappedMountDiv.remove();
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

  it("does not settle early when supply-change rows resolve before the snapshot-cap outcome is known, so the row's position never moves (Codex review on #1256)", () => {
    // Staggered resolution: the supply-changes rows are ready first (changes
    // query settled, no pending page, rates in) while the daily-snapshots
    // query that decides `snapshotLimitCapped` is still in flight. The
    // notice is folded into this card's OWN header (issue #1239), so if the
    // reveal gate ignored the still-loading snapshots query, the row would
    // appear now under an uncapped header, and the LATER cap resolution
    // would grow the header and shove the already-visible row down inside
    // the card — the exact displacement #1239 eliminated at the page level,
    // reintroduced one level down.
    mockChanges.data = [changeEvent()];
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;
    mockRates.isLoading = false;
    mockSnapshots.isLoading = true; // cap outcome not yet known

    const div = document.createElement("div");
    document.body.appendChild(div);
    const localRoot = createRoot(div);
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    // Step 1 — rows are ready but the cap outcome isn't: the skeleton must
    // still hold instead of revealing the row under a header that might grow.
    expect(div.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).not.toBeNull();
    expect(div.textContent).not.toContain("Showing the most recent 1,000");

    // Step 2 — the daily-snapshots query resolves as capped. The cap outcome
    // is now known, so the single reveal fires: the row and the header
    // notice must both appear together in this SAME render.
    mockSnapshots.isLoading = false;
    mockSnapshots.capped = true;
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).toBeNull();
    expect(div.textContent).toContain("Showing the most recent 1,000");
    const row = div.querySelector("tbody tr");
    expect(row).not.toBeNull();
    const positionAtReveal = precedingElementCount(row!);

    // Step 3 — a further render with the same settled props (e.g. a SWR
    // background revalidation returning identical data) must not move the
    // row again: the header/notice are already final, so nothing above the
    // row can grow or shrink a second time.
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(div.textContent).toContain("Showing the most recent 1,000");
    const rowAfterRerender = div.querySelector("tbody tr");
    expect(rowAfterRerender).not.toBeNull();
    expect(precedingElementCount(rowAfterRerender!)).toBe(positionAtReveal);

    act(() => {
      localRoot.unmount();
    });
    div.remove();
  });

  it("short-circuits the cap wait when one snapshot source already resolved capped, instead of waiting on the other", () => {
    // The notice is driven by an OR of the supply-snapshots and
    // custody-snapshots caps. Once the supply query resolves capped=true the
    // outcome is irrevocably "capped" — the header is already in its final
    // notice-shown shape — so a slow (or wedged) custody query must not keep
    // otherwise-ready rows hidden behind the skeleton.
    mockChanges.data = [changeEvent()];
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;
    mockRates.isLoading = false;
    mockSnapshots.isLoading = false;
    mockSnapshots.capped = true;
    mockCustodySnapshots.isLoading = true; // still in flight — must not matter

    const div = document.createElement("div");
    document.body.appendChild(div);
    const localRoot = createRoot(div);
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(
      div.querySelector('[role="status"][aria-label="Loading table"]'),
    ).toBeNull();
    expect(div.textContent).toContain("Showing the most recent 1,000");

    act(() => {
      localRoot.unmount();
    });
    div.remove();

    // Control: the same custody-still-loading state WITHOUT a decided cap
    // (supply resolved uncapped) must still hold the skeleton — an
    // all-sources-uncapped conclusion needs every query settled.
    mockSnapshots.capped = false;
    const controlDiv = document.createElement("div");
    document.body.appendChild(controlDiv);
    const controlRoot = createRoot(controlDiv);
    act(() => {
      controlRoot.render(<StablesPageClient />);
    });

    expect(controlDiv.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(
      controlDiv.querySelector('[role="status"][aria-label="Loading table"]'),
    ).not.toBeNull();

    act(() => {
      controlRoot.unmount();
    });
    controlDiv.remove();
  });

  it("freezes the truncation notice at its settle-time state so a post-settle cap flip cannot move the visible rows", () => {
    // Once the reveal latch fires it stops watching the cap flag — so a
    // later SWR poll crossing the 1,000-row cap would insert the notice
    // above already-visible rows, the original displacement re-entering
    // through the polling path. The latch therefore stores the cap outcome
    // itself and the header renders the frozen value: a post-settle flip in
    // either direction leaves the header untouched (the fresh cap state
    // surfaces on the next mount instead).
    mockChanges.data = [changeEvent()];
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;
    mockRates.isLoading = false;
    mockSnapshots.isLoading = false;
    mockSnapshots.capped = false;

    const div = document.createElement("div");
    document.body.appendChild(div);
    const localRoot = createRoot(div);
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    // Settled uncapped: rows visible, no notice.
    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(div.textContent).not.toContain("Showing the most recent 1,000");
    const row = div.querySelector("tbody tr");
    expect(row).not.toBeNull();
    const settledPosition = precedingElementCount(row!);

    // Post-settle flip to capped (a later poll returns the 1,000th row):
    // the notice must NOT appear, and the rows must not move.
    mockSnapshots.capped = true;
    act(() => {
      localRoot.render(<StablesPageClient />);
    });

    expect(div.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(div.textContent).not.toContain("Showing the most recent 1,000");
    const rowAfterFlip = div.querySelector("tbody tr");
    expect(rowAfterFlip).not.toBeNull();
    expect(precedingElementCount(rowAfterFlip!)).toBe(settledPosition);

    act(() => {
      localRoot.unmount();
    });
    div.remove();

    // Mirror case: settled CAPPED, then a poll dips back under the cap —
    // the notice must stay (frozen), so rows don't move UP either.
    mockSnapshots.capped = true;
    const cappedDiv = document.createElement("div");
    document.body.appendChild(cappedDiv);
    const cappedRoot = createRoot(cappedDiv);
    act(() => {
      cappedRoot.render(<StablesPageClient />);
    });

    expect(cappedDiv.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(cappedDiv.textContent).toContain("Showing the most recent 1,000");
    const cappedRow = cappedDiv.querySelector("tbody tr");
    expect(cappedRow).not.toBeNull();
    const cappedPosition = precedingElementCount(cappedRow!);

    mockSnapshots.capped = false;
    act(() => {
      cappedRoot.render(<StablesPageClient />);
    });

    expect(cappedDiv.textContent).toContain("Showing the most recent 1,000");
    const cappedRowAfterFlip = cappedDiv.querySelector("tbody tr");
    expect(cappedRowAfterFlip).not.toBeNull();
    expect(precedingElementCount(cappedRowAfterFlip!)).toBe(cappedPosition);

    act(() => {
      cappedRoot.unmount();
    });
    cappedDiv.remove();
  });

  it("surfaces the supply-changes error immediately even while the snapshot-cap outcome is still loading", () => {
    // Without error precedence, a failed changes query plus a slow
    // snapshot/custody request keeps `showChangesSkeleton` true (the table
    // branches on isLoading before hasError), so the user would see an
    // indefinite loading table instead of the error affordance.
    mockChanges.error = new Error("changes query failed");
    mockChanges.isLoading = false;
    mockChanges.hasPendingPage = false;
    mockRates.isLoading = false;
    mockSnapshots.isLoading = true; // cap outcome unknown — must not matter

    const html = renderToStaticMarkup(<StablesPageClient />);

    expect(html).toContain("Failed to load supply changes.");
    expect(html).not.toContain('aria-label="Loading table"');
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
