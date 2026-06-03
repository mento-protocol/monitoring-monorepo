/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CdpCollateral,
  CdpDepositor,
  CdpInstance,
  CdpPoolRow,
  CdpTrove,
  CdpTroveListRow,
} from "../../../_lib/types";

const mockUseGQL = vi.hoisted(() => vi.fn());
const networkState = vi.hoisted(() => ({
  network: {
    id: "celo-mainnet",
    label: "Celo",
    chainId: 42220,
    hasuraUrl: "https://example.com/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://celoscan.io",
    tokenSymbols: {},
    addressLabels: {},
    contractsNamespace: null,
    local: false,
    testnet: false,
    hasVirtualPools: true,
  },
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: networkState.network,
    networkId: networkState.network.id,
  }),
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
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

vi.mock("@/components/address-link", () => ({
  AddressLink: ({
    address,
    chainId,
  }: {
    address: string;
    chainId?: number;
  }) => (
    <a href={`mock-address://${chainId ?? "default"}/${address}`}>{address}</a>
  ),
}));

vi.mock("../cdp-stability-pool-tvl-chart", () => ({
  CdpStabilityPoolTvlChart: ({
    isLoading,
    hasError,
  }: {
    isLoading: boolean;
    hasError: boolean;
  }) => (
    <div data-testid="sp-chart">
      chart loading={String(isLoading)} error={String(hasError)}
    </div>
  ),
}));

vi.mock("../cdp-transactions-table", () => ({
  CdpTransactionsTable: ({
    instanceId,
    symbol,
  }: {
    instanceId: string;
    symbol: string;
  }) => (
    <div data-testid="cdp-transactions">
      transactions {instanceId} {symbol}
    </div>
  ),
}));

import {
  CDP_INSTANCE_DAILY_SNAPSHOTS,
  CDP_MARKET_DETAIL,
  CDP_MARKETS,
} from "@/lib/queries";
import { CdpDetailClient } from "../cdp-detail-client";

const USD_WEI = BigInt(10) ** BigInt(18);
const NOW = 1_767_225_600;

function wei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function collateral(overrides: Partial<CdpCollateral> = {}): CdpCollateral {
  return {
    id: "gbpm",
    chainId: 42220,
    collIndex: 0,
    symbol: "GBPm",
    debtToken: "0xdebt",
    collToken: "0xcoll",
    troveManager: "0xtrove",
    stabilityPool: "0xstability",
    minDebt: wei(100),
    minBoldInSp: wei(1),
    systemParamsLoaded: true,
    mcrBps: 11_000,
    ccrBps: 15_000,
    scrBps: 11_000,
    ...overrides,
  };
}

function instance(overrides: Partial<CdpInstance> = {}): CdpInstance {
  return {
    id: "gbpm",
    collateralId: "gbpm",
    chainId: 42220,
    systemColl: wei(1_000),
    systemDebt: wei(500),
    tcrBps: 20_000,
    spDeposits: "0",
    spColl: "0",
    spHeadroom: "0",
    currentRedemptionRateBps: 0,
    activeTroveCount: 1,
    icrP1Bps: -1,
    icrP5Bps: -1,
    icrP50Bps: -1,
    icrFracBelowMcrBps: -1,
    liqCountCum: 0,
    redemptionCountCum: 10,
    redemptionDebtCum: wei(10),
    redemptionFeeCum: "0",
    rebalanceRedemptionCountCum: 3,
    rebalanceRedemptionDebtCum: wei(3),
    rebalanceRedemptionFeeCum: "0",
    borrowingFeeCum: "0",
    isShutDown: false,
    shutDownAt: null,
    shutDownTcrBps: null,
    lastEventBlock: "100",
    lastEventTimestamp: String(NOW),
    ...overrides,
  };
}

function trove(overrides: Partial<CdpTrove> = {}): CdpTrove {
  return {
    id: "trove-1",
    troveId: "1",
    owner: "0xowner",
    status: "active",
    debt: wei(50),
    coll: wei(100),
    icrBps: 20_000,
    interestRate: "0",
    interestBatchId: null,
    lastUpdatedAt: String(NOW),
    redemptionCount: 0,
    redeemedDebt: "0",
    redeemedColl: "0",
    ...overrides,
  };
}

function depositor(overrides: Partial<CdpDepositor> = {}): CdpDepositor {
  return {
    id: "dep-1",
    address: "0xdepositor",
    lastTouchedDeposit: wei(25),
    stashedColl: wei(1),
    lastUpdatedAt: String(NOW),
    cumulativeDeposited: wei(25),
    cumulativeWithdrawn: "0",
    yieldGainClaimedCum: "0",
    ethGainClaimedCum: "0",
    ...overrides,
  };
}

function cdpPool(overrides: Partial<CdpPoolRow> = {}): CdpPoolRow {
  return {
    id: "cdp-pool-1",
    poolId: "42220-0xpool",
    debtToken: "0xdebt",
    strategyAddress: "0xstrategy",
    rebalanceCooldownSec: 120,
    addedAtTimestamp: String(NOW - 100),
    updatedAtTimestamp: String(NOW),
    ...overrides,
  };
}

function marketsData(troves: CdpTroveListRow[] = []) {
  return {
    LiquityCollateral: [collateral()],
    LiquityInstance: [instance()],
    Trove: troves,
  };
}

function detailData({
  troves = [trove()],
  depositors = [depositor()],
  cdpPools = [cdpPool()],
}: {
  troves?: CdpTrove[];
  depositors?: CdpDepositor[];
  cdpPools?: CdpPoolRow[];
} = {}) {
  return {
    LiquityCollateral: [collateral()],
    LiquityInstance: [instance()],
    Trove: troves,
    StabilityPoolDepositor: depositors,
    CdpPool: cdpPools,
  };
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(handle: Handle, symbol = "GBPm") {
  act(() => {
    handle.root.render(<CdpDetailClient symbol={symbol} />);
  });
}

function teardown(handle: Handle | null) {
  if (!handle) return;
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

describe("CdpDetailClient", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.clearAllMocks();
    networkState.network = { ...networkState.network, chainId: 42220 };
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return {
          data: marketsData([
            { id: "t1", collateralId: "gbpm", status: "active" },
            { id: "t2", collateralId: "gbpm", status: "zombie" },
          ]),
          error: null,
          isLoading: false,
        };
      }
      if (query === CDP_MARKET_DETAIL) {
        return { data: detailData(), error: null, isLoading: false };
      }
      if (query === CDP_INSTANCE_DAILY_SNAPSHOTS) {
        return {
          data: { LiquityInstanceDailySnapshot: [] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    handle = setup();
  });

  afterEach(() => {
    teardown(handle);
    handle = null;
    vi.useRealTimers();
  });

  it("renders detail KPIs, health, redemption split, linked pools, and child tables", () => {
    render(handle!);

    expect(handle!.container.textContent).toContain("GBPm CDP Market");
    expect(handle!.container.textContent).toContain("Critical");
    expect(handle!.container.textContent).toContain("Open Troves");
    expect(handle!.container.textContent).toContain("2");
    expect(handle!.container.textContent).toContain("Total Redemptions");
    expect(handle!.container.textContent).toContain("10 events");
    expect(handle!.container.textContent).toContain("7 events");
    expect(handle!.container.textContent).toContain("3 events");
    expect(handle!.container.textContent).toContain("Recent Live Troves");
    expect(handle!.container.textContent).toContain("0xowner");
    expect(handle!.container.textContent).toContain("Last-Touched Depositors");
    expect(handle!.container.textContent).toContain("0xdepositor");
    expect(handle!.container.textContent).toContain("CDP Pools");
    expect(
      handle!.container.querySelector('[data-testid="sp-chart"]'),
    ).not.toBeNull();
    expect(
      handle!.container.querySelector('[data-testid="cdp-transactions"]')
        ?.textContent,
    ).toContain("transactions gbpm GBPm");
  });

  it("renders empty detail tables without replacing market-level KPIs", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return {
          data: marketsData([
            { id: "t1", collateralId: "gbpm", status: "active" },
          ]),
          error: null,
          isLoading: false,
        };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: detailData({ troves: [], depositors: [], cdpPools: [] }),
          error: null,
          isLoading: false,
        };
      }
      if (query === CDP_INSTANCE_DAILY_SNAPSHOTS) {
        return {
          data: { LiquityInstanceDailySnapshot: [] },
          error: new Error("snapshot lag"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(handle!);

    expect(handle!.container.textContent).toContain("GBPm CDP Market");
    expect(handle!.container.textContent).toContain("No troves indexed yet.");
    expect(handle!.container.textContent).toContain(
      "No stability pool depositors indexed yet.",
    );
    expect(handle!.container.textContent).toContain(
      "No active FPMM pools linked to this CDP market.",
    );
    expect(
      handle!.container.querySelector('[data-testid="sp-chart"]')?.textContent,
    ).toContain("error=true");
  });

  it("handles unknown symbols and detail query errors", () => {
    render(handle!, "ZZZm");
    expect(handle!.container.textContent).toContain("Unknown CDP market.");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: undefined,
          error: new Error("detail unavailable"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!, "GBPm");
    expect(
      handle!.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Failed to load CDP market");
  });
});
