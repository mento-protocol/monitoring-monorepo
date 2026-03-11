import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Pool } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-sepolia-local",
      label: "Celo Sepolia (local)",
      chainId: 11142220,
      contractsNamespace: "testnet-v2-rc5",
      hasuraUrl: "http://localhost:8080/v1/graphql",
      hasuraSecret: "testing",
      explorerBaseUrl: "https://celo-sepolia.blockscout.com",
      tokenSymbols: {
        "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b": "USDm",
        "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf": "KESm",
      },
      addressLabels: {},
      local: true,
    },
    networkId: "celo-sepolia-local",
    setNetworkId: vi.fn(),
  }),
}));

import { PoolsTable } from "@/components/pools-table";

const BASE_POOL: Pool = {
  id: "pool-1",
  token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
  token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf",
  source: "FPMM",
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  healthStatus: "OK",
  limitStatus: "OK",
};

function renderSinglePool(pool: Pool): string {
  return renderToStaticMarkup(<PoolsTable pools={[pool]} />);
}

function renderPoolTableMarkup(props: {
  volume24h?: Map<string, number | null>;
  volume24hLoading?: boolean;
  volume24hError?: boolean;
}): string {
  return renderToStaticMarkup(<PoolsTable pools={[BASE_POOL]} {...props} />);
}

describe("PoolsTable rebalancer tooltip", () => {
  it('shows "No rebalance events recorded yet" for FPMM with no lastRebalancedAt', () => {
    const html = renderSinglePool({ ...BASE_POOL, source: "fpmm_factory" });
    expect(html).toContain("No rebalance events recorded yet");
  });

  it('shows "No rebalance events recorded yet" for FPMM with lastRebalancedAt "0"', () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      source: "fpmm_factory",
      lastRebalancedAt: "0",
    });
    expect(html).toContain("No rebalance events recorded yet");
  });

  it('shows "VirtualPool — rebalancer not applicable" for VirtualPool', () => {
    const html = renderSinglePool({
      ...BASE_POOL,
      source: "virtual_pool_factory",
    });
    expect(html).toContain("VirtualPool \u2014 rebalancer not applicable");
  });
});

describe("PoolsTable 24h volume states", () => {
  it("renders loading placeholder while 24h volume is loading", () => {
    const html = renderPoolTableMarkup({ volume24hLoading: true });
    expect(html).toContain("…");
  });

  it("renders N/A when 24h volume query failed", () => {
    const html = renderPoolTableMarkup({ volume24hError: true });
    expect(html).toContain("N/A");
  });

  it("renders N/A for non-convertible and formatted USD for convertible volumes", () => {
    const nullVolumeHtml = renderPoolTableMarkup({
      volume24h: new Map([["pool-1", null]]),
    });
    expect(nullVolumeHtml).toContain("N/A");

    const usdVolumeHtml = renderPoolTableMarkup({
      volume24h: new Map([["pool-1", 123]]),
    });
    expect(usdVolumeHtml).toContain("$123.00");
  });
});
