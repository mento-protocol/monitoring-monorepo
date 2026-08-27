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
  CdpTrove,
  CdpTroveOperationEventRow,
} from "../../../../../_lib/types";
import { CDP_TROVE_OPERATIONS_REQUEST_LIMIT } from "../../_lib/params";

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
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => (
    <a href={`mock-address://${address}`}>{address}</a>
  ),
}));

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => <td>{txHash}</td>,
}));

import {
  CDP_MARKETS,
  CDP_TROVE_BY_ID,
  CDP_TROVE_OPERATIONS,
} from "@/lib/queries";
import { TroveDetailClient } from "../trove-detail-client";

const NOW = 1_767_225_600;
const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function collateral(overrides: Partial<CdpCollateral> = {}): CdpCollateral {
  return {
    id: "gbpm",
    chainId: 42220,
    collIndex: 0,
    symbol: "GBPm",
    debtToken: "0xdebt",
    collToken: "0xcoll",
    troveManager: "0xtrovemanager",
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

function trove(overrides: Partial<CdpTrove> = {}): CdpTrove {
  return {
    id: "gbpm-0x8abc",
    troveId: "0x8abc",
    owner: "0xowner",
    previousOwner: "0x0000000000000000000000000000000000000000",
    status: "active",
    debt: wei(28_081),
    coll: wei(44_791),
    icrBps: 11_710,
    interestRate: "0",
    interestBatchId: null,
    openedAt: String(NOW - 100_000),
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

function op(
  overrides: Partial<CdpTroveOperationEventRow> = {},
): CdpTroveOperationEventRow {
  return {
    id: "evt-1",
    troveId: "0x8abc",
    operation: 2,
    collChange: "0",
    debtChange: "0",
    annualInterestRate: "0",
    debtIncreaseFromUpfrontFee: "0",
    timestamp: "1000",
    blockNumber: "1",
    txHash: "0xabc",
    ...overrides,
  };
}

function marketsData(collaterals: CdpCollateral[] = [collateral()]) {
  return { LiquityCollateral: collaterals, LiquityInstance: [], Trove: [] };
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(handle: Handle, symbol = "GBPm", troveId = "0x8abc") {
  act(() => {
    handle.root.render(<TroveDetailClient symbol={symbol} troveId={troveId} />);
  });
}

function teardown(handle: Handle | null) {
  if (!handle) return;
  act(() => handle.root.unmount());
  handle.container.remove();
}

describe("TroveDetailClient", () => {
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

  function mockQueries({
    markets = marketsData(),
    troveRows = [trove()],
    operationRows = [op()],
  }: {
    markets?: ReturnType<typeof marketsData>;
    troveRows?: CdpTrove[];
    operationRows?: CdpTroveOperationEventRow[];
  } = {}) {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: markets, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID) {
        return { data: { Trove: troveRows }, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_OPERATIONS) {
        return {
          data: { TroveOperationEvent: operationRows },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
  }

  it("renders the header, lifetime totals, and operations list for a resolved trove", () => {
    mockQueries();
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("GBPm");
    expect(text).toContain("Trove 0x8abc");
    expect(text).toContain("Active");
    expect(text).toContain("Per-redemption detail pending indexer rollout");
  });

  it("resolves the interior GraphQL entity id from symbol + route troveId", () => {
    mockQueries();
    render(handle!);

    const call = mockUseGQL.mock.calls.find(
      ([query]) => query === CDP_TROVE_BY_ID,
    );
    expect(call?.[1]).toEqual({ troveEntityId: "gbpm-0x8abc" });

    const opsCall = mockUseGQL.mock.calls.find(
      ([query]) => query === CDP_TROVE_OPERATIONS,
    );
    expect(opsCall?.[1]).toEqual({
      instanceId: "gbpm",
      troveId: "0x8abc",
      limit: CDP_TROVE_OPERATIONS_REQUEST_LIMIT,
    });
  });

  it("shows every trove status through the header badge", () => {
    for (const status of [
      "active",
      "zombie",
      "closed",
      "liquidated",
      "redeemed",
    ] as const) {
      mockQueries({ troveRows: [trove({ status })] });
      render(handle!);
      expect(handle!.container.textContent).toContain(
        status[0]!.toUpperCase() + status.slice(1),
      );
    }
  });

  it("shows a not-indexed state with an explorer fallback when the trove is missing", () => {
    mockQueries({ troveRows: [] });
    render(handle!);

    expect(handle!.container.textContent).toContain("not indexed");
    const link = handle!.container.querySelector<HTMLAnchorElement>(
      'a[href="https://celoscan.io/address/0xtrovemanager"]',
    );
    expect(link).not.toBeNull();
  });

  it("shows 'Unknown CDP market' for a symbol with no matching collateral", () => {
    mockQueries();
    render(handle!, "ZZZm");
    expect(handle!.container.textContent).toContain("Unknown CDP market.");
  });

  it("only serves CDP markets on Celo mainnet", () => {
    networkState.network = { ...networkState.network, chainId: 137 };
    mockQueries();
    render(handle!);
    expect(handle!.container.textContent).toContain(
      "CDP markets are only deployed on Celo mainnet.",
    );
  });

  it("surfaces a CDP_MARKETS load failure", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return {
          data: undefined,
          error: new Error("markets down"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);
    expect(
      handle!.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("markets down");
  });

  it("surfaces a CDP_TROVE_BY_ID load failure", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID) {
        return {
          data: undefined,
          error: new Error("trove query failed"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);
    expect(
      handle!.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("trove query failed");
  });

  it("discloses 'earliest history truncated' only when the operations sentinel row is present", () => {
    const fullPage = Array.from(
      { length: CDP_TROVE_OPERATIONS_REQUEST_LIMIT },
      (_, i) => op({ id: `evt-${i}`, timestamp: String(2000 - i) }),
    );
    mockQueries({ operationRows: fullPage });
    render(handle!);
    expect(handle!.container.textContent).toContain(
      "Earliest history truncated",
    );

    mockQueries({ operationRows: [op()] });
    render(handle!);
    expect(handle!.container.textContent).not.toContain(
      "Earliest history truncated",
    );
  });

  it("never renders a chart, interest-residual estimate, or net-equity figure from the interim view", () => {
    mockQueries();
    render(handle!);
    const text = handle!.container.textContent ?? "";
    expect(text).not.toMatch(/net equity/i);
    expect(text.toLowerCase()).not.toContain("interest residual");
    expect(handle!.container.querySelector("canvas, svg")).toBeNull();
  });
});
