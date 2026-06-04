/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { V3FlowInsights } from "../v3-flow-insights";

vi.mock("@/lib/graphql", () => ({
  useGQL: () => ({
    data: {
      SwapEvent: [],
      TraderDailySnapshot: [],
      TraderPoolDailySnapshot: [],
    },
    error: null,
    isLoading: false,
  }),
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
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
});
