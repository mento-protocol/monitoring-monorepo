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
  CdpInterestBatch,
  CdpInstance,
  CdpPoolRow,
  CdpTrove,
  CdpTroveListRow,
} from "../../../_lib/types";
import { CDP_TROVES_DETAIL_LIMIT } from "../../../_lib/types";

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
  CDP_MARKET_DETAIL_WITH_TROVE_TX,
  CDP_MARKETS,
  CDP_TROVE_SCHEMA_FIELDS,
} from "@/lib/queries";
import { CdpDetailClient } from "../cdp-detail-client";

const USD_WEI = BigInt(10) ** BigInt(18);
const NOW = 1_767_225_600;

function wei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function rateBps(bps: number): string {
  return ((BigInt(bps) * USD_WEI) / BigInt(10_000)).toString();
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
    minBoldAfterRebalance: wei(5_000),
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
    previousOwner: "0xpreviousowner",
    status: "active",
    debt: wei(50),
    coll: wei(100),
    icrBps: 20_000,
    interestRate: "0",
    interestBatchId: null,
    openedAt: String(NOW - 100),
    openedTxHash: "0xopened",
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: String(NOW),
    lastUpdatedTxHash: "0xupdated",
    liquidatedDebt: null,
    liquidatedColl: null,
    collSurplus: null,
    priceAtLiquidation: null,
    redemptionCount: 0,
    redeemedDebt: "0",
    redeemedColl: "0",
    redemptionFeePaidCum: "0",
    ...overrides,
  };
}

function interestBatch(
  overrides: Partial<CdpInterestBatch> = {},
): CdpInterestBatch {
  return {
    id: "batch-1",
    collateralId: "gbpm",
    batchManager: "0xbatchmanager",
    annualInterestRate: rateBps(200),
    updatedAt: String(NOW),
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

function troveSchemaData(hasLastUpdatedTxHash = true) {
  return {
    __type: {
      fields: [
        { name: "id" },
        { name: "lastUpdatedAt" },
        ...(hasLastUpdatedTxHash ? [{ name: "lastUpdatedTxHash" }] : []),
      ],
    },
  };
}

function detailData({
  openTroves = [trove()],
  allTroves = openTroves,
  interestBatches = [],
  depositors = [depositor()],
  cdpPools = [cdpPool()],
}: {
  openTroves?: CdpTrove[];
  allTroves?: CdpTrove[];
  interestBatches?: CdpInterestBatch[];
  depositors?: CdpDepositor[];
  cdpPools?: CdpPoolRow[];
} = {}) {
  return {
    LiquityCollateral: [collateral()],
    LiquityInstance: [instance()],
    OpenTrove: openTroves,
    AllTrove: allTroves,
    InterestBatch: interestBatches,
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

function troveRowText(handle: Handle): string[] {
  return Array.from(
    handle.container.querySelectorAll('table[aria-label^="GBPm "] tbody tr'),
  ).map((row) => row.textContent ?? "");
}

function clickButton(handle: Handle, label: string) {
  const button = Array.from(handle.container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  act(() => {
    button.click();
  });
}

function searchTroves(handle: Handle, value: string) {
  const input = handle.container.querySelector("#cdp-trove-search");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Trove search input not found");
  }
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setValue == null) {
    throw new Error("Native input value setter not found");
  }
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: troveSchemaData(), error: null, isLoading: false };
      }
      if (
        query === CDP_MARKET_DETAIL ||
        query === CDP_MARKET_DETAIL_WITH_TROVE_TX
      ) {
        return {
          data: detailData({
            openTroves: [trove({ interestRate: rateBps(250) })],
          }),
          error: null,
          isLoading: false,
        };
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
    expect(handle!.container.textContent).toContain("Troves");
    expect(handle!.container.textContent).not.toContain("Recent Live Troves");
    expect(handle!.container.textContent).toContain("0xowner");
    expect(handle!.container.textContent).toContain("2.50%");
    expect(handle!.container.textContent).toContain("200.00%");
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

  it("links trove IDs to the Mento app without a hash prefix", () => {
    const troveId =
      "0x5f23a9b8f4c249163a0d7969d2fc23af8de9e84d3f63b44136bfd18ea3e73ac4";
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: detailData({
            openTroves: [trove({ troveId })],
            depositors: [],
            cdpPools: [],
          }),
          error: null,
          isLoading: false,
        };
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

    render(handle!);

    const link = handle!.container.querySelector<HTMLAnchorElement>(
      `a[href="https://app.mento.org/borrow/manage/${troveId}?token=GBPm"]`,
    );
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe(troveId);
    expect(link?.textContent).not.toContain("#");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
  });

  it("explains indexed ICR freshness and timestamps each displayed value", () => {
    render(handle!);

    const infoTrigger = handle!.container.querySelector<HTMLElement>(
      '[aria-label="About indexed ICR"]',
    );
    expect(infoTrigger).not.toBeNull();
    expect(infoTrigger?.getAttribute("title")).toBeNull();

    const infoTooltipId = infoTrigger?.getAttribute("aria-describedby");
    expect(infoTooltipId).toBeTruthy();
    expect(
      handle!.container.ownerDocument.getElementById(infoTooltipId!)
        ?.textContent,
    ).toContain("Individual Collateral Ratio");

    const icrValue = handle!.container.querySelector<HTMLSpanElement>(
      'table[aria-label="GBPm troves"] tbody tr td:nth-child(6) [aria-describedby] > span',
    );
    expect(icrValue?.textContent).toBe("200.00%");
    const icrTrigger = handle!.container.querySelector<HTMLElement>(
      'table[aria-label="GBPm troves"] tbody tr td:nth-child(6) [aria-describedby]',
    );
    const icrTooltipId = icrTrigger?.getAttribute("aria-describedby");
    expect(icrTrigger?.getAttribute("title")).toBeNull();
    expect(
      handle!.container.ownerDocument.getElementById(icrTooltipId!)
        ?.textContent,
    ).toBe(
      `Indexed ICR as of ${new Date(NOW * 1000).toLocaleString()}.\nNot a live RPC or oracle read.`,
    );
  });

  it("links updated timestamps to their updating transaction", () => {
    render(handle!);

    const link = handle!.container.querySelector<HTMLAnchorElement>(
      'table[aria-label="GBPm troves"] tbody tr td:nth-child(8) a',
    );
    expect(link).not.toBeNull();
    expect(link?.href).toBe("https://celoscan.io/tx/0xupdated");
    expect(link?.textContent).toBe("0s ago");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(link?.getAttribute("title")).toBeNull();

    const tooltipId = link?.getAttribute("aria-describedby");
    expect(tooltipId).toBeTruthy();
    expect(
      handle!.container.ownerDocument.getElementById(tooltipId!)?.textContent,
    ).toContain("Opens transaction 0xupdated");
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
          data: detailData({
            openTroves: [],
            allTroves: [],
            depositors: [],
            cdpPools: [],
          }),
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
    expect(handle!.container.textContent).toContain(
      "No open troves indexed yet.",
    );
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

  it("sorts open troves by effective interest rate and marks tied rate ranks", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        const lowDirect = trove({
          id: "trove-low-direct",
          troveId: "2",
          owner: "0xlowdirect",
          interestRate: rateBps(200),
        });
        const lowBatch = trove({
          id: "trove-low-batch",
          troveId: "3",
          owner: "0xlowbatch",
          interestRate: "0",
          interestBatchId: "batch-low",
        });
        const higher = trove({
          id: "trove-higher",
          troveId: "1",
          owner: "0xhigher",
          interestRate: rateBps(300),
        });
        return {
          data: detailData({
            openTroves: [higher, lowBatch, lowDirect],
            interestBatches: [
              interestBatch({
                id: "batch-low",
                annualInterestRate: rateBps(200),
              }),
            ],
            depositors: [],
            cdpPools: [],
          }),
          error: null,
          isLoading: false,
        };
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

    render(handle!);

    const rows = troveRowText(handle!);
    expect(rows[0]).toContain("0xlowdirect");
    expect(rows[0]).toContain("#1");
    expect(rows[0]).toContain("tie");
    expect(rows[1]).toContain("0xlowbatch");
    expect(rows[1]).toContain("#1");
    expect(rows[1]).toContain("Batch");
    expect(rows[2]).toContain("0xhigher");
    expect(rows[2]).toContain("#2");
  });

  it("does not rank missing batch troves by their stale direct rate", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: detailData({
            openTroves: [
              trove({
                id: "trove-missing-batch",
                troveId: "1",
                owner: "0xmissingbatch",
                interestRate: "0",
                interestBatchId: "missing-batch",
              }),
              trove({
                id: "trove-higher",
                troveId: "2",
                owner: "0xhigher",
                interestRate: rateBps(300),
              }),
              trove({
                id: "trove-low-direct",
                troveId: "3",
                owner: "0xlowdirect",
                interestRate: rateBps(200),
              }),
            ],
            interestBatches: [],
            depositors: [],
            cdpPools: [],
          }),
          error: null,
          isLoading: false,
        };
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

    render(handle!);

    const rows = troveRowText(handle!);
    expect(rows[0]).toContain("0xlowdirect");
    expect(rows[0]).toContain("#1");
    expect(rows[1]).toContain("0xhigher");
    expect(rows[1]).toContain("#2");
    expect(rows[2]).toContain("0xmissingbatch");
    expect(rows[2]).toContain("Batch missing");
    const renderedRows = handle!.container.querySelectorAll(
      'table[aria-label="GBPm troves"] tbody tr',
    );
    expect(renderedRows[2]?.querySelector("td")?.textContent).toBe("—");
  });

  it("searches fetched troves by owner or trove id", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: detailData({
            openTroves: [
              trove({ id: "trove-1", troveId: "1", owner: "0xfirst" }),
              trove({ id: "trove-2", troveId: "42", owner: "0xsecond" }),
            ],
            depositors: [],
            cdpPools: [],
          }),
          error: null,
          isLoading: false,
        };
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

    render(handle!);
    searchTroves(handle!, "42");

    const rows = troveRowText(handle!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("0xsecond");
    expect(rows[0]).not.toContain("0xfirst");
  });

  it("shows historical troves in the History view", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: detailData({
            openTroves: [
              trove({ id: "trove-open", owner: "0xopen", status: "active" }),
              trove({
                id: "trove-zombie",
                owner: "0xzombie",
                status: "zombie",
              }),
            ],
            allTroves: [
              trove({
                id: "trove-closed",
                owner: "0x0000000000000000000000000000000000000000",
                previousOwner: "0xlastowner",
                status: "redeemed",
                openedAt: String(NOW - 200),
                openedTxHash: "0xstarthistory",
                closedAt: String(NOW - 100),
                closedTxHash: "0xclosedhistory",
                redeemedDebt: wei(12),
                redemptionCount: 2,
                redemptionFeePaidCum: wei(3),
              }),
              trove({ id: "trove-open", owner: "0xopen", status: "active" }),
              trove({
                id: "trove-zombie",
                owner: "0xzombie",
                status: "zombie",
              }),
            ],
            depositors: [],
            cdpPools: [],
          }),
          error: null,
          isLoading: false,
        };
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

    render(handle!);
    expect(troveRowText(handle!).join(" ")).not.toContain("0xclosed");

    clickButton(handle!, "History");

    const headers = Array.from(
      handle!.container.querySelectorAll('table[aria-label="GBPm troves"] th'),
    ).map((header) => header.textContent);
    expect(headers).toEqual([
      "Last owner / Trove",
      "Status",
      "Opened",
      "Ended / Updated",
      "Remaining collateral",
      "Redeemed",
      "Redemption fee",
      "Liquidated",
    ]);
    expect(headers).not.toContain("Rank");
    expect(headers).not.toContain("ICR (indexed)");

    const historyRows = troveRowText(handle!);
    expect(historyRows).toHaveLength(1);
    expect(historyRows.join(" ")).toContain("0xlastowner");
    expect(historyRows.join(" ")).not.toContain(
      "0x0000000000000000000000000000000000000000",
    );
    expect(historyRows.join(" ")).toContain("redeemed");
    expect(historyRows.join(" ")).toContain("12.00 GBPm");
    expect(historyRows.join(" ")).toContain("2 events");
    expect(historyRows.join(" ")).toContain("3.00 USDm");
    expect(historyRows.join(" ")).not.toContain("0xopen");
    expect(historyRows.join(" ")).not.toContain("0xzombie");

    const historyLinks = Array.from(
      handle!.container.querySelectorAll<HTMLAnchorElement>(
        'table[aria-label="GBPm troves"] a',
      ),
    ).map((link) => link.href);
    expect(historyLinks).toContain("https://celoscan.io/tx/0xstarthistory");
    expect(historyLinks).toContain("https://celoscan.io/tx/0xclosedhistory");
  });

  it("renders liquidated outcomes in the history table", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: detailData({
            openTroves: [
              trove({ id: "trove-open", owner: "0xopen", status: "active" }),
            ],
            allTroves: [
              trove({
                id: "trove-liquidated",
                owner: "0x0000000000000000000000000000000000000000",
                previousOwner: "0xliquidatedowner",
                status: "liquidated",
                closedAt: String(NOW - 60),
                closedTxHash: "0xliquidated",
                liquidatedDebt: wei(7),
                liquidatedColl: wei(9),
              }),
            ],
            depositors: [],
            cdpPools: [],
          }),
          error: null,
          isLoading: false,
        };
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

    render(handle!);
    clickButton(handle!, "History");

    const rows = troveRowText(handle!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("0xliquidatedowner");
    expect(rows[0]).toContain("liquidated");
    expect(rows[0]).toContain("7.00 GBPm");
    expect(rows[0]).toContain("9.00 USDm");
  });

  it("discloses when the active trove fetch reaches the hosted row cap", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_MARKET_DETAIL) {
        return {
          data: detailData({
            openTroves: Array.from(
              { length: CDP_TROVES_DETAIL_LIMIT },
              (_, i) =>
                trove({
                  id: `trove-${i}`,
                  troveId: String(i + 1),
                  owner:
                    i === 0
                      ? "0xhigherdirect"
                      : i === 1
                        ? "0xlowbatch"
                        : `0x${String(i).padStart(40, "0")}`,
                  interestRate:
                    i === 0 ? rateBps(300) : i === 1 ? "0" : rateBps(500),
                  interestBatchId: i === 1 ? "batch-low" : null,
                }),
            ),
            interestBatches: [
              interestBatch({
                id: "batch-low",
                annualInterestRate: rateBps(200),
              }),
            ],
            depositors: [],
            cdpPools: [],
          }),
          error: null,
          isLoading: false,
        };
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

    render(handle!);

    expect(handle!.container.textContent).toContain(
      "Showing 1,000 fetched troves",
    );
    expect(handle!.container.textContent).toContain(
      "Redemption ranks are hidden because the full open-trove set is not loaded.",
    );
    const rows = troveRowText(handle!);
    expect(rows[0]).toContain("0xlowbatch");
    expect(rows[0]).toContain("Batch");
    expect(rows[1]).toContain("0xhigherdirect");
    const firstRankCell = handle!.container.querySelector("tbody tr td");
    expect(firstRankCell?.textContent).toBe("—");
    expect(handle!.container.textContent).toContain("1,000 total");
  });
});
