/** @vitest-environment jsdom */

import { cache, serialize, SWRGlobalState } from "swr/_internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network } from "@/lib/networks";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("graphql-request", () => ({
  GraphQLClient: vi.fn(function GraphQLClientMock() {
    return {
      request: requestMock,
    };
  }),
}));

import { preloadGQL } from "@/lib/graphql";

const NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

const QUERY = "query PoolDetail($id: String!) { pool_by_pk(id: $id) { id } }";
const VARIABLES = { id: "42220-0x0000000000000000000000000000000000000001" };

function serializedPreloadKey(): string {
  return serialize([NETWORK.id, QUERY, VARIABLES])[0];
}

function swrPreloads(): Record<string, unknown> {
  const state = SWRGlobalState.get(cache);
  if (!state) throw new Error("SWR global state was not initialised");
  return state[3] as Record<string, unknown>;
}

function clearSWRPreloads(): void {
  const preloads = swrPreloads();
  for (const key of Object.keys(preloads)) {
    delete preloads[key];
  }
}

describe("preloadGQL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestMock.mockReset();
    clearSWRPreloads();
  });

  afterEach(() => {
    clearSWRPreloads();
    vi.useRealTimers();
  });

  it("expires speculative SWR preloads that are not consumed", async () => {
    requestMock.mockResolvedValue({ pool_by_pk: { id: VARIABLES.id } });

    preloadGQL(NETWORK, QUERY, VARIABLES, { ttlMs: 1_000 });

    const key = serializedPreloadKey();
    expect(swrPreloads()[key]).toBeDefined();

    await vi.advanceTimersByTimeAsync(999);
    expect(swrPreloads()[key]).toBeDefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(swrPreloads()[key]).toBeUndefined();
  });

  it("clears rejected speculative preloads without an unhandled rejection", async () => {
    requestMock.mockRejectedValue(new Error("Tier quota"));

    preloadGQL(NETWORK, QUERY, VARIABLES, { ttlMs: 1_000 });

    const key = serializedPreloadKey();
    expect(swrPreloads()[key]).toBeDefined();

    await Promise.resolve();
    await Promise.resolve();

    expect(swrPreloads()[key]).toBeUndefined();
  });
});
