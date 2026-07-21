import { describe, expect, it } from "vitest";
import {
  activeChainIds,
  chainFilterOptions,
  readChainFilter,
  writeChainFilterParam,
} from "@/lib/chain-filter";
import type { Network } from "@/lib/networks";

function network(
  chainId: number,
  label: string,
  flags: Partial<Pick<Network, "local" | "testnet">> = {},
): Network {
  return {
    id: "celo-mainnet",
    label,
    chainId,
    contractsNamespace: null,
    hasuraUrl: "https://example.com/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://example.com",
    tokenSymbols: {},
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: false,
    ...flags,
  };
}

describe("chain filter", () => {
  const options = chainFilterOptions([
    network(42220, "Celo"),
    network(143, "Monad"),
    network(137, "Polygon"),
    network(80002, "Polygon Amoy", { testnet: true }),
    network(42220, "Celo local", { local: true }),
  ]);

  it("offers each configured production chain once", () => {
    expect(options).toEqual([
      { chainId: 42220, label: "Celo" },
      { chainId: 143, label: "Monad" },
      { chainId: 137, label: "Polygon" },
    ]);
  });

  it("accepts only offered chain IDs and defaults to All", () => {
    expect(readChainFilter(new URLSearchParams("chain=137"), options)).toBe(
      137,
    );
    expect(
      readChainFilter(new URLSearchParams("chain=80002"), options),
    ).toBeNull();
    expect(
      readChainFilter(new URLSearchParams("chain=polygon"), options),
    ).toBeNull();
    expect(activeChainIds(null, options)).toEqual([42220, 143, 137]);
    expect(activeChainIds(143, options)).toEqual([143]);
  });

  it("writes only the chain param and preserves sibling state", () => {
    const params = new URLSearchParams("pool=42220-0xabc&poolsSort=tvl");
    writeChainFilterParam(params, 137);
    expect(params.toString()).toBe("pool=42220-0xabc&poolsSort=tvl&chain=137");
    writeChainFilterParam(params, null);
    expect(params.toString()).toBe("pool=42220-0xabc&poolsSort=tvl");
  });
});
