/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpCollateral, CdpTrove } from "../../../_lib/types";
import type { TroveDisplayRow } from "../trove-sort";

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => (
    <span data-testid="address-link">{address}</span>
  ),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { TroveRow } from "../trove-cells";

const NOW = 1_767_225_600;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USD_WEI = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function collateral(overrides: Partial<CdpCollateral> = {}): CdpCollateral {
  return {
    id: "42220-0xgbpm",
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
    id: "42220-0xgbpm-0x1abc",
    troveId: "0x1abc",
    owner: "0xowner",
    previousOwner: ZERO_ADDRESS,
    status: "active",
    debt: wei(25_000),
    coll: wei(40_000),
    icrBps: 16_000,
    interestRate: "16000000000000000",
    interestBatchId: null,
    openedAt: String(NOW - 86_400),
    openedTxHash: "0xopen",
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: String(NOW - 3_600),
    lastUpdatedTxHash: null,
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

function displayRow(overrides: Partial<TroveDisplayRow> = {}): TroveDisplayRow {
  return {
    trove: trove(),
    effectiveRate: BigInt(wei(1)) / BigInt(100),
    rank: 1,
    tied: false,
    rateSource: "direct",
    ...overrides,
  };
}

type Handle = { container: HTMLElement; root: Root };

let handle: Handle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  const container = document.createElement("div");
  document.body.appendChild(container);
  handle = { container, root: createRoot(container) };
});

afterEach(() => {
  if (handle) {
    act(() => {
      handle!.root.unmount();
    });
    handle.container.remove();
  }
  handle = null;
  vi.useRealTimers();
});

function render(node: React.ReactNode) {
  act(() => {
    handle!.root.render(
      <table>
        <tbody>{node}</tbody>
      </table>,
    );
  });
}

function troveHistoryLink(): HTMLAnchorElement | null {
  return handle!.container.querySelector<HTMLAnchorElement>(
    'a[href^="/cdps/"]',
  );
}

describe("TroveRow trove-id entry link", () => {
  it("open tab: links the trove id to the market-scoped history page, keeping the owner explorer link", () => {
    render(
      <TroveRow row={displayRow()} collateral={collateral()} view="open" />,
    );

    const link = troveHistoryLink();
    expect(link?.getAttribute("href")).toBe("/cdps/gbpm/troves/0x1abc");
    expect(link?.getAttribute("aria-label")).toBe(
      "View history for trove 0x1abc",
    );
    expect(link?.getAttribute("title")).toBe("0x1abc");
    expect(link?.textContent).toBe("0x1abc");
    // No external Mento-app link left in the cell — the manage action lives
    // on the history page header now.
    expect(
      handle!.container.querySelector('a[href^="https://app.mento.org"]'),
    ).toBeNull();
    // The owner's explorer/address-book affordance survives as-is.
    expect(
      handle!.container.querySelector('[data-testid="address-link"]')
        ?.textContent,
    ).toBe("0xowner");
  });

  it("history tab: closed troves link through, addressed by their last owner", () => {
    const closed = trove({
      owner: ZERO_ADDRESS,
      previousOwner: "0xlastowner",
      status: "redeemed",
      closedAt: String(NOW - 600),
      closedTxHash: "0xclose",
    });
    render(
      <TroveRow
        row={displayRow({ trove: closed, rank: null, rateSource: null })}
        collateral={collateral()}
        view="history"
      />,
    );

    expect(troveHistoryLink()?.getAttribute("href")).toBe(
      "/cdps/gbpm/troves/0x1abc",
    );
    // NFT burn zeroes `owner` on close — the cell falls back to the last
    // real owner instead of linking 0x000…000.
    expect(
      handle!.container.querySelector('[data-testid="address-link"]')
        ?.textContent,
    ).toBe("0xlastowner");
  });

  it("carries the market scope in the path — the raw troveId collides across markets", () => {
    render(
      <TroveRow
        row={displayRow()}
        collateral={collateral({ id: "42220-0xchfm", symbol: "CHFm" })}
        view="open"
      />,
    );

    expect(troveHistoryLink()?.getAttribute("href")).toBe(
      "/cdps/chfm/troves/0x1abc",
    );
  });

  it("middle-ellipsizes a long trove id in the link text, keeping the full id in the title", () => {
    const longId =
      "0x5f23a9b8f4c249163a0d7969d2fc23af8de9e84d3f63b44136bfd18ea3e73ac4";
    render(
      <TroveRow
        row={displayRow({ trove: trove({ troveId: longId }) })}
        collateral={collateral()}
        view="open"
      />,
    );

    const link = troveHistoryLink();
    expect(link?.getAttribute("href")).toBe(`/cdps/gbpm/troves/${longId}`);
    expect(link?.textContent).toBe("0x5f23…3ac4");
    expect(link?.getAttribute("title")).toBe(longId);
  });
});
