/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V3FlowInsights } from "../v3-flow-insights";

const mockGqlState = vi.hoisted(() => ({
  data: {
    SwapEvent: [] as unknown[],
    TraderDailySnapshot: [] as unknown[],
    TraderPoolDailySnapshot: [] as unknown[],
  },
  addressNames: new Map<string, string>(),
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: () => ({
    data: mockGqlState.data,
    error: null,
    isLoading: false,
  }),
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({
    address,
    readOnly,
    addressBookWhenAuthenticated,
    className,
    containerClassName,
  }: {
    address: string;
    readOnly?: boolean;
    addressBookWhenAuthenticated?: boolean;
    className?: string;
    containerClassName?: string;
  }) => (
    <span
      data-testid="address-link"
      data-read-only={String(Boolean(readOnly))}
      data-address-book-when-authenticated={String(
        Boolean(addressBookWhenAuthenticated),
      )}
      data-link-class={className ?? ""}
      data-container-class={containerClassName ?? ""}
    >
      {mockGqlState.addressNames.get(address.toLowerCase()) ?? address}
    </span>
  ),
}));

vi.mock("@/components/chain-icon", () => ({
  ChainIcon: () => <span data-testid="chain-icon" />,
}));

type Handle = {
  container: HTMLElement;
  root: Root;
};

function usdWei(amount: string): string {
  return (BigInt(amount) * BigInt("1000000000000000000")).toString();
}

function renderInsights(
  props: Partial<Parameters<typeof V3FlowInsights>[0]> = {},
): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <V3FlowInsights
        range="7d"
        rangeLabel="7d"
        cutoff={1_700_000_000}
        traderRows={[]}
        traders={[]}
        pools={new Map()}
        protocolActorFilter={[false]}
        exclusions={{ addresses: [], sources: [] }}
        tableState={{ isLoading: false, hasError: false, isCapHit: false }}
        {...props}
      />,
    );
  });
  return { container, root };
}

function teardown(handle: Handle): void {
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

describe("V3FlowInsights", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    mockGqlState.data = {
      SwapEvent: [],
      TraderDailySnapshot: [],
      TraderPoolDailySnapshot: [],
    };
    mockGqlState.addressNames.clear();
  });

  afterEach(() => {
    if (handle) {
      teardown(handle);
      handle = null;
    }
  });

  it("renders partial warnings before empty states for capped insight panels", () => {
    handle = renderInsights({
      tableState: { isLoading: false, hasError: false, isCapHit: true },
    });

    const text = handle.container.textContent ?? "";
    expect(text).toContain(
      "Corridor data may be incomplete; top-query cap reached.",
    );
    expect(text).toContain(
      "Outlier data may be incomplete; top-query cap reached.",
    );
    expect(text).not.toContain("No directional corridors in this window.");
    expect(text).not.toContain("No outlier swaps in this window.");
  });

  it("links outlier volume values to txs without a separate tx column", () => {
    const trader = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const txHash =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const timestamp = "1700000000";
    mockGqlState.data = {
      SwapEvent: [
        {
          id: "swap-1",
          chainId: 42220,
          poolId: "0x1111111111111111111111111111111111111111",
          caller: trader,
          txTo: "0x2222222222222222222222222222222222222222",
          recipient: "0x3333333333333333333333333333333333333333",
          volumeUsdWei: usdWei("100"),
          txHash,
          blockTimestamp: timestamp,
        },
      ],
      TraderDailySnapshot: [],
      TraderPoolDailySnapshot: [],
    };

    handle = renderInsights({
      traderRows: [
        {
          id: "day-1",
          chainId: 42220,
          trader,
          timestamp,
          swapCount: 1,
          uniquePools: 1,
          volumeUsdWei: usdWei("100"),
          feesPaidUsdWei: "0",
          isProtocolActor: false,
          aggregatorKeys: [],
          lastSeenTimestamp: timestamp,
        },
      ],
    });

    const traderLink = handle.container.querySelector<HTMLElement>(
      '[data-testid="address-link"]',
    );
    expect(traderLink?.dataset.readOnly).toBe("true");
    expect(traderLink?.dataset.addressBookWhenAuthenticated).toBe("true");
    expect(traderLink?.dataset.containerClass).toContain("whitespace-nowrap");
    expect(traderLink?.dataset.linkClass).toContain("truncate");
    expect(traderLink?.dataset.linkClass).toContain("whitespace-nowrap");

    const headers = Array.from(handle.container.querySelectorAll("th")).map(
      (th) => th.textContent,
    );
    expect(headers).not.toContain("Tx");

    const txLink = Array.from(handle.container.querySelectorAll("a")).find(
      (link) => link.getAttribute("href")?.endsWith(`/tx/${txHash}`),
    );
    expect(txLink?.textContent).toContain("$");
    expect(txLink?.textContent).not.toContain(txHash.slice(0, 6));
    expect(txLink?.getAttribute("aria-label")).toContain("outlier swap volume");
    expect(txLink?.className).toContain("max-w-full");
    expect(txLink?.className).toContain("truncate");
    expect(txLink?.closest("table")?.className).not.toContain("min-w");
    expect(txLink?.closest("table")?.parentElement?.className).not.toContain(
      "overflow-x-auto",
    );
  });

  it("constrains long resolved trader names and high outlier volumes", () => {
    const trader = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const txHash =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const timestamp = "1700000000";
    const longName =
      "Very Long Institutional Counterparty Name With Operational Desk Routing And Rebalancing Label That Should Never Crowd Out Volume";
    const highVolume = usdWei("123456789012345678901234");
    mockGqlState.addressNames.set(trader, longName);
    mockGqlState.data = {
      SwapEvent: [
        {
          id: "swap-1",
          chainId: 42220,
          poolId: "0x1111111111111111111111111111111111111111",
          caller: trader,
          txTo: "0x2222222222222222222222222222222222222222",
          recipient: "0x3333333333333333333333333333333333333333",
          volumeUsdWei: highVolume,
          txHash,
          blockTimestamp: timestamp,
        },
      ],
      TraderDailySnapshot: [],
      TraderPoolDailySnapshot: [],
    };

    handle = renderInsights({
      traderRows: [
        {
          id: "day-1",
          chainId: 42220,
          trader,
          timestamp,
          swapCount: 1,
          uniquePools: 1,
          volumeUsdWei: highVolume,
          feesPaidUsdWei: "0",
          isProtocolActor: false,
          aggregatorKeys: [],
          lastSeenTimestamp: timestamp,
        },
      ],
    });

    const outlierHeading = Array.from(
      handle.container.querySelectorAll("h3"),
    ).find((heading) => heading.textContent === "Outlier swaps");
    const outlierTable = outlierHeading?.parentElement?.querySelector("table");
    const outlierTraderLink = outlierTable?.querySelector<HTMLElement>(
      '[data-testid="address-link"]',
    );
    const outlierTxLink = outlierTable?.querySelector<HTMLAnchorElement>(
      `a[href$="/tx/${txHash}"]`,
    );
    const traderCell = outlierTraderLink?.closest("td");
    const volumeCell = outlierTxLink?.closest("td");

    expect(outlierTraderLink?.textContent).toBe(longName);
    expect(traderCell?.className).toContain("w-[42%]");
    expect(traderCell?.className).toContain("max-w-0");
    expect(traderCell?.className).toContain("overflow-hidden");
    expect(outlierTraderLink?.dataset.containerClass).toContain("min-w-0");
    expect(outlierTraderLink?.dataset.containerClass).toContain(
      "overflow-hidden",
    );
    expect(outlierTraderLink?.dataset.linkClass).toContain("min-w-0");
    expect(outlierTraderLink?.dataset.linkClass).toContain("truncate");
    expect(volumeCell?.className).toContain("w-[24%]");
    expect(volumeCell?.className).toContain("max-w-0");
    expect(volumeCell?.className).toContain("overflow-hidden");
    expect(outlierTxLink?.className).toContain("max-w-full");
    expect(outlierTxLink?.className).toContain("truncate");
    expect(outlierTxLink?.textContent).toContain("$");
    expect(outlierTxLink?.title).toContain(txHash);
    expect(outlierTxLink).not.toBeNull();
    const visibleVolume = outlierTxLink?.textContent ?? "";
    expect(outlierTxLink?.title).toContain(visibleVolume);
  });
});
