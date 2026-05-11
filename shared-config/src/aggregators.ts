import clustersJson from "../aggregator-clusters.json" with { type: "json" };

type RawClusterMetadata = {
  chainId: number;
  deployer: string;
  explorerUrl: string;
  $note?: string;
};

export type AggregatorClusterMetadata = {
  chainId: number;
  deployer: string;
  explorerUrl: string;
  note?: string;
};

const CLUSTERS = clustersJson as Record<string, RawClusterMetadata>;

export function getClusterMetadata(
  aggregatorName: string,
): AggregatorClusterMetadata | undefined {
  const meta = CLUSTERS[aggregatorName];
  if (!meta) return undefined;
  return {
    chainId: meta.chainId,
    deployer: meta.deployer,
    explorerUrl: meta.explorerUrl,
    note: meta.$note,
  };
}

export function clusterNames(): string[] {
  return Object.keys(CLUSTERS).sort();
}
