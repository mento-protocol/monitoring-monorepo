import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { POOL_CONFIG_EXT, POOL_RATE_FEED_EXT } from "@/lib/queries";
import {
  PoolConfigExtSchema,
  PoolRateFeedExtSchema,
} from "@/lib/queries/pool-detail-schemas";

const USDC_FEED = "0xa1a8003936862e7a15092a91898d69fa8bce290c";
const GBP_FEED = "0xf590b62f9cfcc6409075b1ecac8176fe25744b88";
const JPY_FEED = "0xfde35b45cbd2504fb5dc514f007bc2de27034274";
const MONAD_GBP_FEED = "0xea4103a6a122fbe2cdb07a80d4d293be07bb29fa";

function defaultUseGQL(query?: unknown) {
  if (query === POOL_RATE_FEED_EXT) {
    return {
      data: {
        RateFeed: [
          {
            id: `42220-${USDC_FEED}`,
            chainId: 42220,
            feedAddress: USDC_FEED,
            pair: "USDC/USD",
            reporterTypes: ["CHAINLINK"],
          },
        ],
      },
    };
  }
  if (query === POOL_CONFIG_EXT) {
    return { data: { Pool: [{ rebalanceReward: 1 }] } };
  }
  return {};
}

const mockUseGQL = vi.fn(defaultUseGQL);

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
const GBP_ADDR = "0x5427fefa711eff984124bfbb1ab6fbf5e3da1820";
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
    [GBP_ADDR]: "GBPm",
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
  referenceRateFeedID: USDC_FEED,
};

describe("PoolConfigPanel", () => {
  beforeEach(() => {
    mockUseGQL.mockClear();
    mockUseGQL.mockImplementation(defaultUseGQL);
  });

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

  it("fetches the isolated RateFeed query with timeout and schema validation", () => {
    renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);

    expect(mockUseGQL).toHaveBeenCalledWith(
      POOL_RATE_FEED_EXT,
      { chainId: BASE_POOL.chainId, feedAddress: USDC_FEED },
      {
        timeoutMs: 5000,
        schema: PoolRateFeedExtSchema,
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

    it("exposes the LP/Protocol breakdown in the Tooltip content", () => {
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).toContain("LP fee (0.03%)");
      expect(html).toContain("protocol fee (0.02%)");
    });
  });

  describe("Oracle Source tile", () => {
    it("renders the RateFeed reporter label as a chain-aware Chainlink link", () => {
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).toContain("Chainlink USDC/USD");
      expect(html).toContain("Oracle Source");
      expect(html).toContain(
        'href="https://data.chain.link/feeds/celo/mainnet/usdc-usd"',
      );
    });

    it("does not guess Chainlink source from token symbols for non-USDm pairs", () => {
      mockUseGQL.mockImplementation((query?: unknown) => {
        if (query === POOL_RATE_FEED_EXT) {
          return {
            data: {
              RateFeed: [
                {
                  id: `42220-${GBP_FEED}`,
                  chainId: 42220,
                  feedAddress: GBP_FEED,
                  pair: "GBP/USD",
                  reporterTypes: ["CHAINLINK"],
                },
              ],
            },
          };
        }
        return defaultUseGQL(query);
      });
      const pool: Pool = {
        ...BASE_POOL,
        token0: USDC_ADDR,
        token1: GBP_ADDR,
        referenceRateFeedID: GBP_FEED,
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toContain("Chainlink GBP/USD");
      expect(html).toContain(
        'href="https://data.chain.link/feeds/celo/mainnet/gbp-usd"',
      );
      expect(html).not.toContain("Chainlink USDC/USD");
    });

    it("links Monad Chainlink feeds to the Monad Chainlink path", () => {
      mockUseGQL.mockImplementation((query?: unknown) => {
        if (query === POOL_RATE_FEED_EXT) {
          return {
            data: {
              RateFeed: [
                {
                  id: `143-${MONAD_GBP_FEED}`,
                  chainId: 143,
                  feedAddress: MONAD_GBP_FEED,
                  pair: "GBP/USD",
                  reporterTypes: ["CHAINLINK"],
                },
              ],
            },
          };
        }
        return defaultUseGQL(query);
      });
      const pool: Pool = {
        ...BASE_POOL,
        id: "143-0xpool",
        chainId: 143,
        referenceRateFeedID: MONAD_GBP_FEED,
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toContain("Chainlink GBP/USD");
      expect(html).toContain(
        'href="https://data.chain.link/feeds/monad/monad/gbp-usd"',
      );
      expect(html).not.toContain("feeds/celo/mainnet/gbp-usd");
    });

    it("uses per-feed Chainlink slug overrides", () => {
      mockUseGQL.mockImplementation((query?: unknown) => {
        if (query === POOL_RATE_FEED_EXT) {
          return {
            data: {
              RateFeed: [
                {
                  id: `42220-${JPY_FEED}`,
                  chainId: 42220,
                  feedAddress: JPY_FEED,
                  pair: "JPY/USD",
                  reporterTypes: ["CHAINLINK"],
                },
              ],
            },
          };
        }
        return defaultUseGQL(query);
      });
      const html = renderToStaticMarkup(
        <PoolConfigPanel
          pool={{
            ...BASE_POOL,
            token0: GBP_ADDR,
            token1: USDM_ADDR,
            referenceRateFeedID: JPY_FEED,
          }}
        />,
      );
      expect(html).toContain("Chainlink JPY/USD");
      expect(html).toContain(
        'href="https://data.chain.link/feeds/celo/mainnet/jpy-usd-fx"',
      );
      expect(html).not.toContain('feeds/celo/mainnet/jpy-usd"');
    });

    it("keeps the Chainlink link during RateFeed schema lag for known feeds", () => {
      mockUseGQL.mockImplementation((query?: unknown) => {
        if (query === POOL_RATE_FEED_EXT) return {};
        return defaultUseGQL(query);
      });
      const html = renderToStaticMarkup(<PoolConfigPanel pool={BASE_POOL} />);
      expect(html).toContain("Chainlink USDC/USD");
      expect(html).toContain(
        'href="https://data.chain.link/feeds/celo/mainnet/usdc-usd"',
      );
    });

    it("renders 'SortedOracles' when the RateFeed row is absent", () => {
      mockUseGQL.mockImplementation((query?: unknown) => {
        if (query === POOL_RATE_FEED_EXT) return { data: { RateFeed: [] } };
        return defaultUseGQL(query);
      });
      const pool: Pool = {
        ...BASE_POOL,
        token1: KES_ADDR,
        referenceRateFeedID: "0x0000000000000000000000000000000000000000",
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toContain("SortedOracles");
      expect(html).not.toContain("data.chain.link");
    });

    it("renders 'SortedOracles' when the isolated RateFeed query is unavailable and the feed is unknown", () => {
      mockUseGQL.mockImplementation((query?: unknown) => {
        if (query === POOL_RATE_FEED_EXT) return {};
        return defaultUseGQL(query);
      });
      const pool: Pool = {
        ...BASE_POOL,
        referenceRateFeedID: "0x0000000000000000000000000000000000000000",
      };
      const html = renderToStaticMarkup(<PoolConfigPanel pool={pool} />);
      expect(html).toContain("SortedOracles");
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
