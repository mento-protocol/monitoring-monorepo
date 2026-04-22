/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";

// Capture SWR's key argument per call so we can assert gating — null means
// "don't fetch", a URL string means the hook decided to fetch.
const useSWRMock = vi.fn();
vi.mock("swr", () => ({
  default: (
    key: string | null,
  ): { data: undefined; error: undefined; isLoading: boolean } => {
    useSWRMock(key);
    return { data: undefined, error: undefined, isLoading: false };
  },
}));

// computeHealthStatus is pure and covered elsewhere; stub to CRITICAL so
// shouldRunCheck's health-threshold gate passes.
vi.mock("@/lib/health", () => ({
  computeHealthStatus: () => "CRITICAL",
}));

import { useRebalanceCheck } from "../use-rebalance-check";

function captureKey(pool: Pool, network: Network): string | null | undefined {
  useSWRMock.mockClear();
  function Probe() {
    useRebalanceCheck(pool, network);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });
  root.unmount();
  // Last observed key argument passed to useSWR.
  return useSWRMock.mock.calls[0]?.[0];
}

const CRITICAL_POOL: Pool = {
  id: "143-0xpool",
  chainId: 143,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
  rebalancerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  priceDifference: "9716",
  rebalanceThreshold: 5000,
};

const NETWORK_WITH_RPC: Network = {
  id: "monad-mainnet",
  label: "Monad",
  chainId: 143,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://monadscan.com",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
  rpcUrl: "https://rpc.example.com",
};

beforeEach(() => {
  useSWRMock.mockReset();
});

describe("useRebalanceCheck RPC-availability gate", () => {
  it("fetches when the pool is CRITICAL and the network has an RPC URL", () => {
    const key = captureKey(CRITICAL_POOL, NETWORK_WITH_RPC);
    expect(typeof key).toBe("string");
    expect(key).toContain("/api/rebalance-check?network=monad-mainnet");
    expect(key).toContain(
      "strategy=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("skips fetching when the network has no rpcUrl (would 400 every refresh)", () => {
    const networkWithoutRpc: Network = {
      ...NETWORK_WITH_RPC,
      rpcUrl: undefined,
    };
    expect(captureKey(CRITICAL_POOL, networkWithoutRpc)).toBeNull();
  });

  it("skips fetching when the pool has no rebalancer address", () => {
    expect(
      captureKey(
        { ...CRITICAL_POOL, rebalancerAddress: undefined },
        NETWORK_WITH_RPC,
      ),
    ).toBeNull();
  });

  it("skips fetching for virtual pools", () => {
    expect(
      captureKey(
        { ...CRITICAL_POOL, source: "fpmm_factory_virtual" },
        NETWORK_WITH_RPC,
      ),
    ).toBeNull();
  });
});
