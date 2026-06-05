/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrokerTraderRouterMarkerRow,
  BrokerTraderWindowRow,
  TraderPoolDailyRow,
  TraderWindowRow,
} from "@/lib/volume";

let mockSearchParams = new URLSearchParams();
const mockUseGQL = vi.hoisted(() => vi.fn());
const mockUseBrokerViaMarkers = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/lib/networks", () => ({
  networkForChainId: (chainId: number) => ({
    id: chainId === 143 ? "monad-mainnet" : "celo-mainnet",
    label: chainId === 143 ? "Monad" : "Celo",
    chainId,
    tokenSymbols: {
      "0xtoken0": "USDC",
      "0xtoken1": "USDm",
    },
  }),
}));

vi.mock("@/lib/tokens", () => ({
  poolName: (_network: unknown, token0: string | null, token1: string | null) =>
    `${token0 ?? "?"}/${token1 ?? "?"}`,
}));

vi.mock("@/components/chain-icon", () => ({
  ChainIcon: ({ network }: { network: { label: string } }) => (
    <span data-testid="chain-icon">{network.label}</span>
  ),
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({
    address,
    chainId,
  }: {
    address: string;
    chainId?: number;
  }) => (
    <a href={`mock-address://${chainId ?? "default"}/${address}`}>{address}</a>
  ),
}));

vi.mock("../../_lib/use-broker-via-markers", () => ({
  useBrokerViaMarkers: (...args: unknown[]) => mockUseBrokerViaMarkers(...args),
}));

import { VolumeTable } from "../volume-table";
import { V2VolumeTraderTable } from "../v2-volume-tables";

const USD_WEI = BigInt(10) ** BigInt(18);
const CUTOFF = 1_767_225_600;
const POOL_ID = "42220-0xpool000000000000000000000000000000000000";

function usdWei(amount: number): bigint {
  return BigInt(amount) * USD_WEI;
}

function trader(overrides: Partial<TraderWindowRow>): TraderWindowRow {
  return {
    chainId: 42220,
    trader: "0xtrader",
    swapCount: 1,
    uniquePoolsApprox: 1,
    volumeUsdWei: usdWei(1),
    feesPaidUsdWei: usdWei(0),
    isProtocolActor: false,
    lastSeenTimestamp: CUTOFF,
    ...overrides,
  };
}

function v2Trader(
  overrides: Partial<BrokerTraderWindowRow>,
): BrokerTraderWindowRow {
  return {
    chainId: 42220,
    trader: "0xtrader",
    swapCount: 1,
    volumeUsdWei: usdWei(1),
    isProtocolActor: false,
    lastSeenTimestamp: CUTOFF,
    ...overrides,
  };
}

function poolDaily(overrides: Partial<TraderPoolDailyRow>): TraderPoolDailyRow {
  return {
    id: "pool-day-1",
    chainId: 42220,
    trader: "0xtrader",
    poolId: POOL_ID,
    timestamp: String(CUTOFF),
    swapCount: 2,
    volumeUsdWei: usdWei(25).toString(),
    inflowToken0UsdWei: usdWei(10).toString(),
    outflowToken0UsdWei: usdWei(10).toString(),
    inflowToken1UsdWei: usdWei(8).toString(),
    outflowToken1UsdWei: usdWei(8).toString(),
    feesPaidUsdWei: usdWei(1).toString(),
    ...overrides,
  };
}

function viaMarker(
  overrides: Partial<BrokerTraderRouterMarkerRow>,
): BrokerTraderRouterMarkerRow {
  return {
    id: "marker-1",
    chainId: 42220,
    caller: "0xtrader",
    txTo: "0xrouter",
    aggregator: "squid",
    timestamp: String(CUTOFF),
    ...overrides,
  };
}

type Handle = {
  container: HTMLElement;
  root: Root;
};

function setupDom(url = "/volume"): Handle {
  window.history.replaceState(window.history.state, "", url);
  mockSearchParams = new URLSearchParams(window.location.search);
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function teardown(handle: Handle | null): void {
  if (!handle) return;
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

function headerButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const match = Array.from(
    container.querySelectorAll<HTMLButtonElement>("thead button"),
  ).find((button) => (button.textContent ?? "").trim().startsWith(label));
  if (!match) throw new Error(`No header button matched ${label}`);
  return match;
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll("tbody > tr"));
}

function renderVolumeTable(
  handle: Handle,
  props: Partial<Parameters<typeof VolumeTable>[0]> = {},
) {
  act(() => {
    handle.root.render(
      <VolumeTable
        cutoff={CUTOFF}
        traders={[]}
        pools={
          new Map([[POOL_ID.toLowerCase(), { token0: "USDC", token1: "USDm" }]])
        }
        emptyMessage="No traders matched this window. Try widening the range or including protocol actors."
        isLoading={false}
        hasError={false}
        {...props}
      />,
    );
  });
}

function renderV2Table(
  handle: Handle,
  props: Partial<Parameters<typeof V2VolumeTraderTable>[0]> = {},
) {
  act(() => {
    handle.root.render(
      <V2VolumeTraderTable
        cutoff={CUTOFF}
        traders={[]}
        emptyMessage="No legacy-v2 traders in this window. Either v2 volume has stopped, or try widening the range / including protocol actors."
        isLoading={false}
        hasError={false}
        {...props}
      />,
    );
  });
}

describe("VolumeTable", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGQL.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });
    handle = setupDom();
  });

  afterEach(() => {
    teardown(handle);
    handle = null;
  });

  it("renders loading, error, and empty degraded states", () => {
    renderVolumeTable(handle!, { isLoading: true });
    expect(handle!.container.querySelector('[role="status"]')).not.toBeNull();

    renderVolumeTable(handle!, { isLoading: false, hasError: true });
    expect(
      handle!.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Couldn't load volume");

    renderVolumeTable(handle!, { hasError: false, traders: [] });
    expect(handle!.container.textContent).toContain(
      "No traders matched this window",
    );
  });

  it("sorts traders through volume URL params", () => {
    renderVolumeTable(handle!, {
      traders: [
        trader({
          trader: "0xaaa",
          volumeUsdWei: usdWei(1),
          swapCount: 20,
        }),
        trader({
          trader: "0xbbb",
          volumeUsdWei: usdWei(10),
          swapCount: 2,
        }),
      ],
    });

    expect(bodyRows(handle!.container)[0]?.textContent).toContain("0xbbb");

    act(() => {
      headerButton(handle!.container, "Swaps").click();
    });
    expect(bodyRows(handle!.container)[0]?.textContent).toContain("0xaaa");
    expect(window.location.search).toBe("?volumeSort=swaps&volumeDir=desc");

    act(() => {
      headerButton(handle!.container, "Swaps").click();
    });
    expect(bodyRows(handle!.container)[0]?.textContent).toContain("0xbbb");
    expect(window.location.search).toBe("?volumeSort=swaps&volumeDir=asc");
  });

  it("caps visible v3 top traders at 20 rows", () => {
    const traders = Array.from({ length: 25 }, (_, index) => {
      const rank = index + 1;
      return trader({
        trader: `0x${rank.toString(16).padStart(40, "0")}`,
        volumeUsdWei: usdWei(rank),
      });
    });

    renderVolumeTable(handle!, { traders });

    const rows = bodyRows(handle!.container);
    expect(rows).toHaveLength(20);
    expect(rows[0]?.textContent).toContain(`0x${"19".padStart(40, "0")}`);
    expect(handle!.container.textContent).not.toContain(
      `0x${"01".padStart(40, "0")}`,
    );
  });

  it("fetches and renders a per-trader pool breakdown only after expansion", () => {
    mockUseGQL.mockImplementation((document: string | null) => {
      if (document == null) {
        return { data: undefined, error: null, isLoading: false };
      }
      return {
        data: { TraderPoolDailySnapshot: [poolDaily({})] },
        error: null,
        isLoading: false,
      };
    });
    renderVolumeTable(handle!, {
      traders: [trader({ trader: "0xtrader", volumeUsdWei: usdWei(10) })],
    });

    expect(mockUseGQL).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ trader: "0xtrader" }),
      expect.any(Object),
    );
    expect(handle!.container.textContent).not.toContain("USDC/USDm");

    act(() => {
      handle!.container
        .querySelector<HTMLButtonElement>('button[aria-label^="Expand"]')
        ?.click();
    });

    expect(mockUseGQL).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        chainId: 42220,
        trader: "0xtrader",
        afterTimestamp: CUTOFF,
      }),
      expect.any(Object),
    );
    expect(handle!.container.textContent).toContain("USDC/USDm");
    expect(handle!.container.textContent).toContain("round-trip");
  });
});

describe("V2VolumeTraderTable", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBrokerViaMarkers.mockReturnValue({
      data: { rows: [], truncated: false },
      error: null,
      isLoading: false,
    });
    handle = setupDom();
  });

  afterEach(() => {
    teardown(handle);
    handle = null;
  });

  it("sorts v2 traders through v2trader URL params", () => {
    renderV2Table(handle!, {
      traders: [
        v2Trader({ trader: "0xaaa", volumeUsdWei: usdWei(1), swapCount: 20 }),
        v2Trader({ trader: "0xbbb", volumeUsdWei: usdWei(10), swapCount: 2 }),
      ],
    });

    expect(bodyRows(handle!.container)[0]?.textContent).toContain("0xbbb");

    act(() => {
      headerButton(handle!.container, "Swaps").click();
    });
    expect(bodyRows(handle!.container)[0]?.textContent).toContain("0xaaa");
    expect(window.location.search).toBe("?v2traderSort=swaps&v2traderDir=desc");
  });

  it("caps visible v2 top traders and Via attribution at 20 rows", () => {
    const traders = Array.from({ length: 25 }, (_, index) => {
      const rank = index + 1;
      return v2Trader({
        trader: `0x${rank.toString(16).padStart(40, "0")}`,
        volumeUsdWei: usdWei(rank),
      });
    });

    renderV2Table(handle!, { traders });

    const rows = bodyRows(handle!.container);
    expect(rows).toHaveLength(20);
    const [callers, cutoff] = mockUseBrokerViaMarkers.mock.lastCall ?? [];
    expect(cutoff).toBe(CUTOFF);
    expect(callers).toHaveLength(20);
    expect(callers).toContain(`0x${"19".padStart(40, "0")}`);
    expect(callers).not.toContain(`0x${"01".padStart(40, "0")}`);
  });

  it("surfaces bounded-window Via degradation for all-time v2 views", () => {
    renderV2Table(handle!, {
      cutoff: 0,
      traders: [v2Trader({ trader: "0xaaa", volumeUsdWei: usdWei(10) })],
    });

    expect(handle!.container.textContent).toContain("Via column degraded.");
    expect(handle!.container.textContent).toContain(
      "bounded time windows only",
    );
    expect(mockUseBrokerViaMarkers).toHaveBeenCalledWith(null, 0);
  });

  it("renders v2 Via route attribution for visible rows", () => {
    mockUseBrokerViaMarkers.mockReturnValue({
      data: {
        rows: [
          viaMarker({
            caller: "0xaaa",
            txTo: "0xrouter1",
            aggregator: "squid",
          }),
          viaMarker({
            id: "marker-2",
            caller: "0xaaa",
            txTo: "0xrouter2",
            aggregator: "lifi",
          }),
        ],
        truncated: false,
      },
      error: null,
      isLoading: false,
    });

    renderV2Table(handle!, {
      traders: [v2Trader({ trader: "0xaaa", volumeUsdWei: usdWei(10) })],
    });

    expect(mockUseBrokerViaMarkers).toHaveBeenCalledWith(["0xaaa"], CUTOFF);
    expect(handle!.container.textContent).toContain("0xrouter1");
    expect(handle!.container.textContent).toContain("0xrouter2");
  });
});
