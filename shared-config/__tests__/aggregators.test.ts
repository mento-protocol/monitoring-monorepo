import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import clustersJson from "../aggregator-clusters.json" with { type: "json" };
import { clusterNames, getClusterMetadata } from "../src/aggregators";

type RawClusterMetadata = {
  chainId: number;
  deployer: string;
  explorerUrl: string;
  $note?: string;
};

type IndexerAggregatorsConfig = {
  $clusters?: Record<string, RawClusterMetadata | string | undefined>;
  [chainId: string]:
    | Record<string, { name?: unknown } | string | undefined>
    | Record<string, RawClusterMetadata | string | undefined>
    | string
    | undefined;
};

const INDEXER_CONFIG = JSON.parse(
  readFileSync(
    new URL("../../indexer-envio/config/aggregators.json", import.meta.url),
    "utf8",
  ),
) as IndexerAggregatorsConfig;

describe("aggregator cluster metadata", () => {
  it("exposes dashboard-friendly metadata for known clusters", () => {
    const meta = getClusterMetadata("cluster-7dc08ec28f299c06");
    expect(meta).toEqual({
      chainId: 42220,
      deployer: "0x7dc08ec28f299c062d2941de1f9cfb741df8f022",
      explorerUrl:
        "https://celoscan.io/address/0x7dc08ec28f299c062d2941de1f9cfb741df8f022",
      note: expect.stringContaining("deployer provenance"),
    });
  });

  it("returns undefined for non-cluster aggregator names", () => {
    expect(getClusterMetadata("squid")).toBeUndefined();
    expect(getClusterMetadata("unknown")).toBeUndefined();
  });

  it("stays in sync with the indexer aggregator cluster config", () => {
    const sharedClusters = clustersJson as Record<string, RawClusterMetadata>;
    const indexerClusters = Object.fromEntries(
      Object.entries(INDEXER_CONFIG.$clusters ?? {}).filter(
        ([name, value]) => !name.startsWith("$") && typeof value === "object",
      ),
    ) as Record<string, RawClusterMetadata>;

    expect(clusterNames()).toEqual(Object.keys(indexerClusters).sort());
    for (const [name, sharedMeta] of Object.entries(sharedClusters)) {
      expect(indexerClusters[name]).toMatchObject({
        chainId: sharedMeta.chainId,
        deployer: sharedMeta.deployer,
        explorerUrl: sharedMeta.explorerUrl,
      });
    }
  });

  it("covers every per-chain cluster reference used by the indexer", () => {
    const sharedClusters = clustersJson as Record<string, RawClusterMetadata>;
    for (const { chainId, address, name } of indexerClusterReferences()) {
      expect(
        sharedClusters[name],
        `${address} on chain ${chainId} references missing cluster metadata ${name}`,
      ).toBeDefined();
    }
  });
});

function indexerClusterReferences(): Array<{
  chainId: string;
  address: string;
  name: string;
}> {
  const refs: Array<{ chainId: string; address: string; name: string }> = [];
  for (const [chainId, value] of Object.entries(INDEXER_CONFIG)) {
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
