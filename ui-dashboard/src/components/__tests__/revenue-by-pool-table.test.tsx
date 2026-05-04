/**
 * Tests for the per-chain truncation badge on the All-time column of
 * `RevenueByPoolTable`. Covers all four combinations of (chainTruncated,
 * unpriced) per-row state:
 *
 *   1. truncated + unpriced   → ≈ with unpriced tooltip (unpriced wins)
 *   2. truncated + not unpriced → ≈ with truncation tooltip
 *   3. not truncated + unpriced → ≈ with unpriced tooltip
 *   4. neither              → no ≈ on any column
 *
 * Uses `renderToStaticMarkup` (server-side render, no jsdom) since we only
 * inspect the static HTML output. Mocks are limited to what's strictly
 * required for the import chain to resolve.
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
    expect(cells.feesAll).toContain("1000-row query cap");
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

  it("truncation does not affect recent windows (24h/7d/30d) even when chain is truncated", () => {
    // All transfers are priced USDm — old timestamps (outside all windows).
    // We have PROTOCOL_FEE_QUERY_LIMIT transfers to simulate a truncated chain.
    const transfers = Array.from({ length: PROTOCOL_FEE_QUERY_LIMIT }, () =>
      transfer(),
    );
    // isTruncated=true because we hit the cap
    const cells = renderFeeCells([networkData(transfers, feeSummary(true))]);

    // All-time should be ≈
    expect(cells.feesAll).toContain("≈");
    // Recent windows must NOT be ≈ (no unpriced transfers, cap only clips history)
    expect(cells.fees24h).not.toContain("≈");
    expect(cells.fees7d).not.toContain("≈");
    expect(cells.fees30d).not.toContain("≈");
  });
});
