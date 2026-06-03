/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CdpTroveOperationEventRow,
  CdpTroveOpSnapshotRow,
} from "../../../_lib/types";

const mockUseGQL = vi.hoisted(() => vi.fn());

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => (
    <td data-testid="tx-hash">{txHash}</td>
  ),
}));

import { CDP_TRANSACTIONS, CDP_TROVE_OP_SNAPSHOTS } from "@/lib/queries";
import { CdpTransactionsTable } from "../cdp-transactions-table";

const USD_WEI = BigInt(10) ** BigInt(18);
const NOW = 1_767_225_600;

function wei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function troveOp(
  id: string,
  overrides: Partial<CdpTroveOperationEventRow> = {},
): CdpTroveOperationEventRow {
  return {
    id,
    troveId: id,
    operation: 0,
    collChange: wei(10),
    debtChange: wei(5),
    annualInterestRate: "0",
    debtIncreaseFromUpfrontFee: "0",
    timestamp: String(NOW - Number(id.replace("op", ""))),
    blockNumber: String(100 + Number(id.replace("op", ""))),
    txHash: `0x${id}`,
    ...overrides,
  };
}

function txData(rows: CdpTroveOperationEventRow[]) {
  return {
    LiquidationEvent: [],
    RedemptionEvent: [],
    SpRebalanceEvent: [],
    TroveOperationEvent: rows,
  };
}

function snapshot(row: Partial<CdpTroveOpSnapshotRow>): CdpTroveOpSnapshotRow {
  return {
    id: "op1",
    owner: "0xowner",
    debtBefore: wei(5),
    debtAfter: wei(10),
    collBefore: wei(1),
    collAfter: wei(11),
    ...row,
  };
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(handle: Handle) {
  act(() => {
    handle.root.render(
      <CdpTransactionsTable instanceId="gbpm" chainId={42220} symbol="GBPm" />,
    );
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

describe("CdpTransactionsTable", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.clearAllMocks();
    handle = setup();
  });

  afterEach(() => {
    teardown(handle);
    handle = null;
    vi.useRealTimers();
  });

  it("renders loading, error, and empty states", () => {
    mockUseGQL.mockImplementation((query: string | null) =>
      query === CDP_TRANSACTIONS
        ? { data: undefined, error: null, isLoading: true }
        : { data: undefined, error: null, isLoading: false },
    );
    render(handle!);
    expect(handle!.container.querySelector('[role="status"]')).not.toBeNull();

    mockUseGQL.mockImplementation((query: string | null) =>
      query === CDP_TRANSACTIONS
        ? {
            data: undefined,
            error: new Error("primary query failed"),
            isLoading: false,
          }
        : { data: undefined, error: null, isLoading: false },
    );
    render(handle!);
    expect(
      handle!.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Failed to load CDP transactions");

    mockUseGQL.mockImplementation((query: string | null) =>
      query === CDP_TRANSACTIONS
        ? { data: txData([]), error: null, isLoading: false }
        : { data: undefined, error: null, isLoading: false },
    );
    render(handle!);
    expect(handle!.container.textContent).toContain(
      "No CDP transactions indexed yet.",
    );
  });

  it("filters by owner when snapshots are ready and clamps a stale page", () => {
    const rows = Array.from({ length: 21 }, (_, index) =>
      troveOp(`op${index + 1}`, {
        operation: index === 20 ? 2 : 0,
      }),
    );
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_TRANSACTIONS) {
        return { data: txData(rows), error: null, isLoading: false };
      }
      if (query === CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: {
            TroveOperationEvent: [snapshot({ id: "op21", owner: "0xowner" })],
          },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);

    expect(handle!.container.textContent).toContain("21 total");
    act(() => {
      handle!.container
        .querySelector<HTMLButtonElement>('button[aria-label="Next page"]')
        ?.click();
    });
    expect(handle!.container.textContent).toContain("page 2 of 2");

    act(() => {
      pill(handle!.container, "Adjust Trove").click();
    });
    expect(handle!.container.textContent).toContain("1 total");
    expect(handle!.container.textContent).not.toContain("page 2 of 1");

    const input = handle!.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter CDP transactions by trove owner address"]',
    );
    act(() => {
      typeInto(input!, "0xowner");
    });
    expect(bodyText(handle!.container)).toContain("Adjust Trove");
  });

  it("disables owner filtering while snapshot data is unavailable", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_TRANSACTIONS) {
        return {
          data: txData([troveOp("op1")]),
          error: null,
          isLoading: false,
        };
      }
      if (query === CDP_TROVE_OP_SNAPSHOTS) {
        return {
          data: undefined,
          error: new Error("schema lag"),
          isLoading: false,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);

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
