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
  CdpInstance,
  CdpRedemptionEventRow,
  CdpStabilityPoolOperationEventRow,
  CdpTroveListRow,
  CdpTroveOperationEventRow,
  CdpTroveOpSnapshotRow,
} from "../../_lib/types";

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
const mockSearchParams = vi.hoisted(() => ({
  current: new URLSearchParams(),
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

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams.current,
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

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => (
    <td data-testid="tx-hash">{txHash}</td>
  ),
}));

import {
  ALL_CDP_STABILITY_POOL_EVENTS,
  ALL_CDP_TRANSACTIONS,
  ALL_CDP_TROVE_OP_SNAPSHOTS,
  CDP_MARKETS,
} from "@/lib/queries";
import { CdpAllTransactionsTable } from "../cdp-all-transactions-table";
import { CdpsPageClient } from "../cdps-page-client";

const USD_WEI = BigInt(10) ** BigInt(18);
const NOW = 1_767_225_600;

function wei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function negWei(amount: number): string {
  return (-BigInt(amount) * USD_WEI).toString();
}

function collateral(overrides: Partial<CdpCollateral>): CdpCollateral {
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

function instance(overrides: Partial<CdpInstance>): CdpInstance {
  return {
    id: "gbpm",
    collateralId: "gbpm",
    chainId: 42220,
    systemColl: wei(1_000),
    systemDebt: wei(500),
    tcrBps: 20_000,
    spDeposits: wei(0),
    spColl: "0",
    spHeadroom: "0",
    currentRedemptionRateBps: 0,
    activeTroveCount: 1,
    icrP1Bps: -1,
    icrP5Bps: -1,
    icrP50Bps: -1,
    icrFracBelowMcrBps: -1,
    liqCountCum: 0,
    redemptionCountCum: 0,
    redemptionDebtCum: "0",
    redemptionFeeCum: "0",
    rebalanceRedemptionCountCum: 0,
    rebalanceRedemptionDebtCum: "0",
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

function marketData({
  collaterals = [collateral({})],
  instances = [instance({})],
  troves = [
    { id: "t1", collateralId: "gbpm", status: "active" },
    { id: "t2", collateralId: "gbpm", status: "zombie" },
    { id: "t3", collateralId: "gbpm", status: "closedByOwner" },
  ],
}: {
  collaterals?: CdpCollateral[];
  instances?: CdpInstance[];
  troves?: CdpTroveListRow[];
} = {}) {
  return {
    LiquityCollateral: collaterals,
    LiquityInstance: instances,
    Trove: troves,
  };
}

function transactionData() {
  return {
    LiquidationEvent: [
      {
        id: "liq1",
        instanceId: "chfm",
        debtOffsetBySP: wei(1),
        debtRedistributed: "0",
        boldGasCompensation: "0",
        collGasCompensation: "0",
        collSentToSP: wei(2),
        collRedistributed: "0",
        collSurplus: "0",
        priceAtLiquidation: "0",
        timestamp: String(NOW - 20),
        blockNumber: "100",
        txHash: "0xliquidation",
      },
    ],
    RedemptionEvent: [],
    SpRebalanceEvent: [],
    TroveOperationEvent: [
      {
        id: "op1",
        instanceId: "gbpm",
        troveId: "trove-1",
        operation: 0,
        collChange: wei(10),
        debtChange: wei(5),
        annualInterestRate: "0",
        debtIncreaseFromUpfrontFee: "0",
        timestamp: String(NOW - 10),
        blockNumber: "101",
        txHash: "0xtroveop",
      },
    ],
  };
}

function redemptionEvent(
  overrides: Partial<CdpRedemptionEventRow> = {},
): CdpRedemptionEventRow {
  return {
    id: "redemption-1",
    instanceId: "gbpm",
    attemptedBoldAmount: wei(20),
    actualBoldAmount: wei(10),
    ETHSent: wei(10),
    ETHFee: "0",
    price: wei(1),
    redemptionPrice: wei(1),
    isRebalance: false,
    timestamp: String(NOW - 15),
    blockNumber: "102",
    txHash: "0xredemption",
    ...overrides,
  };
}

function troveOperation(
  overrides: Partial<CdpTroveOperationEventRow> = {},
): CdpTroveOperationEventRow {
  return {
    id: "op1",
    instanceId: "gbpm",
    troveId: "trove-1",
    operation: 0,
    collChange: wei(10),
    debtChange: wei(5),
    annualInterestRate: "0",
    debtIncreaseFromUpfrontFee: "0",
    timestamp: String(NOW - 10),
    blockNumber: "101",
    txHash: "0xtroveop",
    ...overrides,
  };
}

function manyTroveOperations(count: number): CdpTroveOperationEventRow[] {
  return Array.from({ length: count }, (_, index) =>
    troveOperation({
      id: `op-${index}`,
      timestamp: String(NOW - index),
      blockNumber: String(1_000 + index),
      txHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    }),
  );
}

function stabilityPoolOperation(
  overrides: Partial<CdpStabilityPoolOperationEventRow> = {},
): CdpStabilityPoolOperationEventRow {
  return {
    id: "sp-op-1",
    instanceId: "gbpm",
    depositor: "0xdepositor",
    operation: 0,
    depositLossSinceLastOperation: "0",
    topUpOrWithdrawal: wei(50),
    yieldGainSinceLastOperation: "0",
    yieldGainClaimed: "0",
    ethGainSinceLastOperation: "0",
    ethGainClaimed: "0",
    depositBefore: wei(100),
    depositAfter: wei(150),
    stashedCollBefore: "0",
    stashedCollAfter: wei(2),
    timestamp: String(NOW - 5),
    blockNumber: "105",
    txHash: "0xspdeposit",
    ...overrides,
  };
}

function snapshotData(rows: CdpTroveOpSnapshotRow[] = []) {
  return { TroveOperationEvent: rows };
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(handle: Handle, node: React.ReactNode) {
  act(() => {
    handle.root.render(<>{node}</>);
  });
}

function teardown(handle: Handle | null) {
  if (!handle) return;
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

function bodyText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll("tbody > tr"))
    .map((row) => row.textContent ?? "")
    .join("\n");
}

function digestRowCells(container: HTMLElement): string[] {
  const row = container.querySelector(
    '[aria-labelledby="cdp-activity-digest-heading"] tbody tr',
  );
  if (!row) throw new Error("Missing CDP activity digest row");
  return Array.from(row.querySelectorAll("td")).map(
    (cell) => cell.textContent?.trim() ?? "",
  );
}

function pill(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="radio"]'),
  ).find((button) => button.textContent?.trim() === label);
  if (!match) throw new Error(`Missing pill ${label}`);
  return match;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setUrl(url: string) {
  window.history.replaceState(window.history.state, "", url);
  mockSearchParams.current = new URLSearchParams(window.location.search);
}

describe("CdpsPageClient", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.clearAllMocks();
    setUrl("/cdps");
    networkState.network = { ...networkState.network, chainId: 42220 };
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
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

  it("gates CDP markets to Celo mainnet", () => {
    networkState.network = { ...networkState.network, chainId: 143 };

    render(handle!, <CdpsPageClient />);

    expect(handle!.container.textContent).toContain(
      "CDP markets are only deployed on Celo mainnet.",
    );
  });

  it("renders loading, error, and empty market states", () => {
    mockUseGQL.mockImplementation((query: string | null) =>
      query === CDP_MARKETS
        ? { data: undefined, error: null, isLoading: true }
        : { data: undefined, error: null, isLoading: false },
    );
    render(handle!, <CdpsPageClient />);
    expect(handle!.container.querySelector('[role="status"]')).not.toBeNull();

    mockUseGQL.mockImplementation((query: string | null) =>
      query === CDP_MARKETS
        ? {
            data: undefined,
            error: new Error("downstream unavailable"),
            isLoading: false,
          }
        : { data: undefined, error: null, isLoading: false },
    );
    render(handle!, <CdpsPageClient />);
    expect(
      handle!.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Failed to load CDP markets");

    mockUseGQL.mockImplementation((query: string | null) =>
      query === CDP_MARKETS
        ? {
            data: marketData({ collaterals: [] }),
            error: null,
            isLoading: false,
          }
        : { data: undefined, error: null, isLoading: false },
    );
    render(handle!, <CdpsPageClient />);
    expect(handle!.container.textContent).toContain(
      "No CDP markets indexed yet.",
    );
  });

  it("renders market cards with health, derived open troves, and transactions", () => {
    render(handle!, <CdpsPageClient />);

    expect(handle!.container.textContent).toContain("GBPm");
    expect(handle!.container.textContent).toContain("Critical");
    expect(handle!.container.textContent).toContain("Open Troves");
    expect(handle!.container.textContent).toContain("2");
    expect(handle!.container.textContent).toContain("24h CDP activity");
    expect(handle!.container.textContent).toContain(
      "Last 24h: 2 operations · 1 liquidation · 0 redemptions",
    );
    expect(handle!.container.textContent).toContain("Recent CDP Transactions");
    expect(bodyText(handle!.container)).toContain("Open Trove");
  });

  it("keeps unavailable activity out of per-market digest cells", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: undefined, error: null, isLoading: true };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(handle!, <CdpsPageClient />);

    expect(handle!.container.textContent).toContain(
      "Last 24h: activity unavailable",
    );
    expect(digestRowCells(handle!.container).slice(2, 6)).toEqual([
      "—",
      "—",
      "—",
      "—",
    ]);
  });

  it("keeps cached activity visible during background activity errors", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: transactionData(),
          error: new Error("background poll failed"),
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(handle!, <CdpsPageClient />);

    expect(handle!.container.textContent).not.toContain(
      "Last 24h: activity unavailable",
    );
    expect(handle!.container.textContent).toContain(
      "Last 24h: 2 operations · 1 liquidation · 0 redemptions",
    );
    expect(digestRowCells(handle!.container).slice(2, 6)).toEqual([
      "0",
      "0",
      "0",
      "1",
    ]);
  });

  it("does not count rebalance redemptions in the Redemptions digest column", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: {
            LiquidationEvent: [],
            RedemptionEvent: [
              redemptionEvent({ id: "user-redemption" }),
              redemptionEvent({
                id: "rebalance-redemption",
                isRebalance: true,
              }),
            ],
            SpRebalanceEvent: [],
            TroveOperationEvent: [],
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(handle!, <CdpsPageClient />);

    expect(handle!.container.textContent).toContain(
      "Last 24h: 2 operations · 0 liquidations · 1 redemption",
    );
    expect(digestRowCells(handle!.container).slice(2, 6)).toEqual([
      "0",
      "1",
      "1",
      "0",
    ]);
  });

  it("keeps last-good CDP market data mounted during a background poll error", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return {
          data: marketData(),
          error: new Error("rate limited"),
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(handle!, <CdpsPageClient />);

    expect(handle!.container.textContent).toContain("GBPm");
    expect(handle!.container.textContent).toContain("Recent CDP Transactions");
    expect(handle!.container.textContent).not.toContain(
      "Failed to load CDP markets",
    );
  });

  it("preserves primary 24h counts when the SP companion query fails", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: undefined,
          error: new Error("schema still syncing"),
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(handle!, <CdpsPageClient />);

    expect(handle!.container.textContent).toContain("24h: ≥1 ops");
    expect(handle!.container.textContent).toContain(
      "Stability pool deposit and withdraw events are temporarily unavailable",
    );
    expect(
      Array.from(handle!.container.querySelectorAll('[role="status"]')).some(
        (node) =>
          node.textContent?.includes(
            "Stability pool deposit and withdraw events are temporarily unavailable",
          ),
      ),
    ).toBe(true);
  });
});

describe("CdpAllTransactionsTable", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.clearAllMocks();
    setUrl("/cdps");
    networkState.network = { ...networkState.network, chainId: 42220 };
    handle = setup();
  });

  afterEach(() => {
    teardown(handle);
    handle = null;
    vi.useRealTimers();
  });

  it("filters overview transactions by owner and market when snapshots are ready", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: snapshotData([
            {
              id: "op1",
              owner: "0xowner",
              debtBefore: wei(5),
              debtAfter: wei(10),
              collBefore: wei(1),
              collAfter: wei(11),
            },
          ]),
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[
          { id: "gbpm", chainId: 42220, symbol: "GBPm" },
          { id: "chfm", chainId: 42220, symbol: "CHFm" },
        ]}
      />,
    );

    expect(bodyText(handle!.container)).toContain("Open Trove");
    expect(bodyText(handle!.container)).toContain("Liquidation");

    const input = handle!.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter CDP transactions by owner or depositor address"]',
    );
    expect(input?.disabled).toBe(false);
    act(() => {
      typeInto(input!, " 0xOWNER ");
    });
    expect(bodyText(handle!.container)).toContain("Open Trove");
    expect(bodyText(handle!.container)).not.toContain("Liquidation");

    act(() => {
      pill(handle!.container, "CHFm").click();
    });
    expect(bodyText(handle!.container)).toContain(
      "No transactions match the active filters.",
    );
  });

  it("initializes overview filters from a copied URL", () => {
    setUrl("/cdps?type=troveOpen&market=gbpm&address=0xOWNER");
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: snapshotData([
            {
              id: "op1",
              owner: "0xowner",
              debtBefore: wei(5),
              debtAfter: wei(10),
              collBefore: wei(1),
              collAfter: wei(11),
            },
          ]),
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[
          { id: "gbpm", chainId: 42220, symbol: "GBPm" },
          { id: "chfm", chainId: 42220, symbol: "CHFm" },
        ]}
      />,
    );

    const input = handle!.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter CDP transactions by owner or depositor address"]',
    );
    expect(input?.value).toBe("0xowner");
    expect(pill(handle!.container, "Open Trove").ariaChecked).toBe("true");
    expect(pill(handle!.container, "GBPm").ariaChecked).toBe("true");
    expect(bodyText(handle!.container)).toContain("Open Trove");
    expect(bodyText(handle!.container)).not.toContain("Liquidation");
    expect(window.location.search).toBe(
      "?type=troveOpen&market=gbpm&address=0xowner",
    );
  });

  it("writes overview filters to the URL while preserving unrelated params", () => {
    setUrl("/cdps?foo=1#firehose");
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: snapshotData([
            {
              id: "op1",
              owner: "0xowner",
              debtBefore: wei(5),
              debtAfter: wei(10),
              collBefore: wei(1),
              collAfter: wei(11),
            },
          ]),
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[
          { id: "gbpm", chainId: 42220, symbol: "GBPm" },
          { id: "chfm", chainId: 42220, symbol: "CHFm" },
        ]}
      />,
    );

    const input = handle!.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter CDP transactions by owner or depositor address"]',
    );
    act(() => {
      pill(handle!.container, "Open Trove").click();
    });
    act(() => {
      pill(handle!.container, "GBPm").click();
    });
    act(() => {
      typeInto(input!, " 0xOWNER ");
    });

    expect(window.location.search).toBe(
      "?foo=1&type=troveOpen&market=gbpm&address=0xowner",
    );
    expect(window.location.hash).toBe("#firehose");
  });

  it("canonicalizes malformed overview filter params", () => {
    setUrl("/cdps?type=bogus&market=stale&address=%20%20&foo=1");

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[{ id: "gbpm", chainId: 42220, symbol: "GBPm" }]}
      />,
    );

    expect(pill(handle!.container, "All").ariaChecked).toBe("true");
    expect(window.location.search).toBe("?foo=1");
  });

  it("syncs overview filters from browser back-forward popstate", () => {
    setUrl("/cdps?type=troveOpen&market=gbpm");
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[
          { id: "gbpm", chainId: 42220, symbol: "GBPm" },
          { id: "chfm", chainId: 42220, symbol: "CHFm" },
        ]}
      />,
    );
    expect(bodyText(handle!.container)).toContain("Open Trove");
    expect(bodyText(handle!.container)).not.toContain("Liquidation");

    window.history.replaceState(
      window.history.state,
      "",
      "/cdps?type=liquidation&market=chfm",
    );
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(pill(handle!.container, "Liquidation").ariaChecked).toBe("true");
    expect(pill(handle!.container, "CHFm").ariaChecked).toBe("true");
    expect(bodyText(handle!.container)).toContain("Liquidation");
    expect(bodyText(handle!.container)).not.toContain("Open Trove");
  });

  it("keeps overview SP depositor matches subject to type and market filters", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: {
            LiquidationEvent: [],
            RedemptionEvent: [],
            SpRebalanceEvent: [],
            TroveOperationEvent: [],
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: {
            StabilityPoolOperationEvent: [
              stabilityPoolOperation({
                id: "sp-gbpm-deposit",
                instanceId: "gbpm",
                txHash: "0xspgbpmdeposit",
              }),
              stabilityPoolOperation({
                id: "sp-chfm-withdraw",
                instanceId: "chfm",
                topUpOrWithdrawal: negWei(20),
                depositBefore: wei(150),
                depositAfter: wei(130),
                txHash: "0xspchfmwithdraw",
              }),
            ],
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: undefined,
          error: new Error("schema still syncing"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[
          { id: "gbpm", chainId: 42220, symbol: "GBPm" },
          { id: "chfm", chainId: 42220, symbol: "CHFm" },
        ]}
      />,
    );

    const input = handle!.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter CDP transactions by owner or depositor address"]',
    );
    act(() => {
      typeInto(input!, "0xdepositor");
      pill(handle!.container, "SP Withdraw").click();
      pill(handle!.container, "CHFm").click();
    });

    expect(bodyText(handle!.container)).toContain("SP Withdraw");
    expect(bodyText(handle!.container)).toContain("CHFm");
    expect(bodyText(handle!.container)).not.toContain("SP Deposit");
    expect(bodyText(handle!.container)).not.toContain("GBPm");
  });

  it("keeps rows visible and disables owner filtering when snapshots fail", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: undefined,
          error: new Error("schema still syncing"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[{ id: "gbpm", chainId: 42220, symbol: "GBPm" }]}
      />,
    );

    const input = handle!.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter CDP transactions by owner or depositor address"]',
    );
    expect(input?.disabled).toBe(true);
    expect(handle!.container.textContent).toContain(
      "unavailable while indexer syncs",
    );
    expect(bodyText(handle!.container)).toContain("Open Trove");
  });

  it("keeps the overview empty state behind the SP companion query", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: {
            LiquidationEvent: [],
            RedemptionEvent: [],
            SpRebalanceEvent: [],
            TroveOperationEvent: [],
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return { data: undefined, error: null, isLoading: true };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[{ id: "gbpm", chainId: 42220, symbol: "GBPm" }]}
      />,
    );

    expect(handle!.container.querySelector('[role="status"]')).not.toBeNull();
    expect(handle!.container.textContent).not.toContain(
      "No CDP transactions indexed yet.",
    );
  });

  it("keeps last-good empty overview transactions as an empty state during a background poll error", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: {
            LiquidationEvent: [],
            RedemptionEvent: [],
            SpRebalanceEvent: [],
            TroveOperationEvent: [],
          },
          error: new Error("rate limited"),
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[{ id: "gbpm", chainId: 42220, symbol: "GBPm" }]}
      />,
    );

    expect(handle!.container.textContent).toContain(
      "No CDP transactions indexed yet.",
    );
    expect(handle!.container.textContent).not.toContain(
      "Failed to load CDP transactions",
    );
    expect(handle!.container.textContent).not.toContain("rate limited");
  });

  it("shows the overview SP schema-lag notice when only the companion query fails", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: {
            LiquidationEvent: [],
            RedemptionEvent: [],
            SpRebalanceEvent: [],
            TroveOperationEvent: [],
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: undefined,
          error: new Error("schema still syncing"),
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[{ id: "gbpm", chainId: 42220, symbol: "GBPm" }]}
      />,
    );

    expect(handle!.container.textContent).toContain(
      "No CDP transactions indexed yet.",
    );
    expect(handle!.container.textContent).toContain(
      "Stability pool deposit and withdraw events are temporarily unavailable",
    );
  });

  it("filters overview rows by SP depositor while snapshots fail", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: {
            LiquidationEvent: [],
            RedemptionEvent: [],
            SpRebalanceEvent: [],
            TroveOperationEvent: [],
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: {
            StabilityPoolOperationEvent: [stabilityPoolOperation()],
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: undefined,
          error: new Error("schema still syncing"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[{ id: "gbpm", chainId: 42220, symbol: "GBPm" }]}
      />,
    );

    const input = handle!.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter CDP transactions by owner or depositor address"]',
    );
    expect(input?.disabled).toBe(false);
    act(() => {
      typeInto(input!, "0xdepositor");
    });

    expect(bodyText(handle!.container)).toContain("SP Deposit");
    expect(handle!.container.textContent).toContain(
      "Showing Stability Pool depositor matches only",
    );
    expect(
      handle!.container.querySelector('[role="status"]')?.textContent,
    ).toContain("Showing Stability Pool depositor matches only");
  });

  it("paginates overview rows in 25-row pages and resets after filter changes", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return {
          data: {
            LiquidationEvent: [],
            RedemptionEvent: [],
            SpRebalanceEvent: [],
            TroveOperationEvent: manyTroveOperations(55),
          },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_STABILITY_POOL_EVENTS) {
        return {
          data: { StabilityPoolOperationEvent: [] },
          error: null,
          isLoading: false,
        };
      }
      if (query === ALL_CDP_TROVE_OP_SNAPSHOTS) {
        return { data: snapshotData(), error: null, isLoading: false };
      }
      return { data: undefined, error: null, isLoading: false };
    });

    render(
      handle!,
      <CdpAllTransactionsTable
        chainId={42220}
        collaterals={[
          { id: "gbpm", chainId: 42220, symbol: "GBPm" },
          { id: "chfm", chainId: 42220, symbol: "CHFm" },
        ]}
      />,
    );

    const txCells = () =>
      handle!.container.querySelectorAll('[data-testid="tx-hash"]');
    expect(txCells()).toHaveLength(25);
    expect(handle!.container.textContent).toContain(
      "Showing 1-25 of 55 fetched transactions across all CDP markets.",
    );
    expect(handle!.container.textContent).toContain("UTC");

    act(() => {
      handle!.container
        .querySelector<HTMLButtonElement>('button[aria-label="Next page"]')
        ?.click();
    });

    expect(txCells()).toHaveLength(25);
    expect(handle!.container.textContent).toContain(
      "Showing 26-50 of 55 fetched transactions across all CDP markets.",
    );

    act(() => {
      handle!.container
        .querySelector<HTMLButtonElement>('button[aria-label="Next page"]')
        ?.click();
    });

    expect(txCells()).toHaveLength(5);
    expect(handle!.container.textContent).toContain(
      "Showing 51-55 of 55 fetched transactions across all CDP markets.",
    );

    act(() => {
      pill(handle!.container, "GBPm").click();
    });

    expect(txCells()).toHaveLength(25);
    expect(handle!.container.textContent).toContain(
      "Showing 1-25 of 55 matching transactions.",
    );
  });
});
