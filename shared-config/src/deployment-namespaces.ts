import deploymentNamespacesJson from "../deployment-namespaces.json" with { type: "json" };

export type DeploymentNamespaceChainId = keyof typeof deploymentNamespacesJson;
export type DeploymentNamespaceByChainId = Readonly<
  Record<DeploymentNamespaceChainId, string>
>;

export const DEPLOYMENT_NAMESPACES =
  deploymentNamespacesJson as DeploymentNamespaceByChainId;

export function deploymentNamespace(chainId: number): string | null {
  return (
    (DEPLOYMENT_NAMESPACES as Readonly<Record<string, string>>)[
      String(chainId)
    ] ?? null
  );
}

export default DEPLOYMENT_NAMESPACES;
