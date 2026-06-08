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
  CdpTroveListRow,
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

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => (
    <td data-testid="tx-hash">{txHash}</td>
  ),
}));

import {
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

describe("CdpsPageClient", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.clearAllMocks();
    networkState.network = { ...networkState.network, chainId: 42220 };
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketData(), error: null, isLoading: false };
      }
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
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
    expect(handle!.container.textContent).toContain("Recent CDP Transactions");
    expect(bodyText(handle!.container)).toContain("Open Trove");
  });
});

describe("CdpAllTransactionsTable", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.clearAllMocks();
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
      'input[aria-label="Filter CDP transactions by trove owner address"]',
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

  it("keeps rows visible and disables owner filtering when snapshots fail", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === ALL_CDP_TRANSACTIONS) {
        return { data: transactionData(), error: null, isLoading: false };
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
      'input[aria-label="Filter CDP transactions by trove owner address"]',
    );
    expect(input?.disabled).toBe(true);
    expect(handle!.container.textContent).toContain(
      "unavailable while indexer syncs",
    );
    expect(bodyText(handle!.container)).toContain("Open Trove");
  });
});
