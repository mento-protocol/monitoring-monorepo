import deploymentNamespacesJson from "../deployment-namespaces.json" with { type: "json" };

export const DEPLOYMENT_NAMESPACE_CHAIN_IDS = [
  "42220",
  "11142220",
  "143",
  "10143",
] as const;

export type DeploymentNamespaceChainId =
  (typeof DEPLOYMENT_NAMESPACE_CHAIN_IDS)[number];
export type DeploymentNamespaceByChainId = Readonly<
  Record<DeploymentNamespaceChainId, string>
>;

export const DEPLOYMENT_NAMESPACES: DeploymentNamespaceByChainId =
  deploymentNamespacesJson;

export function deploymentNamespace(chainId: number): string | null {
  return (
    (DEPLOYMENT_NAMESPACES as Readonly<Record<string, string>>)[
      String(chainId)
    ] ?? null
  );
}

export default DEPLOYMENT_NAMESPACES;
