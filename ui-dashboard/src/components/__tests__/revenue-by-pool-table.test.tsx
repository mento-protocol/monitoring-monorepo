/**
 * Tests for the per-chain truncation badge on `RevenueByPoolTable`.
 * Truncation is now per-window: a window is flagged when the chain hit the
 * row cap AND the oldest returned transfer's timestamp is younger than the
 * window's lower bound (i.e. the cap clipped data inside the window).
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/lib/fetch-all-networks";
import type { ProtocolFeeTransfer } from "@/lib/types";
import type { ProtocolFeeSummary } from "@/lib/protocol-fees";
import { PROTOCOL_FEE_QUERY_LIMIT } from "@/lib/protocol-fees";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before SUT import.
// ---------------------------------------------------------------------------

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

/** Build a minimal ProtocolFeeTransfer. */
function transfer(
  overrides: Partial<ProtocolFeeTransfer> = {},
): ProtocolFeeTransfer {
  return {
    chainId: 42220,
    tokenSymbol: "USDm",
    tokenDecimals: 18,
    amount: "1000000000000000000", // 1 USDm
    blockTimestamp: "100", // old — outside all windows
    from: POOL_ADDR,
    ...overrides,
  };
}

/** Build a minimal ProtocolFeeSummary — only `isTruncated` is load-bearing. */
function feeSummary(isTruncated: boolean): ProtocolFeeSummary {
  return {
    totalFeesUSD: 1,
    fees24hUSD: 0,
    fees7dUSD: 0,
    fees30dUSD: 0,
    unpricedSymbols: [],
    unpricedSymbols24h: [],
    unresolvedCount: 0,
    unresolvedCount24h: 0,
    isTruncated,
  };
}

/** Build a minimal NetworkData stub. */
function networkData(
  transfers: ProtocolFeeTransfer[],
  fees: ProtocolFeeSummary | null = null,
): NetworkData {
  return {
    network: {
      id: "celo-mainnet",
      chainId: 42220,
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
    fees,
    feeTransfers: transfers,
    poolLabels: new Map(),
    uniqueLpAddresses: null,
    rates: new Map([["USDm", 1]]),
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

// ---------------------------------------------------------------------------
// approxAnnotation — four combinations via rendered output
// ---------------------------------------------------------------------------

describe("RevenueByPoolTable — per-chain truncation badge", () => {
  it("(truncated + unpriced): All-time shows ≈ with unpriced tooltip (unpriced wins)", () => {
    // Transfer with an unpriced symbol so the row has unpriced=true, and
    // isTruncated=true on the chain summary.
    const transfers = [
      transfer({ tokenSymbol: "MYSTERY" }), // unpriced (all-time window)
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);

    expect(cells.feesAll).toContain("≈");
    expect(cells.feesAll).toContain("unpriced/unknown tokens");
    // Recent windows are not marked (old timestamp, outside all windows)
    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
  });

  it("(truncated + not unpriced): All-time shows ≈ with truncation tooltip", () => {
    const transfers = [
      transfer(), // USDm — priced; old timestamp
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);

    expect(cells.feesAll).toContain("≈");
    expect(cells.feesAll).toContain("query cap");
    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
  });

  it("(not truncated + unpriced): All-time shows ≈ with unpriced tooltip", () => {
    const transfers = [
      transfer({ tokenSymbol: "MYSTERY" }), // unpriced all-time
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(false))]);

    expect(cells.feesAll).toContain("≈");
    expect(cells.feesAll).toContain("unpriced/unknown tokens");
    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
  });

  it("(not truncated + not unpriced): no ≈ on any column", () => {
    const transfers = [
      transfer(), // USDm — priced; old timestamp
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(false))]);

    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
    expect(cells.feesAll).not.toContain("≈");
  });

  // -----------------------------------------------------------------------
  // Per-window truncation — the badge is driven by whether the oldest
  // returned transfer predates each window boundary.
  // -----------------------------------------------------------------------

  const NOW_S = Math.floor(Date.now() / 1000);

  it("capped chain whose oldest returned transfer predates 30d → only All-time is truncated", () => {
    // Newest transfer is recent; oldest is well outside 30d. Chain is capped
    // (more transfers exist beyond the oldest returned one), but the cap did
    // NOT clip data inside any of the 24h/7d/30d windows because we already
    // see history older than 30d.
    const transfers = [
      transfer({ blockTimestamp: String(NOW_S - 60) }), // newest, inside 24h
      transfer({ blockTimestamp: String(NOW_S - 60 * 86400) }), // oldest, > 30d
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);

    expect(cells.feesAll).toContain("≈");
    expect(cells.feesAll).toContain("query cap");
    expect(cells.fees30d).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees24h).not.toContain("≈");
  });

  it("capped chain whose oldest returned transfer is inside 30d → 30d + All-time truncated, 24h/7d clean", () => {
    // Oldest returned is 14 days ago — outside 7d/24h, inside 30d. Cap
    // clipped data older than 14 days, so 30d total is a lower bound; 7d
    // and 24h are unaffected.
    const transfers = [
      transfer({ blockTimestamp: String(NOW_S - 60) }), // newest, inside 24h
      transfer({ blockTimestamp: String(NOW_S - 14 * 86400) }), // oldest, in 30d
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);

    expect(cells.fees30d).toContain("≈");
    expect(cells.fees30d).toContain("query cap");
    expect(cells.feesAll).toContain("≈");
    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
  });

  it("capped chain whose oldest returned transfer is inside 7d → 7d + 30d + All-time truncated, 24h clean", () => {
    const transfers = [
      transfer({ blockTimestamp: String(NOW_S - 60) }), // newest, inside 24h
      transfer({ blockTimestamp: String(NOW_S - 3 * 86400) }), // oldest, in 7d
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);

    expect(cells.fees7d).toContain("≈");
    expect(cells.fees30d).toContain("≈");
    expect(cells.feesAll).toContain("≈");
    expect(cells.fees24h).not.toContain("≈");
  });

  it("capped chain whose oldest returned transfer is inside 24h → every window truncated", () => {
    // Extreme case: chain is doing >1000 transfers/day. Cap clipped data
    // inside every window we display.
    const transfers = [
      transfer({ blockTimestamp: String(NOW_S - 60) }), // newest
      transfer({ blockTimestamp: String(NOW_S - 3600) }), // oldest, 1h ago
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);

    expect(cells.fees24h).toContain("≈");
    expect(cells.fees7d).toContain("≈");
    expect(cells.fees30d).toContain("≈");
    expect(cells.feesAll).toContain("≈");
  });

  it("not-capped chain ignores oldest-timestamp regardless of how recent it is", () => {
    // Even if all returned transfers are inside 24h, when the chain's
    // ProtocolFeeSummary.isTruncated is false we trust the full history is
    // present; no truncation badge anywhere.
    const transfers = [
      transfer({ blockTimestamp: String(NOW_S - 60) }),
      transfer({ blockTimestamp: String(NOW_S - 600) }),
    ];
    const cells = renderFeeCells([networkData(transfers, feeSummary(false))]);

    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
    expect(cells.feesAll).not.toContain("≈");
  });

  it("tooltip cap number tracks PROTOCOL_FEE_QUERY_LIMIT", () => {
    const transfers = [transfer()];
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);
    expect(cells.feesAll).toContain(PROTOCOL_FEE_QUERY_LIMIT.toLocaleString());
  });
});
