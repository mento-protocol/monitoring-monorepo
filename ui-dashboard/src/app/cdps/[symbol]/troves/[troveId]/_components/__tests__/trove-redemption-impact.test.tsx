/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpTrove } from "../../../../../_lib/types";
import type {
  CdpTroveLedgerEventRow,
  TroveLedgerAnchorRow,
} from "../../_lib/ledger";
import type { TroveLedgerState } from "../../_lib/use-trove-ledger";
import {
  hasTroveLifetimeTotals,
  TroveRedemptionImpact,
} from "../trove-redemption-impact";

const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return ((BigInt(Math.round(amount * 100)) * D18) / BigInt(100)).toString();
}

function trove(overrides: Partial<CdpTrove> = {}): CdpTrove {
  return {
    id: "gbpm-0xcca0",
    troveId: "0xcca0",
    owner: "0xcca0a99b94529493ddffe7c61a3ae454828cd3bb",
    previousOwner: "0x0000000000000000000000000000000000000000",
    status: "active",
    debt: wei(28_069.18),
    coll: wei(44_791.09),
    icrBps: 11_710,
    interestRate: "0",
    interestBatchId: null,
    openedAt: "1786010400",
    openedTxHash: "0xopened",
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: "1787745000",
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
    txHash: "0xtx",
    ...overrides,
  };
}

function anchor(
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

function ledgerState(
  overrides: Partial<TroveLedgerState> = {},
): TroveLedgerState {
  return {
    supported: true,
    rows: [],
    truncated: false,
    complete: true,
    debtSnapshotsComplete: true,
    watermark: null,
    anchored: false,
    cumulatives: null,
    isLoading: false,
    error: undefined,
    hasLoadedOnce: true,
    refetch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ticket #0754 fixture (docs/PLAN-trove-history-page.md, "The motivating
// case"): opened 2026-08-06 with 39,955 USDm / 25,000 GBPm (+12.87 upfront
// fee); five protocol rebalancing redemptions on 2026-08-25 between 18:13
// and 21:11 UTC at oracle prices near 0.7329 GBPm-per-USDm; rate move and
// re-lever on 2026-08-26. Per-hit values are wei-exact and sum to the
// verified case-study figures: −18,450.82 GBPm debt repaid, −25,163.91 USDm
// collateral taken, +12.59 USDm fees credited, net equity +11.20 USDm at
// each hit's own oracle price.
// ---------------------------------------------------------------------------

type HitSpec = {
  block: string;
  logIndex: number;
  timestamp: string;
  debt: string; // positive wei repaid
  coll: string; // positive wei taken (net of the credited fee)
  fee: string;
  price: string; // D18 debt-per-collateral oracle rate
  debtBefore: string;
  debtAfter: string;
  collBefore: string;
  collAfter: string;
};

const TICKET_HITS: HitSpec[] = [
  {
    block: "75780824",
    logIndex: 12,
    timestamp: "1787681580", // 2026-08-25 18:13 UTC
    debt: "5021865060000000000000",
    coll: "6852500000000000000000",
    fee: "3430000000000000000",
    price: "732905000000000000",
    debtBefore: "25020000000000000000000",
    debtAfter: "19998134940000000000000",
    collBefore: "39955000000000000000000",
    collAfter: "33102500000000000000000",
  },
  {
    block: "75781400",
    logIndex: 3,
    timestamp: "1787684520",
    debt: "3664500000000000000000",
    coll: "5000100000000000000000",
    fee: "2500000000000000000",
    price: "732900000000000000",
    debtBefore: "19998134940000000000000",
    debtAfter: "16333634940000000000000",
    collBefore: "33102500000000000000000",
    collAfter: "28102400000000000000000",
  },
  {
    block: "75781980",
    logIndex: 7,
    timestamp: "1787687220",
    debt: "3298027500000000000000",
    coll: "4497710000000000000000",
    fee: "2250000000000000000",
    price: "732895000000000000",
    debtBefore: "16333634940000000000000",
    debtAfter: "13035607440000000000000",
    collBefore: "28102400000000000000000",
    collAfter: "23604690000000000000000",
  },
  {
    block: "75782500",
    logIndex: 5,
    timestamp: "1787689800",
    debt: "2931600000000000000000",
    coll: "3998600000000000000000",
    fee: "2000000000000000000",
    price: "732900000000000000",
    debtBefore: "13035607440000000000000",
    debtAfter: "10104007440000000000000",
    collBefore: "23604690000000000000000",
    collAfter: "19606090000000000000000",
  },
  {
    block: "75783000",
    logIndex: 9,
    timestamp: "1787692260", // 2026-08-25 21:11 UTC
    debt: "3534828380340000000000",
    coll: "4815000000000000000000",
    fee: "2410000000000000000",
    price: "732894000000000000",
    debtBefore: "10104007440000000000000",
    debtAfter: "6569179059660000000000",
    collBefore: "19606090000000000000000",
    collAfter: "14791090000000000000000",
  },
];

const TICKET_CUMULATIVES = {
  redemptionCount: 5,
  redeemedDebt: "18450820940340000000000", // 18,450.82 GBPm
  redeemedColl: "25163910000000000000000", // 25,163.91 USDm
  redemptionFeePaidCum: "12590000000000000000", // 12.59 USDm
};

function ticketRows(): CdpTroveLedgerEventRow[] {
  const open = ledgerRow({
    id: "42220_75600000_10",
    operation: 0,
    debtChange: "25000000000000000000000",
    debtIncreaseFromUpfrontFee: "12870000000000000000",
    collChange: "39955000000000000000000",
    debtBefore: "0",
    debtAfter: "25012870000000000000000",
    collBefore: "0",
    collAfter: "39955000000000000000000",
    statusBefore: "closed",
    statusAfter: "active",
    timestamp: "1786010400", // 2026-08-06
    blockNumber: "75600000",
    logIndex: 10,
    txHash: "0xopen",
  });
  const hits = TICKET_HITS.map((h, i) =>
    ledgerRow({
      id: `42220_${h.block}_${h.logIndex}`,
      operation: 6,
      isRebalance: true,
      debtChange: `-${h.debt}`,
      collChange: `-${h.coll}`,
      redemptionFeeCredited: h.fee,
      redemptionPrice: h.price,
      debtBefore: h.debtBefore,
      debtAfter: h.debtAfter,
      collBefore: h.collBefore,
      collAfter: h.collAfter,
      timestamp: h.timestamp,
      blockNumber: h.block,
      logIndex: h.logIndex,
      txHash: `0xredeem${i + 1}`,
    }),
  );
  const rateMove = ledgerRow({
    id: "42220_75795000_2",
    operation: 3,
    annualInterestRate: ((BigInt(160) * D18) / BigInt(10_000)).toString(),
    debtBefore: "6569179059660000000000",
    debtAfter: "6569179059660000000000",
    collBefore: "14791090000000000000000",
    collAfter: "14791090000000000000000",
    timestamp: "1787740000", // 2026-08-26
    blockNumber: "75795000",
    logIndex: 2,
    txHash: "0xrate",
  });
  const relever = ledgerRow({
    id: "42220_75796000_4",
    operation: 2,
    debtChange: "21500000000000000000000",
    collChange: "30000000000000000000000",
    debtBefore: "6569179059660000000000",
    debtAfter: "28069179059660000000000",
    collBefore: "14791090000000000000000",
    collAfter: "44791090000000000000000",
    timestamp: "1787745000",
    blockNumber: "75796000",
    logIndex: 4,
    txHash: "0xrelever",
  });
  return [open, ...hits, rateMove, relever];
}

function ticketLedgerState(
  overrides: Partial<TroveLedgerState> = {},
): TroveLedgerState {
  const rows = ticketRows();
  const watermark = anchor({
    lastLedgerBlock: "75796000",
    lastLedgerLogIndex: 4,
    ...TICKET_CUMULATIVES,
  });
  return ledgerState({
    rows,
    watermark,
    cumulatives: watermark,
    anchored: true,
    ...overrides,
  });
}

function ticketTrove(): CdpTrove {
  return trove({ ...TICKET_CUMULATIVES });
}

type Handle = { container: HTMLElement; root: Root };

let handle: Handle | null = null;

function render(
  props: Partial<React.ComponentProps<typeof TroveRedemptionImpact>> = {},
) {
  act(() => {
    handle!.root.render(
      <TroveRedemptionImpact
        trove={ticketTrove()}
        debtSymbol="GBPm"
        ledger={ticketLedgerState()}
        {...props}
      />,
    );
  });
}

function text(): string {
  return handle!.container.textContent ?? "";
}

describe("TroveRedemptionImpact", () => {
  beforeEach(() => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    handle = { container, root: createRoot(container) };
  });

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
    }
    handle = null;
  });

  it("reproduces ticket #0754 figure for figure from reconciled ledger rows", () => {
    const ledger = ticketLedgerState();
    render({ ledger });

    const body = text();
    expect(body).toContain("Redemption impact");
    // 5 hits, all via CDPLiquidityStrategy rebalancing. Scoped to the count
    // cell — a bare toContain("5") is satisfied by any amount digit.
    const countCell = Array.from(
      handle!.container.querySelectorAll("div"),
    ).find((node) => node.querySelector("p")?.textContent === "Redemptions");
    expect(countCell?.textContent).toContain("Redemptions5");
    expect(body).toContain("all rebalancing");
    expect(body).toContain("-18,450.82 GBPm");
    expect(body).toContain("-25,163.91 USDm");
    // Fees are credited TO the trove: positive.
    expect(body).toContain("+12.59 USDm");
    // Net equity at each hit's own oracle price — the deleverage was a
    // small GAIN, not a loss.
    expect(body).toContain("Net equity at oracle prices");
    expect(body).toContain("+11.20 USDm");
    // The one-line lesson.
    expect(body).toContain(
      "Collateral was exchanged for debt at the oracle rate — a deleverage, not a liquidation — and the redemption fee is credited to the trove.",
    );
    expect(body).toContain("reconciled to the trove");
    expect(body).not.toContain("Ledger reconciliation failed");
    // Reconciliation passed: no refetch fired.
    expect(ledger.refetch).not.toHaveBeenCalled();
  });

  it("labels the totals as totals in the partial view and withholds every per-hit figure", () => {
    const ledger = ledgerState({ supported: false, hasLoadedOnce: false });
    render({ ledger });

    const body = text();
    expect(body).toContain("Lifetime totals from the trove");
    expect(body).toContain("pending indexer rollout");
    // Cumulative totals still answer half the ticket (from the header row).
    expect(body).toContain("-18,450.82 GBPm");
    expect(body).toContain("-25,163.91 USDm");
    expect(body).toContain("+12.59 USDm");
    // No per-hit derivations: no split claim, no oracle valuation.
    expect(body).not.toContain("Net equity");
    expect(body).not.toContain("+11.20 USDm");
    expect(body).not.toContain("all rebalancing");
    expect(ledger.refetch).not.toHaveBeenCalled();
  });

  it("suppresses per-hit figures for a truncated history, with a status notice", () => {
    const ledger = ticketLedgerState({ truncated: true, complete: false });
    render({ ledger });

    const body = text();
    expect(body).toContain("Earliest ledger history truncated");
    expect(body).not.toContain("Net equity");
    expect(body).not.toContain("all rebalancing");
    const notices = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).map((node) => node.textContent ?? "");
    expect(notices.some((t) => t.includes("truncated"))).toBe(true);
    expect(ledger.refetch).not.toHaveBeenCalled();
  });

  it("switches to the explicit batch notice when a debt snapshot is null", () => {
    const ledger = ticketLedgerState({ debtSnapshotsComplete: false });
    render({ ledger });

    const body = text();
    expect(body).toContain("Batch data unavailable");
    expect(body).not.toContain("Net equity");
    expect(ledger.refetch).not.toHaveBeenCalled();
  });

  it("skips the check — no refetch, no warning — when the watermark does not match the newest row", () => {
    // Same block as the newest row, older logIndex: only the logIndex
    // comparison catches this skew (two distinct same-block transactions).
    const skewed = anchor({
      lastLedgerBlock: "75796000",
      lastLedgerLogIndex: 2,
      ...TICKET_CUMULATIVES,
    });
    const ledger = ticketLedgerState({
      watermark: skewed,
      cumulatives: skewed,
      anchored: false,
    });
    render({ ledger });

    const body = text();
    expect(body).toContain("resumes once the ledger");
    expect(body).not.toContain("Ledger reconciliation failed");
    expect(body).not.toContain("Net equity");
    // Totals still render.
    expect(body).toContain("-18,450.82 GBPm");
    expect(ledger.refetch).not.toHaveBeenCalled();
  });

  it("refetches once on a matched-watermark mismatch and only then renders the warning state", async () => {
    // Cumulatives claim 6 redemptions; the (anchored) rows sum to 5.
    const skewed = anchor({
      lastLedgerBlock: "75796000",
      lastLedgerLogIndex: 4,
      ...TICKET_CUMULATIVES,
      redemptionCount: 6,
    });
    const ledger = ticketLedgerState({
      watermark: skewed,
      cumulatives: skewed,
    });
    render({ ledger });

    // The one refetch fired; while it is in flight the panel shows the
    // neutral unverified totals, not the warning.
    expect(ledger.refetch).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("Ledger reconciliation failed");
    expect(text()).toContain("resumes once the ledger");

    // The refetch settles and the (unchanged) data still mismatches: now —
    // and only now — the doc-specified warning state, figures withheld.
    await act(async () => {});
    render({ ledger });
    const body = text();
    expect(body).toContain("Ledger reconciliation failed");
    expect(body).not.toContain("Net equity");
    expect(body).not.toContain("all rebalancing");
    // Cumulative totals stay on screen, labeled as totals.
    expect(body).toContain("Lifetime totals from the trove");
    // Still exactly one refetch — never a retry loop.
    expect(ledger.refetch).toHaveBeenCalledTimes(1);
    const notices = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).map((node) => node.textContent ?? "");
    expect(notices.some((t) => t.includes("reconciliation failed"))).toBe(true);
  });

  it("settles the episode into the warning state even when the one refetch rejects", async () => {
    const skewed = anchor({
      lastLedgerBlock: "75796000",
      lastLedgerLogIndex: 4,
      ...TICKET_CUMULATIVES,
      redemptionCount: 6,
    });
    const ledger = ticketLedgerState({
      watermark: skewed,
      cumulatives: skewed,
      refetch: vi.fn().mockRejectedValue(new Error("network down")),
    });
    render({ ledger });

    expect(ledger.refetch).toHaveBeenCalledTimes(1);
    expect(text()).toContain("resumes once the ledger");

    // The rejection consumed the episode's single attempt: the mismatch is
    // persistent — never a hung "unverified", never a retry loop.
    await act(async () => {});
    render({ ledger });
    expect(text()).toContain("Ledger reconciliation failed");
    expect(ledger.refetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale refetch completion from a superseded episode", async () => {
    let resolveA: () => void = () => {};
    let resolveB: () => void = () => {};
    const refetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveB = resolve;
          }),
      );
    const mismatchAnchor = (block: string, logIndex: number) =>
      anchor({
        lastLedgerBlock: block,
        lastLedgerLogIndex: logIndex,
        ...TICKET_CUMULATIVES,
        redemptionCount: 6,
      });
    const episodeA = mismatchAnchor("75796000", 4);
    const ledgerA = ticketLedgerState({
      watermark: episodeA,
      cumulatives: episodeA,
      refetch,
    });
    render({ ledger: ledgerA });
    expect(refetch).toHaveBeenCalledTimes(1);

    // Fresh (still mismatching) data lands under a NEW watermark while A's
    // refetch is in flight: a fresh episode with its own single attempt.
    // The watermark must match the newest row for the check to run, so the
    // new snapshot also carries one more (non-redemption) ledger row.
    const episodeB = mismatchAnchor("75796100", 2);
    const ledgerB = ticketLedgerState({
      rows: [
        ...ticketRows(),
        ledgerRow({
          id: "42220_75796100_2",
          blockNumber: "75796100",
          logIndex: 2,
          timestamp: "1999999999",
        }),
      ],
      watermark: episodeB,
      cumulatives: episodeB,
      refetch,
    });
    render({ ledger: ledgerB });
    expect(refetch).toHaveBeenCalledTimes(2);

    // B settles first: episode B's warning state renders.
    await act(async () => {
      resolveB();
    });
    render({ ledger: ledgerB });
    expect(text()).toContain("Ledger reconciliation failed");

    // A's late completion is stale and must not flip B back to
    // "unverified" — no further refetch exists that could re-settle it.
    await act(async () => {
      resolveA();
    });
    render({ ledger: ledgerB });
    expect(text()).toContain("Ledger reconciliation failed");
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("suppresses the net-equity figure when any hit lacks its oracle price — never priced at current rates", () => {
    const rows = ticketRows().map((row) =>
      row.id === "42220_75781400_3" ? { ...row, redemptionPrice: null } : row,
    );
    const ledger = ticketLedgerState({ rows });
    render({ ledger });

    const body = text();
    // Reconciliation still passes (prices are not reconciled figures)...
    expect(body).toContain("all rebalancing");
    expect(body).toContain("-18,450.82 GBPm");
    // ...but the equity figure is withheld with the explicit reason.
    expect(body).toContain("Net equity at oracle prices");
    expect(body).not.toContain("+11.20 USDm");
    expect(body).toContain("no oracle price on 1 hit");
  });

  it("declares the split unavailable when a hit is undiscriminated, instead of claiming user activity", () => {
    const rows = ticketRows().map((row) =>
      row.id === "42220_75783000_9" ? { ...row, isRebalance: null } : row,
    );
    const ledger = ticketLedgerState({ rows });
    render({ ledger });

    const body = text();
    expect(body).toContain("split unavailable — 1 undiscriminated hit");
    expect(body).not.toContain("all rebalancing");
    expect(body).not.toContain("user-driven");
  });

  it("splits mixed user and rebalance hits with user-driven = total − rebalance", () => {
    const rows = ticketRows().map((row) =>
      row.id === "42220_75780824_12" ? { ...row, isRebalance: false } : row,
    );
    const ledger = ticketLedgerState({ rows });
    render({ ledger });

    const body = text();
    expect(body).toContain("4 rebalancing · 1 user-driven");
    // Hit 1 (5,021.87 GBPm / 6,852.50 USDm) is the user-driven remainder.
    expect(body).toContain("user -5,021.87 GBPm · rebalance -13,428.96 GBPm");
    expect(body).toContain("user -6,852.50 USDm · rebalance -18,311.41 USDm");
  });

  it("shows the honest empty line for a trove no redemption has touched, and keeps liquidation totals", () => {
    const zero = anchor();
    render({
      trove: trove({
        liquidatedDebt: wei(1_000),
        liquidatedColl: wei(1_200),
        collSurplus: wei(50),
      }),
      ledger: ledgerState({
        rows: [],
        watermark: zero,
        cumulatives: zero,
        anchored: false,
      }),
    });

    const body = text();
    expect(body).toContain("No redemptions have touched this trove.");
    expect(body).not.toContain("Debt repaid");
    expect(body).not.toContain("deleverage");
    expect(body).toContain("Liquidation totals (lifetime)");
    expect(body).toContain("1,000.00 GBPm");
    expect(body).toContain("1,200.00 USDm");
    expect(body).toContain("Collateral surplus");
    expect(body).toContain("50.00 USDm");
  });
});

describe("hasTroveLifetimeTotals", () => {
  it("is false for an untouched trove and true for redemption or liquidation history", () => {
    expect(hasTroveLifetimeTotals(trove())).toBe(false);
    expect(hasTroveLifetimeTotals(trove({ redemptionCount: 1 }))).toBe(true);
    expect(hasTroveLifetimeTotals(trove({ liquidatedDebt: wei(1) }))).toBe(
      true,
    );
  });
});
