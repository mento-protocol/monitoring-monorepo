import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

const USDM_ADDR = "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b";
const USDC_ADDR = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";

const NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {
    [USDM_ADDR]: "USDm",
    [USDC_ADDR]: "USDC",
  },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: true,
};

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: NETWORK }),
}));

import { ReservesPanel } from "@/components/reserves-panel";

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: USDM_ADDR,
  token1: USDC_ADDR,
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
  token0Decimals: 18,
  token1Decimals: 6,
  tokenDecimalsKnown: true,
  reserves0: "1000000000000000000",
  reserves1: "2000000",
  oraclePrice: "1000000000000000000000000",
  rebalanceThreshold: 5000,
};

function renderPanel(
  pool: Pool,
  props: Partial<ComponentProps<typeof ReservesPanel>> = {},
) {
  return renderToStaticMarkup(<ReservesPanel pool={pool} {...props} />);
}

describe("ReservesPanel decimal trust gate", () => {
  it("hides reserve amounts while decimal metadata is loading", () => {
    const html = renderPanel(
      { ...BASE_POOL, tokenDecimalsKnown: undefined },
      { decimalsLoading: true },
    );

    expect(html).toContain("Loading reserves");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("USDm reserve");
  });

  it("hides reserve amounts when the decimal trust query fails", () => {
    const html = renderPanel(
      { ...BASE_POOL, tokenDecimalsKnown: undefined },
      { decimalsError: true },
    );

    expect(html).toContain("try again later");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("USDC reserve");
  });

  it("hides reserve amounts when token decimals are unverified", () => {
    const html = renderPanel({ ...BASE_POOL, tokenDecimalsKnown: false });

    expect(html).toContain(
      "Reserves hidden until token decimals are verified.",
    );
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("USDm reserve");
    expect(html).not.toContain("1.00");
    expect(html).not.toContain("33.3%");
  });

  it("renders reserve tanks once token decimals are trusted", () => {
    const html = renderPanel(BASE_POOL);

    expect(html).toContain('role="meter"');
    expect(html).toContain("USDm reserve: 33.3%");
    expect(html).toContain("USDC reserve: 66.7%");
    expect(html).toContain("1.00");
    expect(html).toContain("2.00");
  });
});
