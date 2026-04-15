import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import type { RebalanceCheckResult } from "@/lib/rebalance-check";

// Mock external dependencies so we can control the component's inputs.
const mockUseRebalanceCheck = vi.fn();
const mockUseGQL = vi.fn<
  (
    query: string | null,
    variables?: Record<string, unknown>,
  ) => {
    data?: { RebalanceEvent: { txHash: string }[] };
  }
>(() => ({}));
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
vi.mock("@/lib/graphql", () => ({
  useGQL: (query: string | null, variables?: Record<string, unknown>) =>
    mockUseGQL(query, variables),
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

  it("surfaces block reason + raw error + enrichment in the tooltip when blocked", () => {
    mockUseRebalanceCheck.mockReturnValue(
      rebalanceState({
        data: {
          canRebalance: false,
          message: "Stability pool has insufficient liquidity",
          rawError: "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW",
          strategyType: "cdp",
          enrichment: {
            type: "cdp",
            stabilityPoolBalance: 34500,
            stabilityPoolTokenSymbol: "BOLD",
            stabilityPoolTokenDecimals: 18,
          },
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
    // Content previously lived in the HealthPanel's Rebalance Details
    // block — now folded into a native title so the header tells the
    // full story on hover without a separate panel.
    expect(html).toContain(
      'title="Stability pool has insufficient liquidity — [CDPLS_STABILITY_POOL_BALANCE_TOO_LOW] — Stability pool: 34.5k BOLD"',
    );
  });

  it("renders a focusable info icon beside 'Rebalance blocked' so the detail is keyboard-reachable", () => {
    // Native `title` on a <span> is mouse-only. The ⓘ sits in a <button>
    // so keyboard, touch, and screen-reader users can reach the
    // diagnostic without relying on hover.
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
    expect(html).toContain("ⓘ");
    expect(html).toMatch(
      /<button [^>]*aria-label="Rebalance diagnostics: Stability pool has insufficient liquidity/,
    );
  });

  it('treats LS_POOL_NOT_REBALANCEABLE as a healthy no-op, not "Rebalance blocked"', () => {
    // Live probe says the pool is below its internal threshold — that's
    // the authoritative signal, so render a fixed "Balanced" state. Must
    // NOT recompute from indexed pool props (which may still show a stale
    // CRITICAL state post-rebalance until the indexer catches up).
    mockUseRebalanceCheck.mockReturnValue(
      rebalanceState({
        data: {
          canRebalance: false,
          message: "Pool deviation is below the rebalance threshold",
          rawError: "LS_POOL_NOT_REBALANCEABLE",
          strategyType: "reserve",
          enrichment: null,
        },
      }),
    );
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        // Indexed priceDifference is stale-high — simulating the indexer
        // not having caught up to the just-landed rebalance. Cell must
        // still render green "Balanced", not "At threshold"/CRITICAL.
        pool={{ ...BASE_POOL, priceDifference: "5000" }}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("Balanced");
    expect(html).toContain("text-emerald-400");
    expect(html).not.toContain("Rebalance blocked");
    expect(html).not.toContain("At threshold");
    expect(html).not.toContain("text-red-400");
  });

  it("also treats PriceDifferenceTooSmall (pool-side) as a healthy no-op", () => {
    mockUseRebalanceCheck.mockReturnValue(
      rebalanceState({
        data: {
          canRebalance: false,
          message: "Pool deviation is below the rebalance threshold",
          rawError: "PriceDifferenceTooSmall",
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
    expect(html).not.toContain("Rebalance blocked");
  });

  it("renders 'last <relative>' in the merged subtitle when pool.lastRebalancedAt is present", () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    mockUseGQL.mockReturnValueOnce({ data: undefined });
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

  it("links 'last <relative>' to the latest rebalance tx on the explorer when available", () => {
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    mockUseGQL.mockReturnValueOnce({
      data: { RebalanceEvent: [{ txHash: "0xdeadbeef" }] },
    });
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
    // Subtitle shape: "…· <a>last Ns ago</a>" — subtitle link leans on
    // indigo-hover for its clickability signal (no ↗).
    expect(html).toContain('href="https://celoscan.io/tx/0xdeadbeef"');
    expect(html).toMatch(/· <a [^>]*>last [0-9]+[smhd] ago<\/a>/);
  });

  it("renders 'never rebalanced' in the subtitle when pool.lastRebalancedAt is undefined", () => {
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

  it("renders 'never rebalanced' when pool.lastRebalancedAt is null at runtime", () => {
    // Pool type says `string | undefined` but Hasura returns null for absent
    // nullable fields — the null path must also fall to "never rebalanced"
    // instead of leaking through to "last —" and firing the lookup query.
    mockUseRebalanceCheck.mockReturnValue(rebalanceState({ data: null }));
    const poolWithNull = {
      ...BASE_POOL,
      lastRebalancedAt: null,
    } as unknown as Pool;
    const html = renderToStaticMarkup(
      <RebalanceStatusValue
        pool={poolWithNull}
        network={NETWORK}
        strategyAddress={STRATEGY_ADDR}
      />,
    );
    expect(html).toContain("· never rebalanced");
    expect(html).not.toContain("last —");
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
