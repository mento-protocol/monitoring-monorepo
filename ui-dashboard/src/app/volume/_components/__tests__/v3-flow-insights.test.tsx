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
      {address}
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
        systemAddressFilter={[false]}
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

  it("renders compact outlier trader and tx cells", () => {
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
          volumeUsdWei: "100000000000000000000",
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
          volumeUsdWei: "100000000000000000000",
          feesPaidUsdWei: "0",
          isSystemAddress: false,
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

    const txLink = Array.from(handle.container.querySelectorAll("a")).find(
      (link) => link.getAttribute("href")?.endsWith(`/tx/${txHash}`),
    );
    expect(txLink?.className).toContain("whitespace-nowrap");
    expect(txLink?.closest("td")?.className).toContain("whitespace-nowrap");
  });
});
