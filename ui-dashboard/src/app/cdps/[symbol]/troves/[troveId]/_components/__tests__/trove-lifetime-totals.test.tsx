/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CdpTrove } from "../../../../../_lib/types";
import { TroveLifetimeTotals } from "../trove-lifetime-totals";

const D18 = BigInt(10) ** BigInt(18);
function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function trove(overrides: Partial<CdpTrove> = {}): CdpTrove {
  return {
    id: "gbpm-0x1",
    troveId: "0x1",
    owner: "0xowner",
    previousOwner: "0x0000000000000000000000000000000000000000",
    status: "active",
    debt: wei(100),
    coll: wei(200),
    icrBps: 20_000,
    interestRate: "0",
    interestBatchId: null,
    openedAt: "1000",
    openedTxHash: "0xopened",
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: "1000",
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

type Handle = { container: HTMLDivElement; root: Root };

function render(node: React.ReactElement): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

describe("TroveLifetimeTotals", () => {
  let handle: Handle | null = null;

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
      handle = null;
    }
  });

  it("renders nothing when the trove has no redemption or liquidation history", () => {
    handle = render(<TroveLifetimeTotals trove={trove()} debtSymbol="GBPm" />);
    expect(handle.container.innerHTML).toBe("");
  });

  it("shows redemption totals as raw sums, never a net-equity figure", () => {
    handle = render(
      <TroveLifetimeTotals
        trove={trove({
          redemptionCount: 5,
          redeemedDebt: wei(18_451),
          redeemedColl: wei(25_164),
          redemptionFeePaidCum: wei(12),
        })}
        debtSymbol="GBPm"
      />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).toContain("5");
    expect(text).toContain("18,451.00 GBPm");
    expect(text).toContain("25,164.00 USDm");
    expect(text).toContain("12.00 USDm");
    expect(text).not.toContain("net equity");
    expect(text).not.toContain("Net equity");
  });

  it("shows liquidation totals and a surplus line only when a surplus exists", () => {
    handle = render(
      <TroveLifetimeTotals
        trove={trove({
          liquidatedDebt: wei(7),
          liquidatedColl: wei(9),
          collSurplus: "0",
        })}
        debtSymbol="GBPm"
      />,
    );
    let text = handle.container.textContent ?? "";
    expect(text).toContain("7.00 GBPm");
    expect(text).toContain("9.00 USDm");
    expect(text).not.toContain("Collateral surplus");

    act(() => handle!.root.unmount());
    handle.container.remove();

    handle = render(
      <TroveLifetimeTotals
        trove={trove({
          liquidatedDebt: wei(7),
          liquidatedColl: wei(9),
          collSurplus: wei(1),
        })}
        debtSymbol="GBPm"
      />,
    );
    text = handle.container.textContent ?? "";
    expect(text).toContain("Collateral surplus");
    expect(text).toContain("1.00 USDm");
  });
});
