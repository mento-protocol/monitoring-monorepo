import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";

// Mock weekend module — default to not-weekend so existing tests are deterministic
vi.mock("@/lib/weekend", () => ({
  isWeekend: vi.fn(() => false),
  isWeekendOracleStale: vi.fn(() => false),
  FX_CLOSE_DAY: 5,
  FX_CLOSE_HOUR_UTC: 21,
  FX_REOPEN_DAY: 0,
  FX_REOPEN_HOUR_UTC: 23,
}));

// Mock hooks and network provider
vi.mock("@/components/network-provider", () => ({
  useNetwork: vi.fn(() => ({
    network: {
      id: "celo-sepolia-local",
      label: "Celo Sepolia",
      chainId: 11142220,
      contractsNamespace: "testnet-v2-rc5",
      hasuraUrl: "http://localhost:8080/v1/graphql",
      hasuraSecret: "testing",
      explorerBaseUrl: "https://celo-sepolia.blockscout.com",
      tokenSymbols: {
        "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b": "USDm",
        "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf": "KESm",
      },
      hasVirtualPools: true,
      rpcUrl: "https://alfajores-forno.celo-testnet.org",
    },
    setNetworkId: vi.fn(),
  })),
}));

vi.mock("@/hooks/use-rebalance-check", () => ({
  useRebalanceCheck: vi.fn(() => ({
    data: null,
    isLoading: false,
    error: undefined,
  })),
}));

import { HealthPanel } from "@/components/health-panel";

const STALE_TS = String(Math.floor(Date.now() / 1000) - 600);
const FRESH_TS = String(Math.floor(Date.now() / 1000) - 60);

const BASE_POOL: Pool = {
  id: "pool-1",
  chainId: 42220,
  token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
  token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  healthStatus: "OK",
  limitStatus: "OK",
  oracleTimestamp: FRESH_TS,
  oracleExpiry: "300",
  priceDifference: "0",
  rebalanceThreshold: 5000,
};

describe("HealthPanel weekend mode", () => {
  it("shows weekend explanation when oracle is stale and it is the weekend", async () => {
    const weekend = await import("@/lib/weekend");
    // mockReturnValue (not Once) — called by both computeHealthStatus and health-panel directly
    vi.mocked(weekend.isWeekend).mockReturnValue(true);

    const stalePool: Pool = { ...BASE_POOL, oracleTimestamp: STALE_TS };
    const html = renderToStaticMarkup(<HealthPanel pool={stalePool} />);

    expect(html).toContain("Trading is paused for the weekend");
    expect(html).toContain("FX markets are closed");

    vi.mocked(weekend.isWeekend).mockReturnValue(false); // reset
  });

  it("does not show weekend explanation when oracle is fresh even on a weekend", async () => {
    const weekend = await import("@/lib/weekend");
    vi.mocked(weekend.isWeekend).mockReturnValue(true);

    const freshPool: Pool = { ...BASE_POOL, oracleTimestamp: FRESH_TS };
    const html = renderToStaticMarkup(<HealthPanel pool={freshPool} />);

    expect(html).not.toContain("Trading is paused for the weekend");

    vi.mocked(weekend.isWeekend).mockReturnValue(false); // reset
  });

  it("does not show weekend explanation when oracle is stale but it is not the weekend", () => {
    // isWeekend mock returns false by default. The deviation widget moved to
    // the pool header (DeviationRow), and with no weekend pause, no missing-
    // data case, and no rebalance diagnostics, the panel has nothing left
    // to render and collapses.
    const stalePool: Pool = { ...BASE_POOL, oracleTimestamp: STALE_TS };
    const html = renderToStaticMarkup(<HealthPanel pool={stalePool} />);

    expect(html).not.toContain("Trading is paused for the weekend");
    expect(html).not.toContain("Deviation vs Threshold");
    expect(html).toBe("");
  });
});
