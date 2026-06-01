import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool, TradingLimit } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { POOL_CONFIG_EXT } from "@/lib/queries";
import { PoolConfigExtSchema } from "@/lib/queries/pool-detail-schemas";

const mockUseGQL = vi.fn<
  (
    query?: unknown,
    variables?: unknown,
    options?: unknown,
  ) => { data?: { Pool: { rebalanceReward?: number }[] } }
>(() => ({ data: { Pool: [{ rebalanceReward: 1 }] } }));

const mockGetName = vi.fn((address: string) => `name-for-${address.slice(-4)}`);

vi.mock("@/lib/graphql", () => ({
  HASURA_TIMEOUT_MS: 5000,
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
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
  oracleExpiry: "300",
  oracleNumReporters: 4,
  lpFee: 3,
  protocolFee: 2,
  rebalanceThreshold: 3333,
  rebalancerAddress: STRATEGY_ADDR,
};

const BASE_LIMIT: TradingLimit = {
  id: `${BASE_POOL.id}-${USDC_ADDR}`,
  poolId: BASE_POOL.id,
  token: USDC_ADDR,
  limit0: "77000000000000000000",
  limit1: "154000000000000000000",
  decimals: 15,
  netflow0: "0",
  netflow1: "0",
  lastUpdated0: "1",
  lastUpdated1: "1",
  limitPressure0: "0.0000",
  limitPressure1: "0.0000",
  limitStatus: "OK",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
};

describe("PoolConfigPanel", () => {
  it("fetches the isolated config extension query with timeout and schema validation", () => {
    renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);

    expect(mockUseGQL).toHaveBeenCalledWith(
      POOL_CONFIG_EXT,
      { id: BASE_POOL.id, chainId: BASE_POOL.chainId },
      {
        timeoutMs: 5000,
        schema: PoolConfigExtSchema,
      },
    );
  });

  describe("Rebalance Threshold tile", () => {
    it("renders 'Never' when governance disabled rebalancing for the pool", () => {
      const pool: Pool = {
        ...BASE_POOL,
        rebalanceThreshold: 0,
        rebalanceThresholdAbove: 0,
        rebalanceThresholdBelow: 0,
        rebalanceThresholdsKnown: true,
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toMatch(/Rebalance Threshold[\s\S]*?Never/);
      expect(html).toContain(
        "Governance has disabled rebalancing for this pool",
      );
    });

    it("keeps the em dash when threshold zero still means 'not backfilled yet'", () => {
      const pool: Pool = {
        ...BASE_POOL,
        rebalanceThreshold: 0,
        rebalanceThresholdsKnown: false,
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toMatch(/Rebalance Threshold[\s\S]*?—/);
      expect(html).not.toMatch(/Rebalance Threshold[\s\S]*?Never/);
    });
  });

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

    it("renders oracle expiry and reporter count as config rows", () => {
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).toMatch(/Oracle Expiry[\s\S]*?5m/);
      expect(html).toMatch(/Oracle Reporters[\s\S]*?4/);
    });

    it("falls back to '—' when oracle expiry and reporter count are unknown", () => {
      const pool: Pool = {
        ...BASE_POOL,
        oracleExpiry: undefined,
        oracleNumReporters: undefined,
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toMatch(/Oracle Expiry[\s\S]*?—/);
      expect(html).toMatch(/Oracle Reporters[\s\S]*?—/);
    });
  });

  describe("Trading limit config rows", () => {
    it("renders L0/L1 windows and per-token caps from the existing trading limit data", () => {
      const html = renderToStaticMarkup(
        <PoolConfigPanel pool={BASE_POOL} tradingLimits={[BASE_LIMIT]} />,
      );

      expect(html).toMatch(
        /Limit Windows[\s\S]*?L0 5m \/ L1 24h \/ LG lifetime/,
      );
      expect(html).toContain("USDC");
      expect(html).toContain("L0 77,000.00");
      expect(html).toContain("L1 154,000.00");
    });

    it("renders clear empty states for missing or failed trading-limit config", () => {
      const emptyHtml = renderToStaticMarkup(
        <PoolConfigPanel pool={BASE_POOL} tradingLimits={[]} />,
      );
      const errorHtml = renderToStaticMarkup(
        <PoolConfigPanel
          pool={BASE_POOL}
          tradingLimits={[BASE_LIMIT]}
          tradingLimitsError
        />,
      );

      expect(emptyHtml).toMatch(/Limit Caps[\s\S]*?—/);
      expect(errorHtml).toMatch(/Limit Caps[\s\S]*?Unavailable/);
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
