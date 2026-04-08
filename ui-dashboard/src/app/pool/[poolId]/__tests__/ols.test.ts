import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  getDebtTokenSideLabel,
  selectActiveOlsPool,
  OlsStatusPanel,
  OlsLiquidityTable,
} from "../page";
import type { OlsLiquidityEvent, OlsPool, Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";

// ---------------------------------------------------------------------------
// Mocks — mirror the pattern in pools/__tests__/page.test.tsx
// ---------------------------------------------------------------------------

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo Mainnet",
      chainId: 42220,
      hasuraUrl: "https://example.com/graphql",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      contractsNamespace: null,
      local: false,
      hasVirtualPools: false,
      testnet: false,
    },
  }),
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) =>
    React.createElement("span", { "data-testid": "address-link" }, address),
}));

vi.mock("@/components/feedback", () => ({
  ErrorBox: ({ message }: { message: string }) =>
    React.createElement("div", { "data-testid": "error-box" }, message),
  Skeleton: () => React.createElement("div", { "data-testid": "skeleton" }),
  EmptyBox: ({ message }: { message: string }) =>
    React.createElement("div", { "data-testid": "empty-box" }, message),
}));

vi.mock("@/components/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) =>
    React.createElement("table", null, children),
  Row: ({ children }: { children: React.ReactNode }) =>
    React.createElement("tr", null, children),
  Td: ({ children }: { children: React.ReactNode }) =>
    React.createElement("td", null, children),
  Th: ({ children }: { children: React.ReactNode }) =>
    React.createElement("th", null, children),
}));

vi.mock("@/components/sender-cell", () => ({
  SenderCell: ({ address }: { address: string }) =>
    React.createElement("td", null, address),
}));

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) =>
    React.createElement("td", null, txHash),
}));

vi.mock("@/lib/tokens", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/tokens")>();
  return {
    ...mod,
    chainId: 42220,

    tokenSymbol: (_network: unknown, address: string | null) =>
      address ? address.slice(0, 6) : "???",
  };
});

vi.mock("@/lib/format", () => ({
  formatTimestamp: (ts: string) => `formatted:${ts}`,
  formatWei: (val: string) => `wei:${val}`,
  relativeTime: (ts: string) => `rel:${ts}`,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "0xpool",
    chainId: 42220,
    source: "fpmm_factory",
    token0: "0x0000000000000000000000000000000000000001",
    token1: "0x0000000000000000000000000000000000000002",
    token0Decimals: 18,
    token1Decimals: 18,
    reserves0: "0",
    reserves1: "0",
    oraclePrice: "0",
    oracleOk: false,
    oracleTimestamp: "0",
    oracleNumReporters: 0,
    oracleExpiry: "0",
    oracleTxHash: "",
    referenceRateFeedID: "",
    priceDifference: "0",
    rebalanceThreshold: 0,
    healthStatus: "healthy",
    limitStatus: "ok",
    limitPressure0: "normal",
    limitPressure1: "normal",
    swapCount: 0,
    rebalanceCount: 0,
    notionalVolume0: "0",
    notionalVolume1: "0",
    createdAtBlock: "0",
    createdAtTimestamp: "0",
    updatedAtBlock: "0",
    updatedAtTimestamp: "0",
    ...overrides,
  };
}

function makeOlsPool(overrides: Partial<OlsPool> = {}): OlsPool {
  return {
    id: "0xpool-0xols",
    chainId: 42220,
    poolId: "0xpool",
    olsAddress: "0x000000000000000000000000000000000000aabb",
    isActive: true,
    debtToken: "0x0000000000000000000000000000000000000001",
    rebalanceCooldown: "3600",
    lastRebalance: "0",
    protocolFeeRecipient: "0x0000000000000000000000000000000000001234",
    liquiditySourceIncentiveExpansion: "1000000000000000",
    liquiditySourceIncentiveContraction: "2000000000000000",
    protocolIncentiveExpansion: "500000000000000",
    protocolIncentiveContraction: "1000000000000000",
    olsRebalanceCount: 5,
    addedAtBlock: "100",
    addedAtTimestamp: "1700000000",
    updatedAtBlock: "200",
    updatedAtTimestamp: "1700001000",
    ...overrides,
  };
}

function makeOlsEvent(
  overrides: Partial<OlsLiquidityEvent> = {},
): OlsLiquidityEvent {
  return {
    id: "evt-1",
    chainId: 42220,
    poolId: "0xpool",
    olsAddress: "0x000000000000000000000000000000000000aabb",
    direction: 0,
    tokenGivenToPool: "0x0000000000000000000000000000000000000001",
    amountGivenToPool: "1000000000000000000",
    tokenTakenFromPool: "0x0000000000000000000000000000000000000002",
    amountTakenFromPool: "990000000000000000",
    caller: "0xdeadbeef",
    txHash: "0xtx1",
    blockNumber: "100",
    blockTimestamp: "1700000000",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getDebtTokenSideLabel
// ---------------------------------------------------------------------------

describe("getDebtTokenSideLabel", () => {
  it("returns token0 when debt token matches token0", () => {
    expect(
      getDebtTokenSideLabel(
        makePool(),
        "0x0000000000000000000000000000000000000001",
      ),
    ).toBe("token0");
  });

  it("returns token1 when debt token matches token1", () => {
    expect(
      getDebtTokenSideLabel(
        makePool(),
        "0x0000000000000000000000000000000000000002",
      ),
    ).toBe("token1");
  });

  it("returns unknown when pool metadata is missing", () => {
    expect(
      getDebtTokenSideLabel(makePool({ token0: null, token1: null }), "0x123"),
    ).toBe("unknown");
  });

  it("returns unknown when debt token does not match either pool token", () => {
    expect(
      getDebtTokenSideLabel(
        makePool(),
        "0x0000000000000000000000000000000000000003",
      ),
    ).toBe("unknown");
  });
});

describe("selectActiveOlsPool", () => {
  it("returns null for empty input", () => {
    expect(selectActiveOlsPool([])).toBeNull();
    expect(selectActiveOlsPool(undefined)).toBeNull();
  });

  it("returns the newest active OLS row when a pool has historical inactive registrations", () => {
    const staleInactive = makeOlsPool({
      id: "0xpool-0xold",
      olsAddress: "0x00000000000000000000000000000000000000aa",
      isActive: false,
      updatedAtTimestamp: "300",
    });
    const currentActive = makeOlsPool({
      id: "0xpool-0xnew",
      olsAddress: "0x00000000000000000000000000000000000000bb",
      isActive: true,
      updatedAtTimestamp: "200",
    });

    expect(selectActiveOlsPool([staleInactive, currentActive])).toEqual(
      currentActive,
    );
  });

  it("prefers the newest active row when multiple active rows are present", () => {
    const olderActive = makeOlsPool({
      id: "0xpool-0xolder",
      olsAddress: "0x00000000000000000000000000000000000000cc",
      isActive: true,
      updatedAtTimestamp: "100",
    });
    const newerActive = makeOlsPool({
      id: "0xpool-0xnewer",
      olsAddress: "0x00000000000000000000000000000000000000dd",
      isActive: true,
      updatedAtTimestamp: "200",
    });

    expect(selectActiveOlsPool([olderActive, newerActive])).toEqual(
      newerActive,
    );
  });

  it("returns null when all registrations are inactive", () => {
    expect(
      selectActiveOlsPool([
        makeOlsPool({ isActive: false, updatedAtTimestamp: "100" }),
      ]),
    ).toBeNull();
  });
});

// vi.mock() is hoisted before imports so it can't reference this const.
// The inline network object in vi.mock("@/components/network-provider") above
// must be a literal duplicate. This const is used for prop-based tests below.
const mockNetwork: Network = {
  id: "celo-mainnet",
  label: "Celo Mainnet",
  chainId: 42220,
  hasuraUrl: "https://example.com/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  contractsNamespace: null,
  local: false,
  hasVirtualPools: false,
  testnet: false,
};

// ---------------------------------------------------------------------------
// OlsStatusPanel
// ---------------------------------------------------------------------------

describe("OlsStatusPanel", () => {
  it("renders key fields with valid data", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsStatusPanel, {
        olsPool: makeOlsPool(),
        pool: makePool(),
        network: mockNetwork,
      }),
    );
    expect(html).toContain("Open Liquidity Strategy");
    expect(html).toContain("Active");
    expect(html).toContain("OLS Rebalances");
    expect(html).toContain("5"); // olsRebalanceCount
    expect(html).toContain("Never"); // lastRebalance=0 → "Never" in Last Rebalance stat
  });

  it("shows 'Ready to rebalance' when cooldown has elapsed", () => {
    const pastTimestamp = String(Math.floor(Date.now() / 1000) - 7200); // 2h ago
    const html = renderToStaticMarkup(
      React.createElement(OlsStatusPanel, {
        olsPool: makeOlsPool({
          lastRebalance: pastTimestamp,
          rebalanceCooldown: "3600",
        }),
        pool: makePool(),
        network: mockNetwork,
      }),
    );
    expect(html).toContain("Ready to rebalance");
  });

  it("shows cooling down status when cooldown is still active", () => {
    const recentTimestamp = String(Math.floor(Date.now() / 1000) - 60); // 1 min ago
    const html = renderToStaticMarkup(
      React.createElement(OlsStatusPanel, {
        olsPool: makeOlsPool({
          lastRebalance: recentTimestamp,
          rebalanceCooldown: "3600",
        }),
        pool: makePool(),
        network: mockNetwork,
      }),
    );
    expect(html).toContain("Cooling down");
  });

  it("shows Removed badge when isActive is false", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsStatusPanel, {
        olsPool: makeOlsPool({ isActive: false }),
        pool: makePool(),
        network: mockNetwork,
      }),
    );
    expect(html).toContain("Removed");
  });

  it("handles null olsPool gracefully (loading/null state)", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsStatusPanel, {
        olsPool: null,
        pool: makePool(),
        network: mockNetwork,
      }),
    );
    expect(html).toContain("not registered with the Open Liquidity Strategy");
  });
});

// ---------------------------------------------------------------------------
// OlsLiquidityTable
// ---------------------------------------------------------------------------

describe("OlsLiquidityTable", () => {
  it("renders Expand badge for direction=0", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsLiquidityTable, {
        events: [makeOlsEvent({ direction: 0 })],
        pool: makePool(),
        network: mockNetwork,
        isLoading: false,
        error: null,
      }),
    );
    expect(html).toContain("EXPAND");
  });

  it("renders Contract badge for direction=1", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsLiquidityTable, {
        events: [makeOlsEvent({ direction: 1 })],
        pool: makePool(),
        network: mockNetwork,
        isLoading: false,
        error: null,
      }),
    );
    expect(html).toContain("CONTRACT");
  });

  it("renders empty state when no events", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsLiquidityTable, {
        events: [],
        pool: makePool(),
        network: mockNetwork,
        isLoading: false,
        error: null,
      }),
    );
    expect(html).toContain("No OLS liquidity events for this pool");
  });

  it("renders loading skeleton when isLoading=true", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsLiquidityTable, {
        events: [],
        pool: makePool(),
        network: mockNetwork,
        isLoading: true,
        error: null,
      }),
    );
    expect(html).toContain("skeleton");
  });

  it("renders error state when error is set", () => {
    const html = renderToStaticMarkup(
      React.createElement(OlsLiquidityTable, {
        events: [],
        pool: makePool(),
        network: mockNetwork,
        isLoading: false,
        error: new Error("query failed"),
      }),
    );
    expect(html).toContain("query failed");
  });
});
