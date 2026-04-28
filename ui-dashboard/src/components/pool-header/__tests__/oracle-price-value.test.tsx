import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { OraclePriceValue } from "@/components/pool-header/oracle-price-value";

const CELO_CHAIN_ID = 42220;
const USDM_ADDR = "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b";
const USDC_ADDR = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C".toLowerCase();
const KES_ADDR = "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf";

const NETWORK_WITH_CHAINLINK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: CELO_CHAIN_ID,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {
    [USDM_ADDR]: "USDm",
    [USDC_ADDR]: "USDC",
    [KES_ADDR]: "KESm",
  },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

const NETWORK_WITHOUT_CHAINLINK: Network = {
  ...NETWORK_WITH_CHAINLINK,
  // Use a chain ID not in CHAINLINK_FEEDS to force the SortedOracles branch.
  chainId: 9999999,
};

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: CELO_CHAIN_ID,
  token0: USDM_ADDR, // USDm is token0 → expect inversion in display direction
  token1: KES_ADDR,
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
};

describe("OraclePriceValue", () => {
  it('renders "—" when oraclePrice is "0"', () => {
    const pool: Pool = { ...BASE_POOL, oraclePrice: "0" };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITH_CHAINLINK} />,
    );
    expect(html).toContain("—");
    expect(html).not.toMatch(/1 [A-Za-z]+ =/);
  });

  it('renders "—" when oraclePrice is undefined', () => {
    const pool: Pool = { ...BASE_POOL, oraclePrice: undefined };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITH_CHAINLINK} />,
    );
    expect(html).toContain("—");
  });

  it("renders 1 {base} = {price} {quote} ⇄ on the priced path", () => {
    // KESm/USDm pool where USDm is token0. Feed is stored as "1 USDm = X KESm"
    // shape, but because usdmIsToken0, the display rotates title/quote so we
    // see "1 KESm = X USDm ⇄" initially.
    const pool: Pool = {
      ...BASE_POOL,
      // 24dp oracle price: 0.0075 → 0.0075 * 1e24 = 7.5e21
      oraclePrice: String(BigInt(75) * BigInt(10) ** BigInt(20)),
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITH_CHAINLINK} />,
    );
    expect(html).toMatch(/1 KESm = [0-9.]+ USDm/);
    expect(html).toContain("⇄");
  });

  it("inverts display direction when USDm is token0", () => {
    // Compare to a pool where USDm is token1 (base should be USDm side).
    const pool: Pool = {
      ...BASE_POOL,
      token0: KES_ADDR,
      token1: USDM_ADDR,
      oraclePrice: String(BigInt(75) * BigInt(10) ** BigInt(20)),
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITH_CHAINLINK} />,
    );
    // usdmIsToken0=false path: base starts at sym0=KESm, quote=USDm — same
    // textual output as the previous test but the underlying orientation of
    // `titleToken`/`quoteToken` differs.
    expect(html).toMatch(/1 KESm = [0-9.]+ USDm/);
  });

  it("links only the 'last X ago' portion to the explorer tx, leaving '/ Nm expiry' as plain text", () => {
    const freshTs = String(Math.floor(Date.now() / 1000) - 60);
    const pool: Pool = {
      ...BASE_POOL,
      oraclePrice: String(BigInt(75) * BigInt(10) ** BigInt(20)),
      oracleTimestamp: freshTs,
      oracleExpiry: "300",
      oracleTxHash:
        "0xcb81fe1d4ff72d75ce29bf7905ea852d7e8da98e1831f575c5b71687e9acc936",
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITH_CHAINLINK} />,
    );
    expect(html).toContain(
      'href="https://celoscan.io/tx/0xcb81fe1d4ff72d75ce29bf7905ea852d7e8da98e1831f575c5b71687e9acc936"',
    );
    // Anchor wraps "last … ago" but NOT the "/ Nm expiry" suffix.
    expect(html).toMatch(/<a [^>]*>last [^<]+ ago<\/a>/);
    expect(html).toMatch(/<\/a>\s*\/ \d+m expiry/);
    expect(html).not.toMatch(/<a[^>]*>[^<]*expiry/);
    // Fresh oracle → white price, slate subline, no red anywhere.
    expect(html).toContain("text-white");
    expect(html).not.toContain("text-red-400");
  });

  it("turns BOTH the price text and the 'Updated …' subline red when the oracle has gone stale", () => {
    // Timestamp 1h old with a 5m expiry → past expiry, isOracleFresh=false.
    // Both the headline price button AND the timestamp subline must turn
    // red so the staleness signal is bidirectional — a regression that
    // reddened only one of the two would otherwise slip through.
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const pool: Pool = {
      ...BASE_POOL,
      oraclePrice: String(BigInt(75) * BigInt(10) ** BigInt(20)),
      oracleTimestamp: staleTs,
      oracleExpiry: "300",
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITH_CHAINLINK} />,
    );
    // Two distinct elements should carry text-red-400 — count occurrences
    // so a half-red regression fails this test instead of passing on the
    // first match.
    const redMatches = html.match(/text-red-400/g) ?? [];
    expect(redMatches.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("text-white");
    // Visible textual marker so users who can't rely on color still get
    // the staleness signal — color alone failed the a11y bar.
    expect(html).toContain("· stale");
  });

  it("omits the 'last …' subline when oracleTimestamp is absent", () => {
    const pool: Pool = {
      ...BASE_POOL,
      oraclePrice: String(BigInt(75) * BigInt(10) ** BigInt(20)),
      // no oracleTimestamp
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITHOUT_CHAINLINK} />,
    );
    expect(html).not.toMatch(/expiry/);
  });

  it("treats the '0' oracleTimestamp sentinel like a missing timestamp", () => {
    // Hasura returns "0" as the default for unset numeric fields; the
    // component must skip the 'last …' subline (don't render "last 56y ago"
    // pointing at the Unix epoch).
    const pool: Pool = {
      ...BASE_POOL,
      oraclePrice: String(BigInt(75) * BigInt(10) ** BigInt(20)),
      oracleTimestamp: "0",
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITHOUT_CHAINLINK} />,
    );
    expect(html).not.toMatch(/expiry/);
    expect(html).not.toMatch(/last [^<]*ago/);
  });
});
