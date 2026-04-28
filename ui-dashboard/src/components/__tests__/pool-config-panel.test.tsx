import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";

const mockUseGQL = vi.fn<
  () => { data?: { Pool: { rebalanceReward?: number }[] } }
>(() => ({ data: { Pool: [{ rebalanceReward: 1 }] } }));

const mockGetName = vi.fn((address: string) => `name-for-${address.slice(-4)}`);

vi.mock("@/lib/graphql", () => ({
  useGQL: () => mockUseGQL(),
}));
vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: mockGetName,
    hasName: () => true,
    isCustom: () => false,
    getEntry: () => undefined,
  }),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null }),
}));

const USDM_ADDR = "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b";
const USDC_ADDR = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";
const KES_ADDR = "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf";
const STRATEGY_ADDR = "0xa0fb8b16ce6af3634ff9f3f4f40e49e1c1ae4f0b";

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
    [KES_ADDR]: "KESm",
  },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: NETWORK }),
}));

import { PoolConfigPanel } from "@/components/pool-config-panel";

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
  lpFee: 3,
  protocolFee: 2,
  rebalanceThreshold: 3333,
  rebalancerAddress: STRATEGY_ADDR,
};

describe("PoolConfigPanel", () => {
  describe("Swap Fee tile", () => {
    it("renders the sum of LP and Protocol fees as the headline value", () => {
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      // 3bps + 2bps = 5bps → "0.05%"
      expect(html).toContain("0.05%");
    });

    it("falls back to '—' when either fee is the indexer's '-1' RPC-failed sentinel", () => {
      // The "-1" sentinel must not be summed with a healed value — adding
      // `-1 + 100 → 99` would render a plausible-looking but wrong "0.99%"
      // total instead of surfacing the failure.
      const pool: Pool = { ...BASE_POOL, lpFee: -1, protocolFee: 100 };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      // Headline should be em-dash
      expect(html).toMatch(/Swap Fee[\s\S]*?—/);
      expect(html).not.toContain("0.99%");
    });

    it("falls back to '—' when LP fee is undefined (resync window)", () => {
      const pool: Pool = { ...BASE_POOL, lpFee: undefined };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toMatch(/Swap Fee[\s\S]*?—/);
    });

    it("exposes the LP/Protocol breakdown in the InfoPopover content", () => {
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).toContain("LP fee (0.03%)");
      expect(html).toContain("protocol fee (0.02%)");
    });
  });

  describe("Oracle Source tile", () => {
    it("links to the Chainlink feed for the non-USDm leg when USDm is token0", () => {
      // BASE_POOL has token0=USDm, token1=USDC. Must pick USDC's feed.
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).toContain(
        'href="https://data.chain.link/feeds/celo/mainnet/usdc-usd"',
      );
      expect(html).toContain("Chainlink USDC/USD");
      expect(html).toContain("Oracle Source");
    });

    it("still picks the non-USDm leg when USDm is token1 (reversed pair)", () => {
      // Mirror of the previous test with the legs swapped — checking sym1
      // first would pick USDm and fall through to no feed.
      const pool: Pool = {
        ...BASE_POOL,
        token0: USDC_ADDR,
        token1: USDM_ADDR,
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toContain(
        'href="https://data.chain.link/feeds/celo/mainnet/usdc-usd"',
      );
    });

    it("renders 'SortedOracles' (no link) when no Chainlink feed maps", () => {
      const pool: Pool = { ...BASE_POOL, token1: KES_ADDR };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toContain("SortedOracles");
      expect(html).not.toContain("data.chain.link");
    });

    it("does not render an Expiry sub-line (expiry moved to OraclePriceValue)", () => {
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).not.toMatch(/Expiry/);
    });
  });

  describe("Rebalance Strategy tile", () => {
    it("links to the strategy address via AddressLink when present", () => {
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).toContain(
        `href="https://celoscan.io/address/${STRATEGY_ADDR}"`,
      );
    });

    it("renders '—' when no rebalancerAddress is set on the pool", () => {
      const pool: Pool = { ...BASE_POOL, rebalancerAddress: undefined };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      // Em-dash appears in the Rebalance Strategy slot
      expect(html).toMatch(/Rebalance Strategy[\s\S]*?—/);
    });
  });
});
