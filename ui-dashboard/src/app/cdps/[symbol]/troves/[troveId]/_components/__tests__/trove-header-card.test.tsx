/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpCollateral, CdpTrove } from "../../../../../_lib/types";

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => (
    <a href={`mock-address://${address}`}>{address}</a>
  ),
}));

import { TroveHeaderCard } from "../trove-header-card";

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
    interestRate: ((BigInt(160) * D18) / BigInt(10_000)).toString(),
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

type Handle = { container: HTMLDivElement; root: Root };

describe("TroveHeaderCard", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
  });

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
      handle = null;
    }
    vi.useRealTimers();
  });

  function render(node: React.ReactElement): Handle {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(node);
    });
    return { container, root };
  }

  it("renders symbol, trove id, status badge, manage link, rate, coll, debt, and ICR", () => {
    handle = render(
      <TroveHeaderCard trove={trove()} collateral={collateral()} />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).toContain("GBPm");
    expect(text).toContain("Trove 0x8abc");
    expect(text).toContain("Active");
    expect(text).toContain("1.60%");
    expect(text).toContain("44,791.00 USDm");
    expect(text).toContain("28,081.00 GBPm");
    expect(text).toContain("117.10%");
    expect(text).toContain("MCR 110.00%");

    const manageLink = handle.container.querySelector<HTMLAnchorElement>(
      'a[href="https://app.mento.org/borrow/manage/0x8abc?token=GBPm"]',
    );
    expect(manageLink).not.toBeNull();
    expect(manageLink?.target).toBe("_blank");
  });

  it("discloses the debt figure is recorded-at-last-event, not a live read", () => {
    handle = render(
      <TroveHeaderCard trove={trove()} collateral={collateral()} />,
    );
    expect(handle.container.textContent).toContain(
      "not a live RPC or oracle read",
    );
  });

  it("shows 'Closed' with the closing tx for a closed/liquidated/redeemed trove", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({
          status: "redeemed",
          closedAt: String(NOW - 10),
          closedTxHash: "0xclosed",
        })}
        collateral={collateral()}
      />,
    );
    expect(handle.container.textContent).toContain("Closed");
    const link = handle.container.querySelector<HTMLAnchorElement>(
      'a[href$="/tx/0xclosed"]',
    );
    expect(link).not.toBeNull();
  });

  it("shows 'Last updated' (not 'Closed') for an open trove", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({ status: "active" })}
        collateral={collateral()}
      />,
    );
    expect(handle.container.textContent).toContain("Last updated");
  });

  it("marks a batch-managed rate", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({ interestRate: "0", interestBatchId: "batch-1" })}
        collateral={collateral()}
      />,
    );
    expect(handle.container.textContent).toContain("Batch");
  });

  it("falls back to the trove's own rate while the batch join is unresolved", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({
          interestRate: ((BigInt(160) * D18) / BigInt(10_000)).toString(),
          interestBatchId: "batch-1",
        })}
        collateral={collateral()}
      />,
    );
    expect(handle.container.textContent).toContain("1.60%");
  });

  it("prefers the joined InterestBatch rate over a stale trove.interestRate", () => {
    // Trove.interestRate can retain the previously-copied rate after the
    // batch manager changes the batch's rate — the effective rate is
    // whatever InterestBatch.annualInterestRate currently holds.
    handle = render(
      <TroveHeaderCard
        trove={trove({
          interestRate: ((BigInt(160) * D18) / BigInt(10_000)).toString(),
          interestBatchId: "batch-1",
        })}
        collateral={collateral()}
        batchAnnualInterestRate={(
          (BigInt(250) * D18) /
          BigInt(10_000)
        ).toString()}
      />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).toContain("2.50%");
    expect(text).not.toContain("1.60%");
  });

  it("ignores batchAnnualInterestRate for a trove with no interestBatchId", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({
          interestRate: ((BigInt(160) * D18) / BigInt(10_000)).toString(),
          interestBatchId: null,
        })}
        collateral={collateral()}
        batchAnnualInterestRate={(
          (BigInt(250) * D18) /
          BigInt(10_000)
        ).toString()}
      />,
    );
    expect(handle.container.textContent).toContain("1.60%");
  });

  it("links the owner to previousOwner when the NFT has burned (owner zeroed)", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({
          owner: "0x0000000000000000000000000000000000000000",
          previousOwner: "0xformerowner",
          status: "redeemed",
        })}
        collateral={collateral()}
      />,
    );
    const link = handle.container.querySelector<HTMLAnchorElement>(
      "a[href^='mock-address://']",
    );
    expect(link?.getAttribute("href")).toBe("mock-address://0xformerowner");
  });

  it("links the owner to the live owner when the trove hasn't burned", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({
          owner: "0xliveowner",
          previousOwner: "0x0000000000000000000000000000000000000000",
        })}
        collateral={collateral()}
      />,
    );
    const link = handle.container.querySelector<HTMLAnchorElement>(
      "a[href^='mock-address://']",
    );
    expect(link?.getAttribute("href")).toBe("mock-address://0xliveowner");
  });

  it("is keyboard-focusable on every asChild tooltip trigger (status badge + ICR)", () => {
    handle = render(
      <TroveHeaderCard trove={trove()} collateral={collateral()} />,
    );
    // The Debt stat's tooltip uses the default `<button>` trigger. The
    // status badge and ICR stat both clone a `<button>` via `asChild` too
    // (not a plain `<span>`, which jsx-a11y/no-noninteractive-tabindex
    // rejects as a tabIndex target) — every tooltip trigger on this card is
    // reachable by Tab.
    const triggers = handle.container.querySelectorAll("[aria-describedby]");
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(trigger.tagName).toBe("BUTTON");
      expect((trigger as HTMLButtonElement).tabIndex).toBe(0);
    }
  });

  it("colors ICR below MCR as danger", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({ icrBps: 10_000 })}
        collateral={collateral({ mcrBps: 11_000 })}
      />,
    );
    const icrSpan = handle.container.querySelector(".text-rose-300");
    expect(icrSpan?.textContent).toBe("100.00%");
  });
});
