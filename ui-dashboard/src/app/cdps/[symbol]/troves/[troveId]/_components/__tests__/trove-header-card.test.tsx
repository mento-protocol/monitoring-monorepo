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

function rateWei(bps: number): string {
  return ((BigInt(bps) * D18) / BigInt(10_000)).toString();
}

const DEFAULT_RATE = rateWei(160); // 1.60%

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
    interestRate: DEFAULT_RATE,
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
      <TroveHeaderCard
        trove={trove()}
        collateral={collateral()}
        displayedInterestRate={DEFAULT_RATE}
      />,
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
      <TroveHeaderCard
        trove={trove()}
        collateral={collateral()}
        displayedInterestRate={DEFAULT_RATE}
      />,
    );
    expect(handle.container.textContent).toContain(
      "not a live RPC or oracle read",
    );
  });

  it("does not claim the footer timestamp as a debt/price observation time — it can be a pure ownership transfer", () => {
    // indexer-envio/src/handlers/liquity/troveNFT.ts bumps lastUpdatedAt on
    // every NFT Transfer (mint/burn/transfer), not only on a debt- or
    // collateral-changing TroveOperation — so the footer must not claim
    // "values" (debt, ICR) were captured exactly at that timestamp.
    handle = render(
      <TroveHeaderCard
        trove={trove()}
        collateral={collateral()}
        displayedInterestRate={DEFAULT_RATE}
      />,
    );
    expect(handle.container.textContent).toContain("ownership transfer");
  });

  it("discloses the same ownership-transfer caveat on the Debt and ICR tooltips", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove()}
        collateral={collateral()}
        displayedInterestRate={DEFAULT_RATE}
      />,
    );
    const tooltipTexts = Array.from(
      handle.container.querySelectorAll('[role="tooltip"]'),
    ).map((el) => el.textContent ?? "");
    const debtTooltip = tooltipTexts.find((t) => t.includes("debt change"));
    const icrTooltip = tooltipTexts.find((t) => t.includes("price/debt"));
    expect(debtTooltip).toContain("ownership transfer");
    expect(icrTooltip).toContain("ownership transfer");
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
        displayedInterestRate={DEFAULT_RATE}
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
        displayedInterestRate={DEFAULT_RATE}
      />,
    );
    expect(handle.container.textContent).toContain("Last updated");
  });

  it("marks a batch-managed rate with the 'Batch' label", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({ interestBatchId: "batch-1" })}
        collateral={collateral()}
        displayedInterestRate={rateWei(250)}
      />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).toContain("Batch");
    expect(text).toContain("2.50%");
  });

  it("does not show the 'Batch' label for a non-batch-managed trove", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({ interestBatchId: null })}
        collateral={collateral()}
        displayedInterestRate={DEFAULT_RATE}
      />,
    );
    expect(handle.container.textContent).not.toContain("Batch");
  });

  it("renders whatever displayedInterestRate the caller resolved, verbatim — the header does no batch-vs-trove fallback itself", () => {
    // trove-detail-client.tsx owns the batch-join resolution (including the
    // "never show trove.interestRate as a stand-in for an unresolved join"
    // rule); the header is a pure display of the already-resolved value.
    handle = render(
      <TroveHeaderCard
        trove={trove({
          interestBatchId: "batch-1",
          interestRate: DEFAULT_RATE,
        })}
        collateral={collateral()}
        displayedInterestRate={rateWei(250)}
      />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).toContain("2.50%");
    expect(text).not.toContain("1.60%");
  });

  it("shows '—' (unavailable) when the caller passes null — e.g. batch join pending, failed, or empty", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove({
          interestBatchId: "batch-1",
          interestRate: DEFAULT_RATE,
        })}
        collateral={collateral()}
        displayedInterestRate={null}
      />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).not.toContain("1.60%");
    expect(text).toContain("Batch");
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
        displayedInterestRate={DEFAULT_RATE}
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
        displayedInterestRate={DEFAULT_RATE}
      />,
    );
    const link = handle.container.querySelector<HTMLAnchorElement>(
      "a[href^='mock-address://']",
    );
    expect(link?.getAttribute("href")).toBe("mock-address://0xliveowner");
  });

  it("is keyboard-focusable on every asChild tooltip trigger (status badge + ICR)", () => {
    handle = render(
      <TroveHeaderCard
        trove={trove()}
        collateral={collateral()}
        displayedInterestRate={DEFAULT_RATE}
      />,
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
        displayedInterestRate={DEFAULT_RATE}
      />,
    );
    const icrSpan = handle.container.querySelector(".text-rose-300");
    expect(icrSpan?.textContent).toBe("100.00%");
  });
});
