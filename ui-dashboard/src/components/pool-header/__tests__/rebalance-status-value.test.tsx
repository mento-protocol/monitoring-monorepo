import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import type { RebalanceCheckResult } from "@/lib/rebalance-check";

// Mock external dependencies so we can control the component's inputs.
const mockUseRebalanceCheck = vi.fn();
const mockGetName = vi.fn((address: string | null) =>
  address ? `name-for-${address.slice(-4)}` : "",
);

vi.mock("@/hooks/use-rebalance-check", () => ({
  useRebalanceCheck: (pool: Pool, network: Network) =>
    mockUseRebalanceCheck(pool, network),
}));
vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({ getName: mockGetName }),
}));

import { RebalanceStatusValue } from "@/components/pool-header/rebalance-status-value";

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
  rpcUrl: "https://forno.celo.org",
};

const STRATEGY_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const nowSeconds = Math.floor(Date.now() / 1000);

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
  rebalancerAddress: STRATEGY_ADDR,
  oracleTimestamp: String(nowSeconds - 60),
  oracleExpiry: "300",
  priceDifference: "0",
  rebalanceThreshold: 5000,
};

function rebalanceState(overrides: {
  data?: RebalanceCheckResult | null;
  isLoading?: boolean;
  error?: Error;
}) {
  return {
    data: overrides.data ?? null,
    isLoading: overrides.isLoading ?? false,
    error: overrides.error,
  };
}

describe("RebalanceStatusValue", () => {
  it('renders "Checking…" while the hook is loading', () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ isLoading: true }));
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={BASE_POOL}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Checking");
    expect(html).toContain("text-slate-400");
  });

  it('renders neutral "Diagnostics unavailable" (no CTA) when the hook surfaces an error', () => {
    mockUseRebalanceCheck.mockReturnValue(
      rebalanceState({ error: new Error("rpc down") }),
    );
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={BASE_POOL}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Diagnostics unavailable");
    expect(html).toContain("text-slate-400");
    expect(html).not.toContain("Rebalance required");
    expect(html).not.toContain("#writeProxyContract");
  });

  it('renders "Balanced" in emerald when the rebalance check is skipped for a healthy pool', () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={BASE_POOL}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Balanced");
    expect(html).toContain("text-emerald-400");
  });

  it('renders "Near threshold" in amber when the pool is WARN but below rebalance threshold', () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={{ ...BASE_POOL, priceDifference: "4500" }}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Near threshold");
    expect(html).toContain("text-amber-400");
  });

  it('renders "Oracle stale" in red when health is CRITICAL but the check was skipped because deviation is still below threshold', () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={{
          ...BASE_POOL,
          oracleTimestamp: String(nowSeconds - 600),
          priceDifference: "1000",
        }}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Oracle stale");
    expect(html).toContain("text-red-400");
  });

  it('renders "Diagnostics unavailable" when the network has no rpcUrl and the hook returned null', () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={BASE_POOL}
        network={{ ...NETWORK, rpcUrl: undefined }}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Diagnostics unavailable");
    expect(html).toContain("text-slate-400");
  });

  it("renders deep-link to the strategy proxy-write tab when canRebalance=true", () => {
    mockUseRebalanceCheck.mockReturnValue(
      rebalanceState({
        data: {
          canRebalance: true,
          message: "Rebalance is currently possible",
          rawError: null,
          strategyType: "reserve",
          enrichment: null,
        },
      }),
    );
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={BASE_POOL}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Rebalance required");
    expect(html).toContain("text-amber-400");
    expect(html).toContain(
      `href="https://celoscan.io/address/${STRATEGY_ADDR}#writeProxyContract"`,
    );
    expect(html).not.toContain("#writeProxyContract#F");
  });

  it('renders "Rebalance blocked" in red when canRebalance=false (no deep-link)', () => {
    mockUseRebalanceCheck.mockReturnValue(
      rebalanceState({
        data: {
          canRebalance: false,
          message: "Stability pool has insufficient liquidity",
          rawError: "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW",
          strategyType: "cdp",
          enrichment: null,
        },
      }),
    );
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={BASE_POOL}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Rebalance blocked");
    expect(html).toContain("text-red-400");
    expect(html).not.toContain("#writeProxyContract");
  });

  it("renders 'last <relative>' in the merged subtitle when pool.lastRebalancedAt is present", () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const poolWithLast: Pool = {
      ...BASE_POOL,
      lastRebalancedAt: String(Math.floor(Date.now() / 1000) - 120),
    };
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={poolWithLast}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toMatch(/· last [0-9]+[smhd] ago/);
  });

  it("renders 'never rebalanced' in the subtitle when pool.lastRebalancedAt is null", () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const poolWithoutLast: Pool = { ...BASE_POOL, lastRebalancedAt: undefined };
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={poolWithoutLast}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("· never rebalanced");
  });

  it("renders 'never rebalanced' when pool.lastRebalancedAt is the sentinel \"0\"", () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const poolWithZero: Pool = { ...BASE_POOL, lastRebalancedAt: "0" };
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={poolWithZero}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("· never rebalanced");
  });

  it("links the strategy name from useAddressLabels inside the 'via …' subtitle", () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={BASE_POOL}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain(
      `href="https://celoscan.io/address/${STRATEGY_ADDR}"`,
    );
    expect(html).toContain("name-for-aaaa");
    expect(html).not.toContain("name-for-aaaa ↗");
  });
});
