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

// `useGQL` fires once per render in this component, fetching the trip tx
// hash for the open breach. Default to no row so tests that don't care
// about the link see a plain `<span>` breach indicator. The "links to the
// trip tx" tests override per-call.
let nextTripTx: { startedByTxHash?: string }[] = [];
vi.mock("@/lib/graphql", () => ({
  useGQL: () => ({
    data: { DeviationThresholdBreach: nextTripTx },
  }),
}));
function setTripTx(rows: { startedByTxHash?: string }[]) {
  nextTripTx = rows;
}

import { beforeEach } from "vitest";
beforeEach(() => {
  nextTripTx = [];
});

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

describe("DeviationCell — bar fill colors track health status", () => {
  it("renders an emerald bar when deviation is well below the threshold (ratio < 0.8)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "3000" }; // ratio = 0.6
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-emerald-500");
    expect(html).not.toContain("bg-yellow-500");
    expect(html).not.toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
  });

  it("renders a yellow bar when 0.8 <= ratio <= 1.0 (healthy but close)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "4500" }; // ratio = 0.9
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-yellow-500");
    expect(html).not.toContain("bg-emerald-500");
    expect(html).not.toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
  });

  it("flips to yellow at exactly ratio = 0.8 (boundary, inclusive)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "4000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-yellow-500");
    expect(html).not.toContain("bg-emerald-500");
  });

  it("stays emerald just below the yellow boundary (ratio = 0.7998)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "3999" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-emerald-500");
    expect(html).not.toContain("bg-yellow-500");
  });

  it("keeps the bar yellow (not amber) when deviation sits exactly at the threshold", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "5000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-yellow-500");
    expect(html).not.toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
  });

  it("flips to amber once deviation exceeds the 1% tolerance line (ratio = 1.012)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "5060" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-amber-500");
    expect(html).not.toContain("bg-yellow-500");
    expect(html).not.toContain("bg-red-500");
  });

  it("renders a red bar when a breach has outlived the 1h grace window", () => {
    const now = Math.floor(Date.now() / 1000);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "8000",
      deviationBreachStartedAt: String(now - 2 * 3600),
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-red-500");
  });

  it("renders an amber bar while the breach is within the 1h grace window", () => {
    const now = Math.floor(Date.now() / 1000);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "8000",
      deviationBreachStartedAt: String(now - 30 * 60),
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("bg-amber-500");
    expect(html).not.toContain("bg-red-500");
    expect(html).not.toContain("bg-yellow-500");
  });
});

describe("DeviationCell — caption shows current/threshold pair", () => {
  it("renders a 0%-filled bar and '0.00% of Y% threshold' for the perfect-balance case", () => {
    // diff === 0 used to early-return "—" alongside the missing-threshold
    // case — but a perfectly balanced pool should render proudly, not
    // show a no-data dash. Bar at 0% width, caption shows the threshold.
    const pool: Pool = { ...BASE_POOL, priceDifference: "0" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("0.00% of 50.00% threshold");
    expect(html).toContain("bg-emerald-500");
    expect(html).not.toMatch(/<dd><span[^>]*>—<\/span><\/dd>/);
  });

  it("renders 'X% of Y% threshold' below the bar", () => {
    // 7610 bps / 5000 bps → "76.10% of 50.00% threshold"
    const pool: Pool = { ...BASE_POOL, priceDifference: "7610" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("76.10% of 50.00% threshold");
  });

  it("stays compact at 4-digit deviation magnitudes (no wrap on a 226px tile)", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "132954" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("1329.54% of 50.00% threshold");
  });

  it("renders the same caption shape when below the threshold", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "3000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("30.00% of 50.00% threshold");
    expect(html).not.toMatch(/% below/);
    expect(html).not.toMatch(/% above/);
  });

  it("does not synthesise 'At threshold' copy when deviation == threshold", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "5000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("50.00% of 50.00% threshold");
    expect(html).not.toContain("At threshold");
  });
});

describe("DeviationCell — info popover", () => {
  it("renders the popover next to the 'Deviation' label", () => {
    const pool: Pool = { ...BASE_POOL, priceDifference: "3000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toMatch(
      /aria-label="About Deviation\. Difference between the oracle rate/,
    );
  });

  it("includes the actual rebalance threshold % inside the popover content", () => {
    // BASE_POOL has rebalanceThreshold=5000 (50.00%). The popover should
    // surface that number rather than punting to "see Pool Config".
    const pool: Pool = { ...BASE_POOL, priceDifference: "3000" };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toMatch(/rebalance threshold of 50\.00%/);
    expect(html).not.toMatch(/see Pool Config/);
  });

  it("falls back gracefully when the indexer hasn't backfilled the threshold yet", () => {
    const pool: Pool = {
      ...BASE_POOL,
      rebalanceThreshold: 0,
      rebalanceThresholdsKnown: false,
      priceDifference: "3000",
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    // No "of X%" suffix when the indexer's sentinel-0 is in play; the
    // popover still explains the concept.
    expect(html).toMatch(/rebalance threshold\./);
    expect(html).not.toMatch(/rebalance threshold of/);
  });

  it("distinguishes governance-disabled rebalancing from missing threshold data", () => {
    const pool: Pool = {
      ...BASE_POOL,
      rebalanceThreshold: 0,
      rebalanceThresholdsKnown: true,
      priceDifference: "3000",
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain("Never rebalances");
    expect(html).toContain(
      "Governance has disabled rebalancing for this pool",
    );
    expect(html).not.toMatch(/<dd><span[^>]*>—<\/span><\/dd>/);
  });
});

describe("DeviationCell — breach line", () => {
  it("renders a plain span when there's no trip tx hash to link to", () => {
    setTripTx([]);
    const now = Math.floor(Date.now() / 1000);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "6000",
      deviationBreachStartedAt: String(now - 2 * 3600),
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toMatch(/breach/);
    expect(html).toContain("text-red-400");
    expect(html).toMatch(/<time[^>]*dateTime=/);
    expect(html).toMatch(/class="sr-only">\s*\(started at/);
    // No anchor wrapping the breach line when no tx hash is available.
    expect(html).not.toMatch(/<a[^>]*>[^<]*<time[^>]*>[^<]*<\/time>/);
  });

  it("links the breach age to the explorer trip transaction when the tx hash is known", () => {
    setTripTx([{ startedByTxHash: "0xdeadbeefcafe" }]);
    const now = Math.floor(Date.now() / 1000);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "6000",
      deviationBreachStartedAt: String(now - 2 * 3600),
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toContain('href="https://celoscan.io/tx/0xdeadbeefcafe"');
    // Only the "breach Xh ago" portion is wrapped in the anchor — the
    // primary "X% of Y% threshold" caption stays plain text. Confirm via
    // aria-label and a structural check that the caption is NOT inside
    // any anchor.
    expect(html).toMatch(/aria-label="breach[^"]*— open trip transaction/);
    expect(html).not.toMatch(/<a[^>]*>[^<]*% of [^<]*% threshold/);
  });

  it("colors the breach line amber when still within the 1h grace (WARN)", () => {
    setTripTx([]);
    const now = Math.floor(Date.now() / 1000);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "6000",
      deviationBreachStartedAt: String(now - 1800), // 30 min ago
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    expect(html).toMatch(/breach/);
    expect(html).toContain("text-amber-400");
    expect(html).not.toContain("text-red-400");
  });

  it("still renders the breach indicator when rebalanceThreshold is 0 (badge lives in the dt row)", () => {
    // The breach badge moved from the dd caption to the dt row, so it
    // survives the bar's no-data path (rebalanceThreshold = 0) without
    // any special-case rendering inside the bar.
    setTripTx([]);
    const now = Math.floor(Date.now() / 1000);
    const breachStart = String(now - 2 * 3600);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "6000",
      rebalanceThreshold: 0,
      deviationBreachStartedAt: breachStart,
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    // Match the badge shape — "breach <time>…</time>" — instead of the
    // popover's "rebalance breach" prose.
    expect(html).toMatch(/breach <time/);
    expect(html).toMatch(/<time[^>]*dateTime=/);
    expect(html).toMatch(/class="sr-only">\s*\(started at/);
  });

  it("does not render breach text when deviationBreachStartedAt is '0' (not currently breached)", () => {
    setTripTx([]);
    const pool: Pool = {
      ...BASE_POOL,
      priceDifference: "3000",
      deviationBreachStartedAt: "0",
    };
    const html = renderToStaticMarkup(
      <DeviationCell pool={pool} network={NETWORK} />,
    );
    // The popover content includes the word "breach" — assert against the
    // badge's structural form ("breach <time>…</time>") that only the
    // live indicator produces, plus the absence of the sr-only timestamp.
    expect(html).not.toMatch(/breach <time/);
    expect(html).not.toMatch(/started at \d/);
  });
});
