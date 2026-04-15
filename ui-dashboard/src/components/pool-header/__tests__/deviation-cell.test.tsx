import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";

// Mock weekend module to keep the grace-window / weekend branches deterministic.
vi.mock("@/lib/weekend", () => ({
  isWeekend: vi.fn(() => false),
  isWeekendOracleStale: vi.fn(() => false),
  FX_CLOSE_DAY: 5,
  FX_CLOSE_HOUR_UTC: 21,
  FX_REOPEN_DAY: 0,
  FX_REOPEN_HOUR_UTC: 23,
}));

import { DeviationCell } from "@/components/pool-header/deviation-cell";

const NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

const FRESH_TS = String(Math.floor(Date.now() / 1000) - 60);

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
  hasHealthData: true,
  oracleTimestamp: FRESH_TS,
  oracleExpiry: "300",
  rebalanceThreshold: 5000,
};

describe("DeviationCell — bar color boundaries", () => {
  it("renders an emerald bar when deviation is below the WARN threshold (ratio < 0.8)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "3000" }; // ratio = 0.6
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-emerald-500");
    expect(html).not.toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
  });

  it("renders an amber bar when 0.8 <= ratio <= 1.0 (WARN band)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "4500" }; // ratio = 0.9
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
  });

  it("keeps the bar amber (not red) when deviation sits exactly at the threshold", () => {
    // ratio = 1.0 — computeHealthStatus treats this as WARN, so the bar
    // must match. Previously the bar used `>= 1.0` and went red here,
    // contradicting the HealthBadge in the same cell.
    const pool: Pool = { ...BASE_POOL, priceDifference: "5000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
  });

  it("renders a red bar when deviation exceeds the threshold with no recent rebalance", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "8000" }; // ratio = 1.6
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-red-500");
  });

  it("frames the primary label as '% above threshold' when deviation is above the limit", () => {
    // 7610/5000 = 1.522 → (7610-5000)/5000 = 52.2% above. Reads as a
    // direct overage instead of the "152.2% of threshold" ratio form.
    const pool: Pool = { ...BASE_POOL, priceDifference: "7610" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("52.2% above threshold");
    expect(html).not.toContain("% of threshold");
  });

  it("frames the primary label as '% below threshold' when deviation is under the limit", () => {
    // 3000/5000 = 0.6 → 40% below threshold.
    const pool: Pool = { ...BASE_POOL, priceDifference: "3000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("40.0% below threshold");
    expect(html).not.toContain("above threshold");
  });

  it("says 'At threshold' (not '0.0% below') when deviation is exactly at the limit", () => {
    // diff === threshold — the exact-boundary case. Matches the "At
    // threshold" copy the Rebalance Status cell uses for the same state.
    const pool: Pool = { ...BASE_POOL, priceDifference: "5000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("At threshold");
    expect(html).not.toContain("0.0% below threshold");
    expect(html).not.toContain("0.0% above threshold");
  });

  it("says 'At threshold' when deviation is within 1% below the limit", () => {
    // 4975/5000 = 0.995 → 0.5% below. Would otherwise read as "0.5%
    // below threshold", which understates how close the pool is to
    // breach. Treat the 1% band as "At threshold".
    const pool: Pool = { ...BASE_POOL, priceDifference: "4975" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("At threshold");
    expect(html).not.toMatch(/% below threshold/);
  });

  it("still says '% below threshold' once the gap exceeds the 1% tolerance", () => {
    // 4900/5000 = 0.98 → 2.0% below. Outside the "At threshold" band,
    // so the explicit delta shows.
    const pool: Pool = { ...BASE_POOL, priceDifference: "4900" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("2.0% below threshold");
    expect(html).not.toContain("At threshold");
  });

  it("does NOT widen the 'At threshold' band on the above side", () => {
    // 5050/5000 = 1.01 → 1.0% above. Breach direction always shows the
    // explicit overage, no matter how small.
    const pool: Pool = { ...BASE_POOL, priceDifference: "5050" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("1.0% above threshold");
    expect(html).not.toContain("At threshold");
  });

  it("keeps the bar amber while a recent rebalance (within 1h) is still settling", () => {
    // dev > 100% but rebalance landed 30m ago → health status stays WARN
    // within the grace window, and the bar must stay amber to match.
    const now = Math.floor(Date.now() / 1000);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "8000",
      lastRebalancedAt: String(now - 30 * 60),
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
  });
});

describe("DeviationCell — breach start indicator", () => {
  it("renders 'Breach started' line with relative time and accessible absolute timestamp when breached", () => {
    const breachStart = String(Math.floor(Date.now() / 1000) - 3600); // 1h ago
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "6000", // above 5000 threshold → breach
      deviationBreachStartedAt: breachStart,
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );

    expect(html).toContain("Breach started");
    expect(html).toContain("1h ago");
    // a11y: absolute timestamp exposed via aria-label (not only via hover title)
    expect(html).toContain("Deviation breach started at");
    // semantic <time> element with machine-readable dateTime
    expect(html).toMatch(/<time[^>]*dateTime=/);
  });

  it("does not render breach line when deviationBreachStartedAt is '0' (not currently breached)", () => {
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "3000",
      deviationBreachStartedAt: "0",
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).not.toContain("Breach started");
  });
});
