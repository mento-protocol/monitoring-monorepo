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

const HASURA_TIMEOUT_MS = 5000;

vi.mock("@/lib/graphql", () => ({
  HASURA_TIMEOUT_MS: 5000,
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

// The chart pulls in next/dynamic + Plotly; its own rendering is covered by
// trove-balance-chart.test.tsx. Here only its mounting contract matters:
// present in complete-ledger mode, absent from the interim view, fed by the
// same ledger read as the table.
vi.mock("../trove-balance-chart", () => ({
  TroveBalanceChart: (props: { truncated: boolean; debtSymbol: string }) => (
    <div
      data-chart-mock="trove-balance"
      data-truncated={String(props.truncated)}
      data-debt-symbol={props.debtSymbol}
    />
  ),
}));

import {
  CDP_INTEREST_BATCH_BY_ID,
  CDP_MARKETS,
  CDP_TROVE_BY_ID,
  CDP_TROVE_BY_ID_WITHOUT_TX,
  CDP_TROVE_LEDGER,
  CDP_TROVE_OPERATIONS,
  CDP_TROVE_QUEUE,
  CDP_TROVE_SCHEMA_FIELDS,
} from "@/lib/queries";
import type { CdpTroveLedgerEventRow } from "../../_lib/ledger";
import type { CdpTroveQueueResponse } from "../../_lib/queue";
import { TroveDetailClient } from "../trove-detail-client";

const TROVE_SCHEMA_WITH_TX = {
  TroveType: { fields: [{ name: "lastUpdatedTxHash" }] },
};
const TROVE_SCHEMA_WITHOUT_TX = {
  TroveType: { fields: [{ name: "owner" }] },
};
// Post-#2082 live schema: the TroveLedgerEvent entity AND the Trove
// watermark columns are served, so the ledger introspection gate opens.
const TROVE_SCHEMA_WITH_LEDGER = {
  TroveType: {
    fields: [
      { name: "lastUpdatedTxHash" },
      { name: "lastLedgerBlock" },
      { name: "lastLedgerLogIndex" },
    ],
  },
  TroveLedgerEventType: { fields: [{ name: "id" }] },
};

const NOW = 1_767_225_600;
const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function rateWei(bps: number): string {
  return ((BigInt(bps) * D18) / BigInt(10_000)).toString();
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

function ledgerEvent(
  overrides: Partial<CdpTroveLedgerEventRow> = {},
): CdpTroveLedgerEventRow {
  return {
    id: "42220_100_1",
    operation: 2,
    collChange: "0",
    debtChange: "0",
    debtIncreaseFromUpfrontFee: "0",
    debtIncreaseFromRedist: "0",
    collIncreaseFromRedist: "0",
    annualInterestRate: "0",
    debtBefore: wei(1_000),
    debtAfter: wei(1_000),
    collBefore: wei(500),
    collAfter: wei(500),
    statusBefore: "active",
    statusAfter: "active",
    redemptionFeeCredited: null,
    isRebalance: null,
    redemptionPrice: null,
    priceAtEvent: null,
    icrAfterBps: null,
    timestamp: "1000",
    blockNumber: "100",
    logIndex: 1,
    txHash: "0xledgertx",
    ...overrides,
  };
}

function marketsData(collaterals: CdpCollateral[] = [collateral()]) {
  return { LiquityCollateral: collaterals, LiquityInstance: [], Trove: [] };
}

function queueResponse(
  overrides: Partial<CdpTroveQueueResponse> = {},
): CdpTroveQueueResponse {
  return {
    LiquityInstance: [{ id: "gbpm", isShutDown: false, shutDownAt: null }],
    OpenTrove: [
      {
        id: "gbpm-0x8abc",
        status: "active",
        debt: wei(28_081),
        interestRate: rateWei(50),
        interestBatchId: null,
      },
      {
        id: "gbpm-0x9",
        status: "active",
        debt: wei(6_200),
        interestRate: rateWei(20),
        interestBatchId: null,
      },
    ],
    InterestBatch: [],
    ...overrides,
  };
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
    marketsError = null,
    troveRows = [trove()],
    troveError = null,
    operationRows = [op()],
    troveSchema = TROVE_SCHEMA_WITH_TX,
    interestBatchRows,
    interestBatchError = null,
    ledgerRows,
    ledgerError = null,
    queueData,
    queueError = null,
  }: {
    markets?: ReturnType<typeof marketsData>;
    marketsError?: Error | null;
    troveRows?: CdpTrove[];
    troveError?: Error | null;
    operationRows?: CdpTroveOperationEventRow[];
    troveSchema?:
      | typeof TROVE_SCHEMA_WITH_TX
      | typeof TROVE_SCHEMA_WITHOUT_TX
      | typeof TROVE_SCHEMA_WITH_LEDGER;
    /** `undefined` (default) simulates "never resolved" (loading, or a
     *  failure with nothing cached) — `data` stays `undefined`, matching
     *  real SWR semantics. Pass `[]` for "resolved, no matching batch row"
     *  or `[row]` for a confirmed rate. */
    interestBatchRows?: Array<{
      id: string;
      collateralId: string;
      batchManager: string;
      annualInterestRate: string;
      updatedAt: string;
    }>;
    interestBatchError?: Error | null;
    /** Same never-resolved convention as `interestBatchRows`. Only consulted
     *  when `troveSchema` opens the ledger gate. */
    ledgerRows?: CdpTroveLedgerEventRow[];
    ledgerError?: Error | null;
    /** Same never-resolved convention: `undefined` leaves the queue panel
     *  in its loading state. */
    queueData?: CdpTroveQueueResponse;
    queueError?: Error | null;
  } = {}) {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: markets, error: marketsError, isLoading: false };
      }
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: troveSchema, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID || query === CDP_TROVE_BY_ID_WITHOUT_TX) {
        return {
          data: { Trove: troveRows },
          error: troveError,
          isLoading: false,
        };
      }
      if (query === CDP_INTEREST_BATCH_BY_ID) {
        return {
          data:
            interestBatchRows === undefined
              ? undefined
              : { InterestBatch: interestBatchRows },
          error: interestBatchError,
          isLoading: false,
        };
      }
      if (query === CDP_TROVE_OPERATIONS) {
        return {
          data: { TroveOperationEvent: operationRows },
          error: null,
          isLoading: false,
        };
      }
      if (query === CDP_TROVE_QUEUE) {
        return { data: queueData, error: queueError, isLoading: false };
      }
      if (query === CDP_TROVE_LEDGER) {
        // The anchor branch mirrors the trove row: watermark pinned at the
        // default ledgerEvent's (blockNumber, logIndex) so single-row
        // fixtures are anchored, and cumulatives copied from the header
        // trove so consistent fixtures reconcile instead of triggering the
        // impact panel's refetch machinery.
        const headerTrove = troveRows[0];
        return {
          data:
            ledgerRows === undefined
              ? undefined
              : {
                  LedgerWatermark: [
                    {
                      lastLedgerBlock: "100",
                      lastLedgerLogIndex: 1,
                      redemptionCount: headerTrove?.redemptionCount ?? 0,
                      redeemedDebt: headerTrove?.redeemedDebt ?? "0",
                      redeemedColl: headerTrove?.redeemedColl ?? "0",
                      redemptionFeePaidCum:
                        headerTrove?.redemptionFeePaidCum ?? "0",
                    },
                  ],
                  TroveLedgerEvent: ledgerRows,
                },
          error: ledgerError,
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

  it("discloses a failed refresh on the not-indexed state, instead of silently keeping a stale 'not indexed' claim", () => {
    // Once the lookup has confirmed `Trove: []`, a later poll failure is a
    // refresh failure on top of that confirmed verdict — not a first-load
    // failure. During indexer catch-up the trove may have appeared since
    // the last successful lookup, so silence here would be misleading.
    mockQueries({
      troveRows: [],
      troveError: new Error("trove lookup revalidation stalled"),
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("not indexed");
    expect(text).toContain("Trove data refresh failed");
    expect(text).toContain("showing the last confirmed state");
    expect(text).toContain("trove lookup revalidation stalled");
  });

  it("shows 'Unknown CDP market' for a symbol with no matching collateral", () => {
    mockQueries();
    render(handle!, "ZZZm");
    expect(handle!.container.textContent).toContain("Unknown CDP market.");
  });

  it("discloses a failed refresh on the unknown-market state, instead of silently keeping a stale claim", () => {
    // Once markets has confirmed a response lacking this symbol, a later
    // poll failure is a refresh failure on top of that confirmed (if
    // symbol-less) response — not a first-load failure. The symbol may
    // have appeared since the last successful poll (indexer catch-up, a
    // market rollout).
    mockQueries({ marketsError: new Error("markets revalidation stalled") });
    render(handle!, "ZZZm");

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Unknown CDP market.");
    expect(text).toContain("Market data refresh failed");
    expect(text).toContain("showing the last confirmed state");
    expect(text).toContain("markets revalidation stalled");
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
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: TROVE_SCHEMA_WITH_TX, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID || query === CDP_TROVE_BY_ID_WITHOUT_TX) {
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

  it("renders same-timestamp operations in true chronological order, not Hasura's string-id tiebreak order", () => {
    // Simulates exactly what Hasura's `order_by: [{ timestamp: desc },
    // { id: desc }]` would return for two ops in the same block sharing a
    // timestamp: log 9 sorts ahead of log 10 as a string ("...9" > "...10"
    // lexicographically), the wrong chronology. The page must correct this
    // before rendering, oldest first.
    mockQueries({
      operationRows: [
        op({ id: "42220_100_9", timestamp: "1000", txHash: "0xlog9" }),
        op({ id: "42220_100_10", timestamp: "1000", txHash: "0xlog10" }),
      ],
    });
    render(handle!);

    const txCells = Array.from(
      handle!.container.querySelectorAll("table tbody tr"),
    ).map((row) => row.textContent ?? "");
    const log9Index = txCells.findIndex((t) => t.includes("0xlog9"));
    const log10Index = txCells.findIndex((t) => t.includes("0xlog10"));
    expect(log9Index).toBeGreaterThanOrEqual(0);
    expect(log10Index).toBeGreaterThanOrEqual(0);
    // Oldest-first display: log 9 (earlier in the block) comes before log
    // 10 (later in the same block).
    expect(log9Index).toBeLessThan(log10Index);
  });

  it("never renders a chart, interest-residual estimate, or net-equity figure from the interim view", () => {
    mockQueries();
    render(handle!);
    const text = handle!.container.textContent ?? "";
    expect(text).not.toMatch(/net equity/i);
    expect(text.toLowerCase()).not.toContain("interest residual");
    expect(handle!.container.querySelector("canvas, svg")).toBeNull();
  });

  it("passes the shared Hasura timeout to every polling useGQL call", () => {
    mockQueries({
      troveRows: [trove({ interestBatchId: "batch-1", status: "active" })],
      interestBatchRows: [
        {
          id: "batch-1",
          collateralId: "gbpm",
          batchManager: "0xmanager",
          annualInterestRate: "0",
          updatedAt: "1000",
        },
      ],
    });
    render(handle!);

    // Index calls by query once, rather than re-scanning the call list per
    // query below (array.find() in a loop).
    const callsByQuery = new Map<string | null, unknown[]>();
    for (const call of mockUseGQL.mock.calls) {
      callsByQuery.set(call[0] as string | null, call);
    }
    for (const query of [
      CDP_MARKETS,
      CDP_TROVE_SCHEMA_FIELDS,
      CDP_TROVE_BY_ID,
      CDP_INTEREST_BATCH_BY_ID,
      CDP_TROVE_OPERATIONS,
      CDP_TROVE_QUEUE,
    ]) {
      const call = callsByQuery.get(query);
      expect(call, `expected a useGQL call for: ${query}`).toBeDefined();
      const options = call?.[2] as { timeoutMs?: number } | undefined;
      expect(options?.timeoutMs).toBe(HASURA_TIMEOUT_MS);
    }
  });

  it("uses the schema-lag fallback query when Trove.lastUpdatedTxHash isn't supported", () => {
    mockQueries({ troveSchema: TROVE_SCHEMA_WITHOUT_TX });
    render(handle!);

    expect(
      mockUseGQL.mock.calls.some(([q]) => q === CDP_TROVE_BY_ID_WITHOUT_TX),
    ).toBe(true);
    expect(mockUseGQL.mock.calls.some(([q]) => q === CDP_TROVE_BY_ID)).toBe(
      false,
    );
    // The page still renders normally on the fallback shape.
    expect(handle!.container.textContent).toContain("Trove 0x8abc");
  });

  it("uses the full trove query once the schema probe confirms lastUpdatedTxHash support", () => {
    mockQueries({ troveSchema: TROVE_SCHEMA_WITH_TX });
    render(handle!);

    expect(mockUseGQL.mock.calls.some(([q]) => q === CDP_TROVE_BY_ID)).toBe(
      true,
    );
    expect(
      mockUseGQL.mock.calls.some(([q]) => q === CDP_TROVE_BY_ID_WITHOUT_TX),
    ).toBe(false);
  });

  it("shows the joined InterestBatch rate for an open batch-managed trove, not the trove's stale copy", () => {
    mockQueries({
      troveRows: [
        trove({
          status: "active",
          interestBatchId: "batch-1",
          interestRate: ((BigInt(160) * D18) / BigInt(10_000)).toString(),
        }),
      ],
      interestBatchRows: [
        {
          id: "batch-1",
          collateralId: "gbpm",
          batchManager: "0xmanager",
          annualInterestRate: ((BigInt(250) * D18) / BigInt(10_000)).toString(),
          updatedAt: "1000",
        },
      ],
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("2.50%");
    expect(text).not.toContain("1.60%");
    const call = mockUseGQL.mock.calls.find(
      ([q]) => q === CDP_INTEREST_BATCH_BY_ID,
    );
    expect(call?.[1]).toEqual({ batchId: "batch-1" });
  });

  it("does not join InterestBatch for a closed batch-managed trove — its rate is a historical snapshot", () => {
    mockQueries({
      troveRows: [
        trove({
          status: "redeemed",
          interestBatchId: "batch-1",
          interestRate: ((BigInt(160) * D18) / BigInt(10_000)).toString(),
        }),
      ],
      interestBatchRows: [
        {
          id: "batch-1",
          collateralId: "gbpm",
          batchManager: "0xmanager",
          annualInterestRate: ((BigInt(250) * D18) / BigInt(10_000)).toString(),
          updatedAt: "1000",
        },
      ],
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("1.60%");
    expect(text).not.toContain("2.50%");
    const batchRequest = mockUseGQL.mock.calls.find(
      ([, variables]) =>
        (variables as { batchId?: string } | undefined)?.batchId === "batch-1",
    );
    expect(batchRequest).toBeUndefined();
  });

  it("shows the rate as unavailable — never the trove's own copy — while the batch join is still loading", () => {
    mockQueries({
      troveRows: [
        trove({
          status: "active",
          interestBatchId: "batch-1",
          interestRate: rateWei(160),
        }),
      ],
      // interestBatchRows omitted -> data stays undefined, i.e. "loading".
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Batch");
    expect(text).not.toContain("1.60%");
    // No misleading "showing the last confirmed state" — nothing has been
    // confirmed yet. A genuinely-loading state (no error at all) also
    // shouldn't show the first-load-failure notice.
    expect(text).not.toContain("Batch rate refresh failed");
    expect(text).not.toContain("Batch rate unavailable");
  });

  it("discloses a first-load batch-rate failure distinctly — not the 'last confirmed state' wording, since nothing was ever confirmed", () => {
    mockQueries({
      troveRows: [
        trove({
          status: "active",
          interestBatchId: "batch-1",
          interestRate: rateWei(160),
        }),
      ],
      interestBatchError: new Error("batch query failed"),
      // interestBatchRows omitted -> no cached rate to fall back to.
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Batch");
    expect(text).not.toContain("1.60%");
    // A first-load failure IS disclosed (Codex's finding) — just not via
    // the "last confirmed state" wording, which would misstate it.
    expect(text).not.toContain("Batch rate refresh failed");
    expect(text).not.toContain("showing the last confirmed state");
    expect(text).toContain("Batch rate unavailable");
    expect(text).toContain("batch query failed");
  });

  it("discloses a batch-rate refresh failure once a rate was confirmed, while still showing that confirmed rate", () => {
    mockQueries({
      troveRows: [
        trove({
          status: "active",
          interestBatchId: "batch-1",
          interestRate: rateWei(160),
        }),
      ],
      interestBatchRows: [
        {
          id: "batch-1",
          collateralId: "gbpm",
          batchManager: "0xmanager",
          annualInterestRate: rateWei(250),
          updatedAt: "1000",
        },
      ],
      interestBatchError: new Error("batch revalidation stalled"),
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("2.50%");
    expect(text).not.toContain("1.60%");
    expect(text).toContain("Batch rate refresh failed");
    expect(text).toContain("showing the last confirmed state");
    expect(text).toContain("batch revalidation stalled");
  });

  it("discloses a failed trove revalidation while keeping the last confirmed data on screen", () => {
    mockQueries({ troveError: new Error("revalidation stalled") });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Trove 0x8abc");
    expect(text).toContain("Trove data refresh failed");
    expect(text).toContain("showing the last confirmed state");
    expect(text).toContain("revalidation stalled");
  });

  it("discloses a failed markets revalidation while keeping the last confirmed data on screen", () => {
    mockQueries({ marketsError: new Error("markets revalidation stalled") });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Trove 0x8abc");
    expect(text).toContain("Market data refresh failed");
    expect(text).toContain("markets revalidation stalled");
  });

  it("shows no stale-refresh notice when both queries are healthy", () => {
    mockQueries();
    render(handle!);
    expect(handle!.container.textContent).not.toContain("refresh failed");
  });

  it("shows 'Batch missing' when the batch join resolves successfully with no matching row — not the same as still loading", () => {
    mockQueries({
      troveRows: [trove({ status: "active", interestBatchId: "batch-1" })],
      interestBatchRows: [], // resolved, but empty: confirmed missing.
    });
    render(handle!);
    expect(handle!.container.textContent).toContain("Batch missing");
  });

  it("discloses a stale-refresh notice (not the harsh first-load error) when a poll fails after the batch was confirmed missing", () => {
    // A poll failure after `batchMissing` was already confirmed is a
    // refresh failure on top of confirmed information — same "resolved
    // empty, not the same as never-loaded" class as the trove-lookup and
    // operations-list fixes, just for the batch join.
    mockQueries({
      troveRows: [trove({ status: "active", interestBatchId: "batch-1" })],
      interestBatchRows: [], // confirmed missing...
      interestBatchError: new Error("batch revalidation stalled"), // ...then a later poll fails.
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Batch missing");
    expect(text).not.toContain("Batch rate unavailable");
    expect(text).toContain("Batch rate refresh failed");
    expect(text).toContain("showing the last confirmed state");
    expect(text).toContain("batch revalidation stalled");
  });

  it("timestamps a resolved batch rate with the batch's own updatedAt, distinct from the trove's timestamp", () => {
    mockQueries({
      troveRows: [trove({ status: "active", interestBatchId: "batch-1" })],
      interestBatchRows: [
        {
          id: "batch-1",
          collateralId: "gbpm",
          batchManager: "0xmanager",
          annualInterestRate: rateWei(250),
          updatedAt: String(NOW + 999),
        },
      ],
    });
    render(handle!);
    expect(handle!.container.textContent).toContain("timestamped separately");
  });

  it("keeps showing the last successful trove row while a schema-probe query-variant swap is in flight", () => {
    // First render: the schema probe hasn't yet detected
    // `lastUpdatedTxHash` support, so `troveById` resolves via the
    // fallback variant.
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: TROVE_SCHEMA_WITHOUT_TX, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID_WITHOUT_TX) {
        return { data: { Trove: [trove()] }, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_OPERATIONS) {
        return {
          data: { TroveOperationEvent: [op()] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);
    expect(handle!.container.textContent).toContain("Trove 0x8abc");

    // The schema probe now confirms support: `resolveTroveByIdQuery` swaps
    // to a DIFFERENT query string — a new SWR key whose fetch hasn't
    // resolved yet (`data` undefined). Without the stabilizer this drops
    // back to the full skeleton even though the underlying row hasn't
    // actually changed.
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: TROVE_SCHEMA_WITH_TX, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID) {
        return { data: undefined, error: undefined, isLoading: true };
      }
      if (query === CDP_TROVE_OPERATIONS) {
        return {
          data: { TroveOperationEvent: [op()] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);
    expect(handle!.container.textContent).toContain("Trove 0x8abc");
    expect(handle!.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("discloses a stale-refresh notice — not silence — when the UPGRADED query fails after a query-variant swap", () => {
    // Same setup as the swap-in-flight test, but this time the upgraded
    // query settles with a real error instead of staying in flight. The
    // cached fallback row must still show (no blank skeleton, no hard
    // error), but the failure must not be silently swallowed either.
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: TROVE_SCHEMA_WITHOUT_TX, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID_WITHOUT_TX) {
        return { data: { Trove: [trove()] }, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_OPERATIONS) {
        return {
          data: { TroveOperationEvent: [op()] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);
    expect(handle!.container.textContent).toContain("Trove 0x8abc");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_MARKETS) {
        return { data: marketsData(), error: null, isLoading: false };
      }
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: TROVE_SCHEMA_WITH_TX, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_BY_ID) {
        return {
          data: undefined,
          error: new Error("upgraded trove query failed"),
          isLoading: false,
        };
      }
      if (query === CDP_TROVE_OPERATIONS) {
        return {
          data: { TroveOperationEvent: [op()] },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);
    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Trove 0x8abc");
    expect(handle!.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(text).toContain("Trove data refresh failed");
    expect(text).toContain("upgraded trove query failed");
  });

  it("renders the interim assembly while the schema does not serve TroveLedgerEvent", () => {
    mockQueries(); // TROVE_SCHEMA_WITH_TX: no TroveLedgerEventType → gate closed.
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Trove operations");
    expect(text).toContain("Per-redemption detail pending indexer rollout");
    expect(text).not.toContain("Trove ledger");
    expect(mockUseGQL.mock.calls.some(([q]) => q === CDP_TROVE_LEDGER)).toBe(
      false,
    );
  });

  it("renders the complete ledger — and disables the interim query — once the gate opens", () => {
    mockQueries({
      troveSchema: TROVE_SCHEMA_WITH_LEDGER,
      // Header cumulatives match the one op-6 row so the impact panel's
      // reconciliation passes (the mock's anchor branch copies them).
      troveRows: [
        trove({
          redemptionCount: 1,
          redeemedDebt: wei(400),
          redeemedColl: "0",
          redemptionFeePaidCum: wei(2),
        }),
      ],
      ledgerRows: [
        ledgerEvent({
          operation: 6,
          isRebalance: true,
          debtChange: `-${wei(400)}`,
          debtBefore: wei(1_000),
          debtAfter: wei(600),
          redemptionFeeCredited: wei(2),
        }),
      ],
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Trove ledger");
    expect(text).toContain("Rebalance Redemption");
    // The interim view and its partial-data notice are fully superseded.
    expect(text).not.toContain("Per-redemption detail pending indexer rollout");
    expect(
      mockUseGQL.mock.calls.some(([q]) => q === CDP_TROVE_OPERATIONS),
    ).toBe(false);
    const ledgerCall = mockUseGQL.mock.calls.find(
      ([q]) => q === CDP_TROVE_LEDGER,
    );
    expect(ledgerCall?.[1]).toEqual({
      troveEntityId: "gbpm-0x8abc",
      limit: 1000,
    });
  });

  it("upgrades from interim to full ledger when a probe poll finds the entity — a re-evaluation, not a latch", () => {
    // Cold load against a pre-rollout schema: interim assembly.
    mockQueries();
    render(handle!);
    expect(handle!.container.textContent).toContain(
      "Per-redemption detail pending indexer rollout",
    );

    // Hosted Hasura promotes mid-session; the 300s probe re-poll now finds
    // the entity. Same mounted client must swap to the ledger view.
    mockQueries({
      troveSchema: TROVE_SCHEMA_WITH_LEDGER,
      ledgerRows: [ledgerEvent()],
    });
    render(handle!);
    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Trove ledger");
    expect(text).not.toContain("Per-redemption detail pending indexer rollout");

    // And a rollback re-closes the gate: honest fallback to the interim
    // view, protocol-rows-pending notice included.
    mockQueries();
    render(handle!);
    expect(handle!.container.textContent).toContain(
      "Per-redemption detail pending indexer rollout",
    );
  });

  it("mounts the balance chart above the ledger table once the gate opens", () => {
    mockQueries({
      troveSchema: TROVE_SCHEMA_WITH_LEDGER,
      ledgerRows: [ledgerEvent()],
    });
    render(handle!);

    const chart = handle!.container.querySelector(
      '[data-chart-mock="trove-balance"]',
    );
    expect(chart).not.toBeNull();
    expect(chart?.getAttribute("data-truncated")).toBe("false");
    expect(chart?.getAttribute("data-debt-symbol")).toBe("GBPm");
    // Layout slot per the plan sketch: chart between the panels row and the
    // ledger table.
    const ledgerHeading = Array.from(
      handle!.container.querySelectorAll("h2"),
    ).find((node) => node.textContent === "Trove ledger");
    expect(ledgerHeading).toBeDefined();
    expect(
      chart!.compareDocumentPosition(ledgerHeading!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("never mounts the balance chart in the interim view", () => {
    mockQueries(); // Gate closed: user-ops-only data must not chart.
    render(handle!);
    expect(
      handle!.container.querySelector('[data-chart-mock="trove-balance"]'),
    ).toBeNull();
  });

  it("mounts the redemption impact panel in the left summary slot, before the queue panel", () => {
    mockQueries({ queueData: queueResponse() });
    render(handle!);

    const headings = Array.from(handle!.container.querySelectorAll("h2")).map(
      (node) => node.textContent ?? "",
    );
    const impactIndex = headings.indexOf("Redemption impact");
    const queueIndex = headings.indexOf("Redemption queue");
    expect(impactIndex).toBeGreaterThanOrEqual(0);
    expect(queueIndex).toBeGreaterThanOrEqual(0);
    expect(impactIndex).toBeLessThan(queueIndex);
  });

  it("shows cumulative redemption totals — labeled as totals — in the interim view", () => {
    // Half the ticket's answer works before the ledger entity ships: the
    // figures come from Trove cumulatives, with the per-hit derivations
    // (split, oracle valuation) explicitly pending.
    mockQueries({
      troveRows: [
        trove({
          redemptionCount: 2,
          redeemedDebt: wei(1_000),
          redeemedColl: wei(1_365),
          redemptionFeePaidCum: wei(3),
        }),
      ],
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Redemption impact");
    expect(text).toContain("Lifetime totals from the trove");
    expect(text).toContain("-1,000.00 GBPm");
    expect(text).toContain("-1,365.00 USDm");
    // Fees are credited TO the trove: positive.
    expect(text).toContain("+3.00 USDm");
    expect(text).not.toContain("all rebalancing");
  });

  it("splits user vs rebalance and shows net equity only from the reconciled complete ledger", () => {
    mockQueries({
      troveSchema: TROVE_SCHEMA_WITH_LEDGER,
      troveRows: [
        trove({
          redemptionCount: 1,
          redeemedDebt: wei(400),
          redeemedColl: wei(495),
          redemptionFeePaidCum: wei(5),
        }),
      ],
      ledgerRows: [
        ledgerEvent({
          operation: 6,
          isRebalance: true,
          debtChange: `-${wei(400)}`,
          collChange: `-${wei(495)}`,
          debtBefore: wei(1_000),
          debtAfter: wei(600),
          redemptionFeeCredited: wei(5),
          // 0.8 debt per collateral: 400 debt is worth 500 collateral, 495
          // taken → net equity +5.
          redemptionPrice: ((BigInt(8) * D18) / BigInt(10)).toString(),
        }),
      ],
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("all rebalancing");
    expect(text).toContain("Net equity at oracle prices");
    expect(text).toContain("+5.00 USDm");
    expect(text).not.toContain("Ledger reconciliation failed");
  });

  it("keeps the header cards rendered when the ledger query fails on first load", () => {
    mockQueries({
      troveSchema: TROVE_SCHEMA_WITH_LEDGER,
      // ledgerRows omitted → never resolved; the error is a first-load one.
      ledgerError: new Error("ledger backend down"),
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    // Header still renders from its own healthy queries.
    expect(text).toContain("Trove 0x8abc");
    expect(text).toContain("Active");
    // The ledger section shows its own hard error — no silent fallback to
    // the interim view, whose user-ops-only rows would misrepresent
    // protocol history as absent.
    expect(text).toContain("Failed to load the trove ledger");
    expect(text).toContain("ledger backend down");
    expect(text).not.toContain("Per-redemption detail pending indexer rollout");
  });

  it("fetches the redemption queue with the resolved collateral id and renders this trove's position", () => {
    mockQueries({ queueData: queueResponse() });
    render(handle!);

    const call = mockUseGQL.mock.calls.find(([q]) => q === CDP_TROVE_QUEUE);
    expect(call?.[1]).toEqual({ collateralId: "gbpm" });

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Redemption queue");
    // This trove (0.50%) queues behind the 0.20% trove's 6,200 GBPm.
    expect(text).toContain("queue position #2 of 2 rate levels");
    expect(text).toContain(
      "6,200.00 GBPm of active debt at lower rates shields this trove today",
    );
    expect(text).toContain("#2 · this trove");
  });

  it("replaces the queue ladder with the shutdown notice while the market is shut down", () => {
    mockQueries({
      queueData: queueResponse({
        LiquityInstance: [
          { id: "gbpm", isShutDown: true, shutDownAt: String(NOW - 500) },
        ],
      }),
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("This market is shut down");
    expect(text).toContain("rate order does not decide");
    expect(
      handle!.container.querySelector(
        'table[aria-label="Redemption queue ladder"]',
      ),
    ).toBeNull();
  });

  it("discloses ledger truncation and suppresses interest estimates for a capped history", () => {
    const cappedRows = Array.from({ length: 1000 }, (_, i) =>
      ledgerEvent({
        id: `42220_${9_999 - i}_0`,
        timestamp: String(9_999 - i),
        blockNumber: String(9_999 - i),
        logIndex: 0,
      }),
    );
    mockQueries({
      troveSchema: TROVE_SCHEMA_WITH_LEDGER,
      ledgerRows: cappedRows,
    });
    render(handle!);

    const text = handle!.container.textContent ?? "";
    expect(text).toContain("Earliest history truncated");
    expect(text).not.toContain("Interest accrued");
  });
});
