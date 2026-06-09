import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BreakerPanel } from "@/components/breaker-panel";
import type { Pool, BreakerConfig, BreakerTripEvent } from "@/lib/types";

const mockUseGQL = vi.fn();
vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      testnet: false,
      hasVirtualPools: true,
      contractsNamespace: "mainnet",
      hasuraUrl: "",
      hasuraSecret: "",
    },
  }),
}));

vi.mock("@/components/tooltip", () => ({
  Tooltip: () => null,
}));

const FX_FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";

function fxPool(): Pool {
  return {
    id: `42220-0x6297000000000000000000000000000000000000`,
    chainId: 42220,
    token0: "0x0000000000000000000000000000000000000010",
    token1: "0x0000000000000000000000000000000000000020",
    token0Decimals: 18,
    token1Decimals: 18,
    source: "fpmm_factory",
    referenceRateFeedID: FX_FEED,
  } as unknown as Pool;
}

function virtualPool(): Pool {
  return { ...fxPool(), source: "virtual_pool_factory" } as unknown as Pool;
}

function noFeedPool(): Pool {
  return { ...fxPool(), referenceRateFeedID: "" } as unknown as Pool;
}

function healthyMedianConfig(): BreakerConfig {
  return {
    id: "1",
    enabled: true,
    cooldownTime: "0", // inherit default
    rateChangeThreshold: "0", // inherit default
    smoothingFactor: "5000000000000000000000", // 0.5%
    medianRatesEMA: "1171560280196965000000000", // 1.171…
    referenceValue: null,
    lastMedianRate: "1175000000000000000000000", // 1.175 — small Δ from EMA
    lastUpdatedAt: "1700000000",
    status: "OK",
    tradingMode: 0,
    lastStatusUpdatedAt: "1700000000",
    cooldownEndsAt: "0",
    lastTripAt: null,
    lastTripTxHash: null,
    lastResetAt: null,
    tripCountLifetime: 0,
    breaker: {
      id: "b",
      address: "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9",
      kind: "MEDIAN_DELTA",
      activatesTradingMode: 3,
      defaultCooldownTime: "900",
      defaultRateChangeThreshold: "40000000000000000000000", // 4%
    },
  };
}

function trippedMedianConfig(): BreakerConfig {
  return {
    ...healthyMedianConfig(),
    status: "TRIPPED",
    tradingMode: 3,
    lastStatusUpdatedAt: "1700001000",
    // Cooldown expires 900s after trip — set well into the future from
    // the test's "now" so the panel renders the not-yet-elapsed state.
    cooldownEndsAt: String(Math.floor(Date.now() / 1000) + 600),
    lastTripAt: "1700001000",
    lastTripTxHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    tripCountLifetime: 4,
    // Live Δ is over threshold — 5% from EMA.
    lastMedianRate: "1230000000000000000000000",
  };
}

function healthyValueConfig(): BreakerConfig {
  return {
    id: "2",
    enabled: true,
    cooldownTime: "0",
    rateChangeThreshold: "0",
    smoothingFactor: null,
    medianRatesEMA: null,
    referenceValue: "1000000000000000000000000", // 1.0 peg
    lastMedianRate: "1000100000000000000000000", // 1.0001
    lastUpdatedAt: "1700000000",
    status: "OK",
    tradingMode: 0,
    lastStatusUpdatedAt: "1700000000",
    cooldownEndsAt: "0",
    lastTripAt: null,
    lastTripTxHash: null,
    lastResetAt: null,
    tripCountLifetime: 0,
    breaker: {
      id: "b2",
      address: "0x4dbc33b3aba78475a5aa4bc7a5b11445d387bf68",
      kind: "VALUE_DELTA",
      activatesTradingMode: 3,
      defaultCooldownTime: "1",
      defaultRateChangeThreshold: "1500000000000000000000", // 0.15%
    },
  };
}

function trippedValueConfig(): BreakerConfig {
  return {
    ...healthyValueConfig(),
    status: "TRIPPED",
    tradingMode: 3,
    cooldownEndsAt: String(Math.floor(Date.now() / 1000) + 600),
    lastTripAt: "1700001000",
    lastTripTxHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    tripCountLifetime: 1,
    lastMedianRate: "997000000000000000000000", // 0.3% below peg
  };
}

const noTrips: BreakerTripEvent[] = [];

describe("BreakerPanel", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
  });

  it("renders nothing for virtual pools", () => {
    mockUseGQL.mockReturnValue({ data: undefined });
    const html = renderToStaticMarkup(<BreakerPanel pool={virtualPool()} />);
    expect(html).toBe("");
  });

  it("renders nothing for pools without a referenceRateFeedID", () => {
    mockUseGQL.mockReturnValue({ data: undefined });
    const html = renderToStaticMarkup(<BreakerPanel pool={noFeedPool()} />);
    expect(html).toBe("");
  });

  it("renders nothing when the feed has no trip-able BreakerConfig (only MARKET_HOURS)", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [
          {
            ...healthyMedianConfig(),
            breaker: { ...healthyMedianConfig().breaker, kind: "MARKET_HOURS" },
          },
        ],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toBe("");
  });

  it("renders the healthy MedianDelta strip", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [healthyMedianConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("MedianDelta");
    expect(html).toContain("EMA Reference vs Actual");
    expect(html).toContain("ref ");
    expect(html).toContain("actual ");
    expect(html).toContain("Threshold / Cooldown");
    expect(html).toContain("Δ Oracle Price vs EMA");
    expect(html).toContain("4.00%"); // default threshold inherited
    expect(html).toContain("15m"); // 900s formatted
    expect(html).toContain("trips at &gt;4.00% from EMA");
    expect(html).toContain("0 lifetime");
    expect(html).not.toContain("Reset path"); // not tripped
    expect(html).toContain("text-emerald-400"); // OK label
  });

  it("renders the healthy ValueDelta strip with peg reference", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [healthyValueConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("ValueDelta");
    expect(html).toContain("Reference vs Actual");
    expect(html).not.toContain("EMA Reference vs Actual");
    expect(html).toContain("fixed peg");
    expect(html).toContain("Δ Oracle Price vs Peg");
    expect(html).toContain("0.150%");
    expect(html).toContain("from peg");
  });

  it("renders breached ValueDelta reference and actual values in red with peg drift", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [trippedValueConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("Reference vs Actual");
    expect(html).toContain("ref ");
    expect(html).toContain("1.000000");
    expect(html).toContain("actual ");
    expect(html).toContain("0.997000");
    expect(html).toContain("0.300% below peg");
    expect(html).toContain("font-mono text-red-300");
  });

  it("renders the tripped MedianDelta strip with reset-path banner", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [trippedMedianConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("text-red-400"); // Tripped label
    expect(html).toContain("trading mode 3");
    expect(html).toContain("halted");
    expect(html).toContain("Reset path"); // banner present
    expect(html).toContain("Cooldown");
    expect(html).toContain("Rate in band");
    expect(html).toContain("Next oracle report");
    expect(html).toContain("4 lifetime");
    // Reset path checkboxes: cooldown is NOT elapsed (we set cooldownEndsAt
    // to now+600), so the row should render the ✗ marker.
    expect(html).toContain("✗");
  });

  it("hides the 'today' suffix when zero trips have happened today", () => {
    mockUseGQL.mockReturnValue({
      data: {
        BreakerConfig: [healthyMedianConfig()],
        BreakerTripEvent: noTrips,
      },
    });
    const html = renderToStaticMarkup(<BreakerPanel pool={fxPool()} />);
    expect(html).toContain("0 lifetime");
    expect(html).not.toContain("today");
  });
});
