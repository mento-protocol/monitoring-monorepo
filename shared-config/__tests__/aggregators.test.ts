import { describe, expect, it } from "vitest";
import aggregatorsJson from "../aggregators.json" with { type: "json" };
import {
  _buildClusterMap,
  aggregatorsByChain,
  clusterNames,
  getAggregatorAddress,
  getAggregatorName,
  getClusterMetadata,
} from "../src/aggregators";

type RawClusterMetadata = {
  chainId: number;
  deployer: string;
  explorerUrl: string;
  $note?: string;
};

type RawAggregatorsJson = {
  $clusters?: Record<string, RawClusterMetadata>;
  [chainId: string]: unknown;
};

const ROOT = aggregatorsJson as RawAggregatorsJson;

describe("aggregator cluster metadata", () => {
  it("exposes dashboard-friendly metadata for known clusters", () => {
    const meta = getClusterMetadata("cluster-7dc08ec28f299c06");
    expect(meta).toEqual({
      chainId: 42220,
      deployer: "0x7dc08ec28f299c062d2941de1f9cfb741df8f022",
      explorerUrl:
        "https://celoscan.io/address/0x7dc08ec28f299c062d2941de1f9cfb741df8f022",
      note: expect.stringContaining("CREATE3 factory"),
    });
  });

  it("returns undefined for non-cluster aggregator names", () => {
    expect(getClusterMetadata("squid")).toBeUndefined();
    expect(getClusterMetadata("unknown")).toBeUndefined();
  });

  it("clusterNames matches the $clusters block (sans nested $-prefixed keys)", () => {
    const jsonClusterNames = Object.keys(ROOT.$clusters ?? {})
      .filter((k) => !k.startsWith("$"))
      .sort();
    expect(clusterNames()).toEqual(jsonClusterNames);
  });

  it("_buildClusterMap is defensive against missing or malformed $clusters", () => {
    // An upstream aggregators.json with no $clusters block (or a non-object
    // value) must not crash the module at import — both branches resolve
    // to an empty map.
    expect(_buildClusterMap(undefined)).toEqual({});
    expect(_buildClusterMap(null)).toEqual({});
    expect(_buildClusterMap("not-an-object")).toEqual({});
    expect(_buildClusterMap(42)).toEqual({});
    // Valid input still parses; nested $-prefixed keys are skipped.
    expect(
      _buildClusterMap({
        $comment: "ignored",
        "cluster-abcdef0123456789": {
          chainId: 42220,
          deployer: "0xabcdef",
          explorerUrl: "https://example.test",
        },
        bogus: null,
        scalar: "also-ignored",
      }),
    ).toEqual({
      "cluster-abcdef0123456789": {
        chainId: 42220,
        deployer: "0xabcdef",
        explorerUrl: "https://example.test",
      },
    });
  });

  it("every per-chain cluster reference resolves to a defined cluster", () => {
    const known = new Set(clusterNames());
    for (const { chainId, address, name } of clusterReferences()) {
      expect(
        known.has(name),
        `${address} on chain ${chainId} references undefined cluster ${name}`,
      ).toBe(true);
    }
  });
});

describe("aggregator address lookups", () => {
  it("getAggregatorName matches names from the canonical JSON", () => {
    expect(
      getAggregatorName(42220, "0xce16f69375520ab01377ce7b88f5ba8c48f8d666"),
    ).toBe("squid");
    expect(
      getAggregatorName(42220, "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"),
    ).toBe("lifi");
  });

  it("getAggregatorName is case-insensitive and returns null for unknowns", () => {
    expect(
      getAggregatorName(42220, "0xCE16F69375520AB01377CE7B88F5BA8C48F8D666"),
    ).toBe("squid");
    expect(
      getAggregatorName(42220, "0x0000000000000000000000000000000000000000"),
    ).toBeNull();
  });

  it("getAggregatorAddress round-trips known (chain, name) pairs", () => {
    const squid = getAggregatorAddress(42220, "squid");
    expect(squid).toBe("0xce16f69375520ab01377ce7b88f5ba8c48f8d666");
    expect(squid && getAggregatorName(42220, squid)).toBe("squid");
  });

  it("getAggregatorAddress returns null for unknown name or chain", () => {
    expect(getAggregatorAddress(42220, "not-a-real-aggregator")).toBeNull();
    expect(getAggregatorAddress(99, "squid")).toBeNull();
  });

  it("aggregatorsByChain returns an empty map for unknown chains", () => {
    const empty = aggregatorsByChain(99);
    expect(empty.size).toBe(0);
  });

  it("getAggregatorName returns null for unknown chains", () => {
    expect(
      getAggregatorName(99, "0xce16f69375520ab01377ce7b88f5ba8c48f8d666"),
    ).toBeNull();
  });

  it("aggregatorsByChain covers every entry in the JSON", () => {
    for (const [chainKey, perChain] of Object.entries(ROOT)) {
      if (chainKey.startsWith("$")) continue;
      const chainId = Number(chainKey);
      if (!Number.isFinite(chainId)) continue;
      const live = aggregatorsByChain(chainId);
      const jsonAddrs = Object.keys(perChain as Record<string, unknown>).filter(
        (k) => !k.startsWith("$"),
      );
      expect(live.size).toBe(jsonAddrs.length);
      for (const a of jsonAddrs) {
        expect(live.get(a.toLowerCase())).toBeTruthy();
      }
    }
  });
});

function clusterReferences(): Array<{
  chainId: string;
  address: string;
  name: string;
}> {
  const refs: Array<{ chainId: string; address: string; name: string }> = [];
  for (const [chainId, value] of Object.entries(ROOT)) {
    if (chainId.startsWith("$") || typeof value !== "object" || !value) {
      continue;
    }
    for (const [address, entry] of Object.entries(value)) {
      if (address.startsWith("$") || typeof entry !== "object" || !entry) {
        continue;
      }
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.startsWith("cluster-")) {
        refs.push({ chainId, address, name });
      }
    }
  }
  return refs;
}
