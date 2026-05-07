/** @vitest-environment jsdom */

// Tell React 19 we're in an act-compatible test environment so legitimate
// state-update warnings stay visible (and so the harness stops printing
// "The current testing environment is not configured to support act(...)"
// to stderr on every render in the interactive sort-transition block).
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Tests for `RevenueByPoolTable` against the snapshot-based aggregator.
 * Per-window truncation badges (PR #306) were retired in PR-snapshot-2 once
 * the leaderboard switched off raw transfers — snapshot pagination covers
 * all-time history, so the only remaining `≈` flag is genuine pricing gaps
 * (UNKNOWN tokens or missing FX rates).
 *
 * The aggregator/render tests below use `renderToStaticMarkup` for cheap
 * HTML inspection; the sort-transition + label-fallback blocks at the
 * bottom flip to `react-dom/client` + `act` + native `.click()` so we can
 * drive the `useTableSort` cycle through the SortableTh button — the same
 * jsdom-based interactive convention used by `breach-history-panel.test.tsx`
 * (no @testing-library/react in this package).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/lib/fetch-all-networks";
import type { PoolDailyFeeSnapshot } from "@/lib/types";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before SUT import.
// ---------------------------------------------------------------------------

// `RevenueByPoolTable` calls `useTableSort` which transitively pulls in
// `useRouter` / `usePathname` / `useSearchParams` from next/navigation.
// Without the App Router mounted (we're SSR-rendering with renderToStaticMarkup),
// those hooks throw "invariant expected app router to be mounted".
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/revenue",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ChainIcon pulls in Next Image; stub it out.
vi.mock("@/components/chain-icon", () => ({
  ChainIcon: () => <span data-testid="chain-icon" />,
}));

import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const POOL_ADDR = "0xaaaa000000000000000000000000000000000001";
const CHAIN = 42220;
const SECS_PER_DAY = 86_400;
const NOW_S = Math.floor(Date.now() / 1000);
const TODAY_BUCKET = String(Math.floor(NOW_S / SECS_PER_DAY) * SECS_PER_DAY);

/** Build a minimal PoolDailyFeeSnapshot. Defaults to today's bucket, USDm pegged. */
function feeSnapshot(
  overrides: Partial<PoolDailyFeeSnapshot> = {},
): PoolDailyFeeSnapshot {
  const dayTs = overrides.timestamp ?? TODAY_BUCKET;
  const poolAddress = overrides.poolAddress ?? POOL_ADDR;
  return {
    id: `${CHAIN}-${poolAddress}-${dayTs}`,
    chainId: CHAIN,
    poolAddress,
    timestamp: dayTs,
    tokens: ["0xusd"],
    tokenSymbols: ["USDm"],
    tokenDecimals: [18],
    amounts: ["1000000000000000000"], // 1 USDm
    feesUsdWei: "1000000000000000000", // 1 USD
    ...overrides,
  };
}

/** Build a minimal NetworkData stub. */
function networkData(snapshots: PoolDailyFeeSnapshot[]): NetworkData {
  return {
    network: {
      id: "celo-mainnet",
      chainId: CHAIN,
      label: "Celo",
      contractsNamespace: null,
      hasuraUrl: "",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      testnet: false,
      hasVirtualPools: false,
    },
    snapshotWindows: {
      w24h: { from: 0, to: 0 },
      w7d: { from: 0, to: 0 },
      w30d: { from: 0, to: 0 },
    },
    pools: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAllDaily: [],
    snapshotsAllDailyTruncated: false,
    brokerSnapshotsAllDaily: [],
    brokerSnapshotsAllDailyTruncated: false,
    tradingLimits: [],
    olsPoolIds: new Set(),
    cdpPoolIds: new Set(),
    reservePoolIds: new Set(),
    fees: null,
    feeSnapshots: snapshots,
    feeSnapshotsError: null,
    feeSnapshotsTruncated: false,
    ratesError: null,
    poolLabels: new Map(),
    uniqueLpAddresses: null,
    rates: new Map([
      ["USDm", 1],
      ["GBPm", 1.3263],
    ]),
    error: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    brokerSnapshotsAllDailyError: null,
    lpError: null,
  };
}

type CellRecord = Record<"fees24h" | "fees7d" | "fees30d" | "feesAll", string>;

/**
 * Renders the component and returns the raw HTML of each fee cell (in column
 * order). We split on `font-mono text-right` — each occurrence is one fee
 * column cell — then grab everything up to the closing `</td>`.
 */
function renderFeeCells(networks: NetworkData[]): CellRecord {
  const html = renderToStaticMarkup(
    <RevenueByPoolTable
      networkData={networks}
      isLoading={false}
      hasError={false}
    />,
  );

  // Split on the marker present in every fee cell's class string.
  const parts = html.split("font-mono text-right");
  // parts[0] is the prefix before the first cell; parts[1..n] start after
  // each marker. We need the segment up to the next </td>.
  const cells: string[] = parts.slice(1).map((seg) => seg.split("</td>")[0]);

  return {
    fees24h: cells[0] ?? "",
    fees7d: cells[1] ?? "",
    fees30d: cells[2] ?? "",
    feesAll: cells[3] ?? "",
  };
}

describe("RevenueByPoolTable — snapshot path", () => {
  it("renders priced row with no ≈ on any column", () => {
    const cells = renderFeeCells([networkData([feeSnapshot()])]);
    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
    expect(cells.feesAll).not.toContain("≈");
  });

  it("recent UNKNOWN slot puts ≈ on every column (today's snapshot is in 24h/7d/30d)", () => {
    const snapshots = [
      feeSnapshot({
        tokens: ["0xusd", "0x???"],
        tokenSymbols: ["USDm", "UNKNOWN"],
        tokenDecimals: [18, 18],
        amounts: ["1000000000000000000", "1000000000000000000"],
        feesUsdWei: "1000000000000000000",
      }),
    ];
    const cells = renderFeeCells([networkData(snapshots)]);
    expect(cells.fees24h).toContain("≈");
    expect(cells.fees7d).toContain("≈");
    expect(cells.fees30d).toContain("≈");
    expect(cells.feesAll).toContain("≈");
    expect(cells.feesAll).toContain("unknown tokens");
  });

  it("OLD UNKNOWN snapshot only flags All-time — recent-window cells stay exact", () => {
    const oldDay = String(
      Math.floor((NOW_S - 180 * SECS_PER_DAY) / SECS_PER_DAY) * SECS_PER_DAY,
    );
    const snapshots = [
      // 6 months ago — outside 24h/7d/30d windows
      feeSnapshot({
        timestamp: oldDay,
        tokens: ["0x???"],
        tokenSymbols: ["UNKNOWN"],
        tokenDecimals: [18],
        amounts: ["1000000000000000000"],
        feesUsdWei: "0",
      }),
      // Today — fully priced
      feeSnapshot({
        tokens: ["0xusd"],
        tokenSymbols: ["USDm"],
        tokenDecimals: [18],
        amounts: ["1000000000000000000"],
        feesUsdWei: "1000000000000000000",
      }),
    ];
    const cells = renderFeeCells([networkData(snapshots)]);
    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
    expect(cells.feesAll).toContain("≈");
  });

  it("missing FX oracle rate flips ≈; pegged total still flows through", () => {
    const snapshots = [
      feeSnapshot({
        // BRLm is in TEST symbol set in aggregator tests but NOT in this
        // component's networkData rates map (only USDm/GBPm), so this slot
        // can't be priced.
        tokens: ["0xusd", "0xbrl"],
        tokenSymbols: ["USDm", "BRLm"],
        tokenDecimals: [18, 18],
        amounts: ["3000000000000000000", "100000000000000000000"],
        feesUsdWei: "3000000000000000000",
      }),
    ];
    const cells = renderFeeCells([networkData(snapshots)]);
    expect(cells.feesAll).toContain("≈");
    // 3 USD pegged should still appear (the BRL slot just gets dropped
    // with `unpriced=true`).
    expect(cells.feesAll).toContain("$3.00");
  });

  it("renders empty state when no chains have snapshots", () => {
    const html = renderToStaticMarkup(
      <RevenueByPoolTable
        networkData={[networkData([])]}
        isLoading={false}
        hasError={false}
      />,
    );
    expect(html).toContain("No swap-fee transfers indexed yet");
  });

  it("SKIPS chains with ratesError so FX slots don't mis-price as unpriced", () => {
    const n = networkData([feeSnapshot()]);
    n.ratesError = new Error("oracle rates timed out");
    const html = renderToStaticMarkup(
      <RevenueByPoolTable
        networkData={[n]}
        isLoading={false}
        hasError={true}
      />,
    );
    expect(html).toMatch(/load per-pool revenue/);
    expect(html).not.toContain(POOL_ADDR);
  });

  it("skips chains with feeSnapshotsError (snapshot fetch failed)", () => {
    const n = networkData([feeSnapshot()]);
    n.feeSnapshotsError = new Error("snapshot timeout");
    const html = renderToStaticMarkup(
      <RevenueByPoolTable
        networkData={[n]}
        isLoading={false}
        hasError={true}
      />,
    );
    expect(html).toMatch(/load per-pool revenue/);
    expect(html).not.toContain(POOL_ADDR);
  });

  it("renders pool detail link based on poolId", () => {
    const html = renderToStaticMarkup(
      <RevenueByPoolTable
        networkData={[networkData([feeSnapshot()])]}
        isLoading={false}
        hasError={false}
      />,
    );
    expect(html).toContain(`/pool/${CHAIN}-${POOL_ADDR}`);
  });
});

// ---------------------------------------------------------------------------
// Interactive harness — used by the sort-transition block below. We mount
// into a real jsdom DOM so click events reach the SortableTh button and the
// `useTableSort` state setter actually fires (renderToStaticMarkup can't
// observe state transitions). Mirrors the convention in
// `breach-history-panel.test.tsx` since this package has no @testing-library
// dep.
// ---------------------------------------------------------------------------

interface InteractiveHandle {
  container: HTMLElement;
  root: Root;
}

function renderInteractive(networks: NetworkData[]): InteractiveHandle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <RevenueByPoolTable
        networkData={networks}
        isLoading={false}
        hasError={false}
      />,
    );
  });
  return { container, root };
}

function teardown(handle: InteractiveHandle): void {
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

/**
 * Resolve the SortableTh-wrapped <button> for a column by its visible label.
 * The button text contains the column label plus a sort-state arrow glyph
 * (↑/↓/↕), so we match against `startsWith` on the label.
 */
function headerButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const btns = Array.from(
    container.querySelectorAll<HTMLButtonElement>("thead button"),
  );
  const match = btns.find((b) =>
    (b.textContent ?? "").trim().startsWith(label),
  );
  if (!match) {
    throw new Error(
      `No header button matched "${label}". Buttons: ${btns
        .map((b) => `"${(b.textContent ?? "").trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

/** Read the `aria-sort` attribute on the <th> ancestor of a SortableTh button. */
function ariaSortFor(container: HTMLElement, label: string): string | null {
  const th = headerButton(container, label).closest("th");
  if (!th) throw new Error(`Header "${label}" has no parent <th>`);
  return th.getAttribute("aria-sort");
}

/**
 * Read pool display names from the rendered tbody, in row order. The pool
 * link is the only `<a>` inside each `<tr>` whose `href` starts with `/pool/`.
 */
function poolNamesInOrder(container: HTMLElement): string[] {
  const rows = Array.from(
    container.querySelectorAll<HTMLTableRowElement>("tbody tr"),
  );
  return rows.map((tr) => {
    const link = tr.querySelector<HTMLAnchorElement>('a[href^="/pool/"]');
    return (link?.textContent ?? "").trim();
  });
}

/** Build a NetworkData with two pools at controllable fee levels. */
function twoPoolNetwork(): NetworkData {
  const POOL_A = "0xaaaa000000000000000000000000000000000001";
  const POOL_B = "0xbbbb000000000000000000000000000000000002";
  // Pool A: $1 fee. Pool B: $5 fee. Both today's bucket so they land in
  // 24h/7d/30d/all windows simultaneously.
  const snapshots: PoolDailyFeeSnapshot[] = [
    feeSnapshot({
      poolAddress: POOL_A,
      feesUsdWei: "1000000000000000000", // $1
    }),
    feeSnapshot({
      poolAddress: POOL_B,
      feesUsdWei: "5000000000000000000", // $5
    }),
  ];
  return networkData(snapshots);
}

describe("RevenueByPoolTable — sort transitions", () => {
  let handle: InteractiveHandle | null = null;

  beforeEach(() => {
    // `useTableSort` reads `window.location.search` on mount and writes to
    // it via `history.replaceState` on every click. Without resetting the
    // URL between tests, click side-effects from one test leak into the
    // next test's mount-time read and break the "clicking N times cycles"
    // assertions. Reset to a clean slate every time.
    window.history.replaceState(null, "", "/revenue");
  });

  afterEach(() => {
    if (handle) {
      teardown(handle);
      handle = null;
    }
  });

  it("default sort is fees7d desc — bigger row first, aria-sort wired", () => {
    handle = renderInteractive([twoPoolNetwork()]);
    // Default state from useTableSort: { defaultKey: "fees7d", defaultDir: "desc" }.
    expect(ariaSortFor(handle.container, "7d")).toBe("descending");
    expect(ariaSortFor(handle.container, "24h")).toBe("none");
    expect(ariaSortFor(handle.container, "Pool")).toBe("none");
    // Pool B ($5) renders before Pool A ($1) under fees7d desc.
    const names = poolNamesInOrder(handle.container);
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("0xbbbb");
    expect(names[1]).toContain("0xaaaa");
  });

  it("clicking the active fees7d header toggles desc → asc — rows flip", () => {
    handle = renderInteractive([twoPoolNetwork()]);
    const btn = headerButton(handle.container, "7d");

    act(() => {
      btn.click();
    });

    expect(ariaSortFor(handle.container, "7d")).toBe("ascending");
    // Smaller fee row (Pool A, $1) now first.
    const names = poolNamesInOrder(handle.container);
    expect(names[0]).toContain("0xaaaa");
    expect(names[1]).toContain("0xbbbb");
  });

  it("clicking fees7d twice cycles desc → asc → desc", () => {
    handle = renderInteractive([twoPoolNetwork()]);
    const btn = headerButton(handle.container, "7d");

    act(() => {
      btn.click(); // → asc
    });
    expect(ariaSortFor(handle.container, "7d")).toBe("ascending");

    act(() => {
      btn.click(); // → desc again
    });
    expect(ariaSortFor(handle.container, "7d")).toBe("descending");
    // And rows are back to bigger-first order.
    const names = poolNamesInOrder(handle.container);
    expect(names[0]).toContain("0xbbbb");
    expect(names[1]).toContain("0xaaaa");
  });

  it("clicking a different column resets to defaultDir (desc) and updates aria-sort", () => {
    handle = renderInteractive([twoPoolNetwork()]);
    // Initially fees7d is descending.
    expect(ariaSortFor(handle.container, "7d")).toBe("descending");
    expect(ariaSortFor(handle.container, "24h")).toBe("none");

    act(() => {
      headerButton(handle!.container, "24h").click();
    });

    // 24h becomes the active column, defaults to descending; 7d goes back to none.
    expect(ariaSortFor(handle.container, "24h")).toBe("descending");
    expect(ariaSortFor(handle.container, "7d")).toBe("none");
    // Same data magnitude order in 24h ⇒ Pool B still first.
    const names = poolNamesInOrder(handle.container);
    expect(names[0]).toContain("0xbbbb");
    expect(names[1]).toContain("0xaaaa");
  });

  it("clicking the Pool (string) header sorts by display name desc → asc", () => {
    handle = renderInteractive([twoPoolNetwork()]);
    // Pool labels are empty in this fixture, so display = truncateAddress(addr).
    // Truncated forms: "0xaaaa…0001" and "0xbbbb…0002". Local-compare on those.
    act(() => {
      headerButton(handle!.container, "Pool").click();
    });
    // First click → defaultDir = desc → "0xbbbb…0002" first (lexicographic high).
    expect(ariaSortFor(handle.container, "Pool")).toBe("descending");
    let names = poolNamesInOrder(handle.container);
    expect(names[0]).toContain("0xbbbb");
    expect(names[1]).toContain("0xaaaa");

    act(() => {
      headerButton(handle!.container, "Pool").click();
    });
    // Second click toggles to asc → "0xaaaa…0001" first.
    expect(ariaSortFor(handle.container, "Pool")).toBe("ascending");
    names = poolNamesInOrder(handle.container);
    expect(names[0]).toContain("0xaaaa");
    expect(names[1]).toContain("0xbbbb");
  });
});

describe("RevenueByPoolTable — label fallback", () => {
  beforeEach(() => {
    // Each label-fallback test mounts its own jsdom container; nothing to
    // pre-seed beyond the network-level mocks already in place at the top.
  });

  it("renders truncated address (0xaaaa…0001) when poolLabels lookup misses", () => {
    // Default `networkData` builds an empty poolLabels map, so every row's
    // `label` is null and `rowDisplayName` falls back to truncateAddress.
    const html = renderToStaticMarkup(
      <RevenueByPoolTable
        networkData={[networkData([feeSnapshot()])]}
        isLoading={false}
        hasError={false}
      />,
    );
    // truncateAddress: 6-char prefix + U+2026 ellipsis + 4-char suffix.
    // For POOL_ADDR = "0xaaaa…0000…0001" → "0xaaaa…0001".
    expect(html).toContain("0xaaaa…0001");
    // And the un-truncated address must NOT appear in the cell text — this
    // is the whole point of the truncation. (It still appears in the
    // `/pool/<chain>-<addr>` link href, which is fine.)
    const cellMatches = html.match(/>0xaaaa0+1</);
    expect(cellMatches).toBeNull();
  });

  it("renders friendly poolName (e.g. KESm/USDm) when poolLabels has a hit", () => {
    // Sanity-check the other branch of `rowDisplayName` so the fallback test
    // above can't pass via a degenerate truncation everywhere — pin both
    // sides of the conditional.
    const network = networkData([feeSnapshot()]);
    const TOKEN_USDM = "0xusd";
    const TOKEN_KESM = "0xkes";
    network.network.tokenSymbols = {
      [TOKEN_USDM]: "USDm",
      [TOKEN_KESM]: "KESm",
    };
    network.poolLabels = new Map([
      [
        POOL_ADDR,
        {
          id: `${CHAIN}-${POOL_ADDR}`,
          token0: TOKEN_KESM,
          token1: TOKEN_USDM,
          source: "fpmm_factory",
        },
      ],
    ]);
    const html = renderToStaticMarkup(
      <RevenueByPoolTable
        networkData={[network]}
        isLoading={false}
        hasError={false}
      />,
    );
    // poolName puts USDm last, so the display string is "KESm/USDm".
    expect(html).toContain("KESm/USDm");
    // Truncated form must NOT show — the friendly name took priority.
    expect(html).not.toContain("0xaaaa…0001");
  });
});
