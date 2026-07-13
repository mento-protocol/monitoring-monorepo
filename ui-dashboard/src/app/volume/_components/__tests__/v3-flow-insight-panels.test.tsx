/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LpFriendliness } from "@/lib/volume-insights";
import {
  CohortPanel,
  CorridorPanel,
  OutlierPanel,
} from "../v3-flow-insight-panels";

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => (
    <span data-testid="address-link">{address}</span>
  ),
}));

vi.mock("@/components/chain-icon", () => ({
  ChainIcon: () => <span data-testid="chain-icon" />,
}));

type Handle = {
  container: HTMLElement;
  root: Root;
};

function renderInto(element: React.ReactElement): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function teardown(handle: Handle): void {
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

const LP: LpFriendliness = {
  score: 0.5,
  ratio: 1,
  feeRateBps: 30,
  imbalance: 0,
  pressureUsdWei: BigInt(0),
  band: "balanced",
};

describe("CohortPanel loading state", () => {
  let handle: Handle | null = null;

  afterEach(() => {
    if (handle) {
      teardown(handle);
      handle = null;
    }
  });

  it("reserves the 3-stat mini grid + 3 leader rows + caption line, matching the loaded structure", () => {
    handle = renderInto(
      <CohortPanel
        range="7d"
        summary={null}
        isLoading
        hasError={false}
        isPartial={false}
      />,
    );
    const status = handle.container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading cohort comparison"]',
    );
    expect(status).not.toBeNull();
    const statGrid = status!.querySelector(".grid-cols-3");
    expect(statGrid).not.toBeNull();
    expect(statGrid!.children).toHaveLength(3);
    const leaderRows = status!.querySelectorAll(
      ".flex.items-center.justify-between.gap-3",
    );
    expect(leaderRows).toHaveLength(3);
    teardown(handle);

    handle = renderInto(
      <CohortPanel
        range="7d"
        summary={{
          newCount: 4,
          returningCount: 5,
          dormantCount: 6,
          topNewTrader: null,
          topReturningTrader: null,
          topDormantTrader: null,
          currentCount: 20,
          previousCount: 10,
        }}
        isLoading={false}
        hasError={false}
        isPartial={false}
      />,
    );
    const loadedGrid = handle.container.querySelector(".grid-cols-3");
    expect(loadedGrid).not.toBeNull();
    expect(loadedGrid!.children).toHaveLength(3);
    const loadedLeaderRows = handle.container.querySelectorAll(
      ".flex.items-center.justify-between.gap-3",
    );
    expect(loadedLeaderRows).toHaveLength(3);
  });

  it("does not reserve the mini-stat grid on the error or unbounded-range branches", () => {
    handle = renderInto(
      <CohortPanel
        range="all"
        summary={null}
        isLoading={false}
        hasError={false}
        isPartial={false}
      />,
    );
    expect(handle.container.querySelector(".grid-cols-3")).toBeNull();
    teardown(handle);

    handle = renderInto(
      <CohortPanel
        range="7d"
        summary={null}
        isLoading={false}
        hasError
        isPartial={false}
      />,
    );
    expect(handle.container.querySelector(".grid-cols-3")).toBeNull();
    expect(handle.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("CorridorPanel loading state", () => {
  let handle: Handle | null = null;

  afterEach(() => {
    if (handle) {
      teardown(handle);
      handle = null;
    }
  });

  it("renders a dense 4-column table skeleton while loading, matching the real table's column count", () => {
    handle = renderInto(
      <CorridorPanel
        rows={[]}
        pools={new Map()}
        isLoading
        hasError={false}
        isPartial={false}
      />,
    );
    const status = handle.container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading corridor map"]',
    );
    expect(status).not.toBeNull();
    const [header] = Array.from(status!.children) as [HTMLElement];
    expect(header.children).toHaveLength(4);
    teardown(handle);

    handle = renderInto(
      <CorridorPanel
        rows={[
          {
            key: "row-1",
            chainId: 42220,
            poolId: "42220-0xpool",
            direction: 0,
            traderCount: 1,
            swapCount: 1,
            volumeUsdWei: BigInt(0),
            netPressureUsdWei: BigInt(0),
            feesPaidUsdWei: BigInt(0),
            lpFriendliness: LP,
          },
        ]}
        pools={new Map()}
        isLoading={false}
        hasError={false}
        isPartial={false}
      />,
    );
    const headerCells = handle.container.querySelectorAll("thead th");
    expect(headerCells).toHaveLength(4);
  });
});

describe("OutlierPanel loading state", () => {
  let handle: Handle | null = null;

  afterEach(() => {
    if (handle) {
      teardown(handle);
      handle = null;
    }
  });

  it("renders a dense 3-column table skeleton while loading, matching the real table's column count", () => {
    handle = renderInto(
      <OutlierPanel
        rows={[]}
        pools={new Map()}
        isLoading
        hasError={false}
        isPartial={false}
      />,
    );
    const status = handle.container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading outlier swaps"]',
    );
    expect(status).not.toBeNull();
    const [header] = Array.from(status!.children) as [HTMLElement];
    expect(header.children).toHaveLength(3);
    teardown(handle);

    handle = renderInto(
      <OutlierPanel
        rows={[
          {
            id: "swap-1",
            chainId: 42220,
            poolId: "42220-0xpool",
            caller: "0xtrader",
            txTo: "0xrouter",
            recipient: "0xtrader",
            volumeUsdWei: (BigInt(10) * BigInt(10) ** BigInt(18)).toString(),
            txHash: `0x${"a".repeat(64)}`,
            blockTimestamp: "1700000000",
          },
        ]}
        pools={new Map()}
        isLoading={false}
        hasError={false}
        isPartial={false}
      />,
    );
    const headerCells = handle.container.querySelectorAll("thead th");
    expect(headerCells).toHaveLength(3);
  });
});
