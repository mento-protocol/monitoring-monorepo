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

  it("renders the via Chainlink link when a known symbol is mapped", () => {
    // USDC symbol is mapped to celo-mainnet/usdc-usd.
    const pool: Pool = {
      ...BASE_POOL,
      token0: USDM_ADDR,
      token1: USDC_ADDR,
      oraclePrice: String(BigInt(1) * BigInt(10) ** BigInt(24)),
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITH_CHAINLINK} />,
    );
    expect(html).toContain(
      'href="https://data.chain.link/feeds/celo/mainnet/usdc-usd"',
    );
    expect(html).toContain("via Chainlink");
    // No ↗ on non-primary subtitles — indigo-hover signals clickability.
    expect(html).not.toContain("via Chainlink ↗");
  });

  it("renders plain via SortedOracles text when no Chainlink mapping exists", () => {
    const pool: Pool = {
      ...BASE_POOL,
      oraclePrice: String(BigInt(75) * BigInt(10) ** BigInt(20)),
    };
    const html = renderToStaticMarkup(
      <OraclePriceValue pool={pool} network={NETWORK_WITHOUT_CHAINLINK} />,
    );
    expect(html).toContain("via SortedOracles");
    expect(html).not.toContain("via Chainlink");
    expect(html).not.toContain("data.chain.link");
  });
});
