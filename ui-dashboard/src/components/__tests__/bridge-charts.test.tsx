import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BridgeTopBridgersChart } from "@/components/bridge-top-bridgers-chart";
import { BridgeVolumeChart } from "@/components/bridge-volume-chart";
import { BridgeTokenBreakdownChart } from "@/components/bridge-token-breakdown-chart";

// Chart components can't be rendered through the full React lifecycle in a
// node environment (dynamic Plotly import, hooks, client-only features). The
// purpose of these tests is to guard the empty / loading / error code paths
// from crashing when schema or prop shapes drift — the pure data helpers are
// already covered by unit tests.
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
}));
vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: { id: "celo-mainnet", chainId: 42220 } }),
}));
vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: (addr: string) => addr.slice(0, 10),
    hasName: () => false,
    isCustom: () => false,
    getEntry: () => null,
  }),
}));

describe("BridgeVolumeChart smoke", () => {
  it("renders without error on empty inputs", () => {
    expect(() =>
      renderToStaticMarkup(
        <BridgeVolumeChart
          snapshots={[]}
          rates={new Map()}
          isLoading={false}
          hasError={false}
        />,
      ),
    ).not.toThrow();
  });

  it("renders in the error state without crashing", () => {
    expect(() =>
      renderToStaticMarkup(
        <BridgeVolumeChart
          snapshots={[]}
          rates={new Map()}
          isLoading={false}
          hasError
        />,
      ),
    ).not.toThrow();
  });

  it("shows N/A (not $0) in the headline when the snapshot query errored", () => {
    // Regression: a failed snapshot fetch used to render "$0" — visually
    // indistinguishable from a legitimate empty window. Force the error
    // branch to present an explicit failure state.
    const html = renderToStaticMarkup(
      <BridgeVolumeChart
        snapshots={[]}
        rates={new Map()}
        isLoading={false}
        hasError
      />,
    );
    expect(html).toContain("N/A");
    expect(html).not.toContain(">$0<");
  });
});

describe("BridgeTokenBreakdownChart smoke", () => {
  it("renders the empty state when there are no snapshots", () => {
    const html = renderToStaticMarkup(
      <BridgeTokenBreakdownChart
        snapshots={[]}
        rates={new Map()}
        isLoading={false}
        hasError={false}
      />,
    );
    expect(html).toContain("No priced volume in the selected window.");
  });

  it("renders the error branch without crashing", () => {
    const html = renderToStaticMarkup(
      <BridgeTokenBreakdownChart
        snapshots={[]}
        rates={new Map()}
        isLoading={false}
        hasError
      />,
    );
    expect(html).toContain("Unable to load token breakdown.");
  });
});

describe("BridgeTopBridgersChart smoke", () => {
  it("renders the empty state with no bridgers", () => {
    const html = renderToStaticMarkup(
      <BridgeTopBridgersChart
        bridgers={[]}
        isLoading={false}
        hasError={false}
      />,
    );
    expect(html).toContain("No bridgers yet.");
  });

  it("renders the error branch without crashing", () => {
    const html = renderToStaticMarkup(
      <BridgeTopBridgersChart bridgers={[]} isLoading={false} hasError />,
    );
    expect(html).toContain("Unable to load top bridgers.");
  });

  it("renders a populated list without crashing", () => {
    const html = renderToStaticMarkup(
      <BridgeTopBridgersChart
        bridgers={[
          {
            id: "0xaaa",
            sender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            totalSentCount: 42,
            totalSentUsd: null,
            sourceChainsUsed: "[42220]",
            tokensUsed: '["USDm"]',
            providersUsed: '["WORMHOLE"]',
            firstSeenAt: "0",
            lastSeenAt: "0",
          },
        ]}
        isLoading={false}
        hasError={false}
      />,
    );
    expect(html).toContain("transfers");
  });
});
