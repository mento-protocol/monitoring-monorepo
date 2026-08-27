/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseGQL = vi.hoisted(() => vi.fn());

vi.mock("@/lib/graphql", () => ({
  HASURA_TIMEOUT_MS: 5000,
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

import { CDP_TROVE_LEDGER, CDP_TROVE_SCHEMA_FIELDS } from "@/lib/queries";
import {
  CDP_TROVE_LEDGER_REQUEST_LIMIT,
  CdpTroveLedgerSchema,
  type CdpTroveLedgerEventRow,
  type CdpTroveLedgerResponse,
  type TroveLedgerAnchorRow,
} from "../ledger";
import { useTroveLedger, type TroveLedgerState } from "../use-trove-ledger";

const PROBE_WITH_LEDGER = {
  TroveType: {
    fields: [
      { name: "id" },
      { name: "lastLedgerBlock" },
      { name: "lastLedgerLogIndex" },
    ],
  },
  TroveLedgerEventType: { fields: [{ name: "id" }] },
};
const PROBE_WITHOUT_LEDGER = {
  TroveType: { fields: [{ name: "id" }] },
  TroveLedgerEventType: null,
};

function ledgerRow(
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
    debtBefore: "1000",
    debtAfter: "1000",
    collBefore: "500",
    collAfter: "500",
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
    txHash: "0xtx",
    ...overrides,
  };
}

function anchorRow(
  overrides: Partial<TroveLedgerAnchorRow> = {},
): TroveLedgerAnchorRow {
  return {
    lastLedgerBlock: "100",
    lastLedgerLogIndex: 1,
    redemptionCount: 0,
    redeemedDebt: "0",
    redeemedColl: "0",
    redemptionFeePaidCum: "0",
    ...overrides,
  };
}

function ledgerData(
  rows: CdpTroveLedgerEventRow[],
  watermark: TroveLedgerAnchorRow[] = [anchorRow()],
): CdpTroveLedgerResponse {
  return { LedgerWatermark: watermark, TroveLedgerEvent: rows };
}

let latest: TroveLedgerState | null = null;

function Harness({ troveEntityId }: { troveEntityId: string | null }) {
  latest = useTroveLedger(troveEntityId);
  return null;
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(handle: Handle, troveEntityId: string | null = "gbpm-0x8abc") {
  act(() => {
    handle.root.render(<Harness troveEntityId={troveEntityId} />);
  });
}

function mockQueries({
  probe = PROBE_WITH_LEDGER,
  probeUnresolved = false,
  probeError = null,
  ledger,
  ledgerError = null,
  ledgerLoading = false,
}: {
  probe?: typeof PROBE_WITH_LEDGER | typeof PROBE_WITHOUT_LEDGER;
  /** True simulates a probe that has never resolved (SWR loading). */
  probeUnresolved?: boolean;
  probeError?: Error | null;
  /** `undefined` = never resolved (SWR loading semantics). */
  ledger?: CdpTroveLedgerResponse;
  ledgerError?: Error | null;
  ledgerLoading?: boolean;
} = {}) {
  const probeData = probeUnresolved ? undefined : probe;
  mockUseGQL.mockImplementation((query: string | null) => {
    if (query === CDP_TROVE_SCHEMA_FIELDS) {
      return {
        data: probeData,
        error: probeError,
        isLoading: probeUnresolved,
      };
    }
    if (query === CDP_TROVE_LEDGER) {
      return { data: ledger, error: ledgerError, isLoading: ledgerLoading };
    }
    return { data: undefined, error: null, isLoading: false };
  });
}

describe("useTroveLedger", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
    handle = setup();
  });

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
    }
    handle = null;
  });

  it("fails closed and never fires the ledger query while the probe is unresolved", () => {
    mockQueries({ probeUnresolved: true });
    render(handle!);

    expect(latest!.supported).toBe(false);
    expect(latest!.watermark).toBeNull();
    expect(
      mockUseGQL.mock.calls.some(([query]) => query === CDP_TROVE_LEDGER),
    ).toBe(false);
    // The gate being closed disables the query via a null key.
    expect(mockUseGQL.mock.calls.some(([query]) => query === null)).toBe(true);
  });

  it("stays closed when the live schema lacks the entity", () => {
    mockQueries({ probe: PROBE_WITHOUT_LEDGER });
    render(handle!);

    expect(latest!.supported).toBe(false);
    expect(
      mockUseGQL.mock.calls.some(([query]) => query === CDP_TROVE_LEDGER),
    ).toBe(false);
  });

  it("fires the gated query with the sentinel request limit and the Zod guard once supported", () => {
    mockQueries({ ledger: ledgerData([ledgerRow()]) });
    render(handle!);

    expect(latest!.supported).toBe(true);
    const call = mockUseGQL.mock.calls.find(
      ([query]) => query === CDP_TROVE_LEDGER,
    );
    expect(call?.[1]).toEqual({
      troveEntityId: "gbpm-0x8abc",
      limit: CDP_TROVE_LEDGER_REQUEST_LIMIT,
    });
    const options = call?.[2] as
      | { timeoutMs?: number; schema?: unknown }
      | undefined;
    expect(options?.timeoutMs).toBe(5000);
    expect(options?.schema).toBe(CdpTroveLedgerSchema);
  });

  it("re-evaluates the gate: a mid-session probe upgrade swaps interim → ledger", () => {
    // First render: pre-promotion schema — interim mode.
    mockQueries({ probe: PROBE_WITHOUT_LEDGER });
    render(handle!);
    expect(latest!.supported).toBe(false);

    // The probe's next poll finds the promoted schema: same mounted hook
    // must flip open and fire the ledger query — a re-evaluation, not a
    // latch on the first result.
    mockQueries({ ledger: ledgerData([ledgerRow()]) });
    render(handle!);
    expect(latest!.supported).toBe(true);
    expect(latest!.rows).toHaveLength(1);

    // And back: a rollback closes the gate again.
    mockQueries({ probe: PROBE_WITHOUT_LEDGER });
    render(handle!);
    expect(latest!.supported).toBe(false);
  });

  it("returns chronological rows, the watermark, and completeness for a loaded ledger", () => {
    mockQueries({
      ledger: ledgerData(
        [
          // Desc server order, with a same-timestamp logIndex tie.
          ledgerRow({ id: "42220_100_10", timestamp: "1000", logIndex: 10 }),
          ledgerRow({ id: "42220_100_9", timestamp: "1000", logIndex: 9 }),
          ledgerRow({
            id: "42220_90_1",
            timestamp: "900",
            blockNumber: "90",
            logIndex: 1,
          }),
        ],
        [
          anchorRow({
            lastLedgerBlock: "100",
            lastLedgerLogIndex: 10,
            redemptionCount: 2,
            redeemedDebt: "500",
          }),
        ],
      ),
    });
    render(handle!);

    expect(latest!.rows.map((row) => row.id)).toEqual([
      "42220_90_1",
      "42220_100_9",
      "42220_100_10",
    ]);
    expect(latest!.truncated).toBe(false);
    expect(latest!.complete).toBe(true);
    expect(latest!.debtSnapshotsComplete).toBe(true);
    expect(latest!.hasLoadedOnce).toBe(true);
    expect(latest!.watermark).toMatchObject({
      lastLedgerBlock: "100",
      lastLedgerLogIndex: 10,
    });
    // The watermark equals the newest row's (blockNumber, logIndex) —
    // anchored — and the same-response cumulatives ride along for the
    // impact panel's reconciliation.
    expect(latest!.anchored).toBe(true);
    expect(latest!.cumulatives).toMatchObject({
      redemptionCount: 2,
      redeemedDebt: "500",
    });
  });

  it("reports un-anchored when the watermark trails the newest row — logIndex separates same-block transactions", () => {
    // Two rows in the SAME block: the watermark points at logIndex 5 while
    // the newest fetched row is logIndex 9 — block number alone would
    // wrongly call this anchored.
    mockQueries({
      ledger: ledgerData(
        [
          ledgerRow({ id: "42220_100_9", logIndex: 9 }),
          ledgerRow({ id: "42220_100_5", logIndex: 5 }),
        ],
        [anchorRow({ lastLedgerBlock: "100", lastLedgerLogIndex: 5 })],
      ),
    });
    render(handle!);
    expect(latest!.anchored).toBe(false);

    // Same block, matching logIndex: anchored.
    mockQueries({
      ledger: ledgerData(
        [
          ledgerRow({ id: "42220_100_9", logIndex: 9 }),
          ledgerRow({ id: "42220_100_5", logIndex: 5 }),
        ],
        [anchorRow({ lastLedgerBlock: "100", lastLedgerLogIndex: 9 })],
      ),
    });
    render(handle!);
    expect(latest!.anchored).toBe(true);
  });

  it("exposes a refetch that revalidates the ledger query via SWR mutate", async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query === CDP_TROVE_SCHEMA_FIELDS) {
        return { data: PROBE_WITH_LEDGER, error: null, isLoading: false };
      }
      if (query === CDP_TROVE_LEDGER) {
        return {
          data: ledgerData([ledgerRow()]),
          error: null,
          isLoading: false,
          mutate,
        };
      }
      return { data: undefined, error: null, isLoading: false };
    });
    render(handle!);

    await act(async () => {
      await latest!.refetch();
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("marks a sentinel-capped fetch truncated and NOT complete (derivations stay off)", () => {
    const rows = Array.from(
      { length: CDP_TROVE_LEDGER_REQUEST_LIMIT },
      (_, i) =>
        ledgerRow({
          id: `42220_${9_999 - i}_0`,
          timestamp: String(9_999 - i),
          blockNumber: String(9_999 - i),
          logIndex: 0,
        }),
    );
    mockQueries({ ledger: ledgerData(rows) });
    render(handle!);

    expect(latest!.truncated).toBe(true);
    expect(latest!.complete).toBe(false);
    expect(latest!.rows).toHaveLength(CDP_TROVE_LEDGER_REQUEST_LIMIT - 1);
  });

  it("flags incomplete debt snapshots when a batch row is present", () => {
    mockQueries({
      ledger: ledgerData([
        ledgerRow({ id: "42220_100_1" }),
        ledgerRow({
          id: "42220_200_1",
          operation: 8,
          debtBefore: null,
          debtAfter: null,
          timestamp: "2000",
          blockNumber: "200",
        }),
      ]),
    });
    render(handle!);

    expect(latest!.debtSnapshotsComplete).toBe(false);
    expect(latest!.complete).toBe(true);
  });

  it("keeps loading/empty/error distinct: confirmed-empty is loaded, a first-load failure is not", () => {
    mockQueries({ ledger: ledgerData([], []) });
    render(handle!);
    expect(latest!.hasLoadedOnce).toBe(true);
    expect(latest!.rows).toEqual([]);
    expect(latest!.watermark).toBeNull();

    mockQueries({ ledgerError: new Error("ledger query failed") });
    render(handle!);
    expect(latest!.hasLoadedOnce).toBe(false);
    expect(latest!.complete).toBe(false);
    expect(latest!.error?.message).toBe("ledger query failed");
  });

  it("disables everything without an entity id (unresolved market / non-Celo network)", () => {
    mockQueries({ ledger: ledgerData([ledgerRow()]) });
    render(handle!, null);

    expect(latest!.supported).toBe(false);
    expect(
      mockUseGQL.mock.calls.some(
        ([query]) =>
          query === CDP_TROVE_LEDGER || query === CDP_TROVE_SCHEMA_FIELDS,
      ),
    ).toBe(false);
  });
});
