/**
 * Tests for `RevenueByPoolTable` against the snapshot-based aggregator.
 * Per-window truncation badges (PR #306) were retired in PR-snapshot-2 once
 * the leaderboard switched off raw transfers — snapshot pagination covers
 * all-time history, so the only remaining `≈` flag is genuine pricing gaps
 * (UNKNOWN tokens or missing FX rates).
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
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
    tradingLimits: [],
    olsPoolIds: new Set(),
    cdpPoolIds: new Set(),
    reservePoolIds: new Set(),
    fees: null,
    feeTransfers: [],
    feeSnapshots: snapshots,
    feeSnapshotsError: null,
    poolLabels: new Map(),
    uniqueLpAddresses: null,
    rates: new Map([
      ["USDm", 1],
      ["GBPm", 1.3263],
    ]),
    error: null,
    feesError: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
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

  it("UNKNOWN slot in snapshot flips ≈ across all columns (single per-row flag)", () => {
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

  it("skips chains with feesError so a partial outage doesn't render misleading $0 rows", () => {
    const n = networkData([feeSnapshot()]);
    n.feesError = new Error("boom");
    const html = renderToStaticMarkup(
      <RevenueByPoolTable
        networkData={[n]}
        isLoading={false}
        hasError={true}
      />,
    );
    // No tbody rows — the chain was skipped despite having a snapshot, and the
    // empty shell renders the partial-outage copy gated on hasError.
    expect(html).toMatch(/load per-pool revenue/);
    expect(html).not.toContain(POOL_ADDR);
  });

  it("skips chains with feeSnapshotsError (snapshot fetch failed) without affecting raw-transfer KPIs", () => {
    const n = networkData([feeSnapshot()]);
    n.feeSnapshotsError = new Error("snapshot timeout");
    // Note: `feesError` stays null — only the leaderboard loses its row.
    expect(n.feesError).toBeNull();
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
