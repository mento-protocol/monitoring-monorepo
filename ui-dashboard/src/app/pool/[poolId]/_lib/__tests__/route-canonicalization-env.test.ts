import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("pool route canonicalization - real network env gates", () => {
  it("does not expose Celo Sepolia from a Monad-only hosted testnet endpoint", async () => {
    vi.stubEnv("NEXT_PUBLIC_SHOW_TESTNET_NETWORKS", "true");
    vi.stubEnv(
      "NEXT_PUBLIC_HASURA_URL_TESTNET",
      "https://indexer.hyperindex.xyz/monad-testnet/v1/graphql",
    );
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA", "");
    vi.resetModules();

    const { parseRouteChainId } = await import("../route-canonicalization");

    expect(parseRouteChainId("11142220")).toBeNull();
    expect(parseRouteChainId("10143")).toBe(10143);
  });

  it("still exposes local Celo Sepolia when local networks are enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_SHOW_LOCAL_NETWORKS", "true");
    vi.stubEnv("NEXT_PUBLIC_SHOW_TESTNET_NETWORKS", "");
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL_TESTNET", "");
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA", "");
    vi.resetModules();

    const { parseRouteChainId } = await import("../route-canonicalization");

    expect(parseRouteChainId("11142220")).toBe(11142220);
  });
});
