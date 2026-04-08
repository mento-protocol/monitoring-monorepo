/**
 * Contract address resolution from @mento-protocol/contracts.
 *
 * Extracted into a separate module so both EventHandlers.ts (runtime)
 * and tests can import the same production lookup code, ensuring tests
 * exercise the real implementation path rather than re-implementing it.
 *
 * @mento-protocol/contracts is ESM-only (no CJS "require" export condition).
 * We use static JSON subpath imports — TypeScript compiles these to require()
 * under module:CommonJS, making them CJS-safe for the Envio handler runtime.
 */
import _contractsJson from "@mento-protocol/contracts/contracts.json";
import _namespaces from "../config/deployment-namespaces.json";

// Vendored chain ID -> namespace map for Envio hosted compatibility.
// Envio may build indexer-envio outside the pnpm workspace, so the indexer
// cannot depend on the shared workspace package at deploy time.
export const CONTRACT_NAMESPACE_BY_CHAIN: Record<string, string> = _namespaces;

export type ContractsJson = Record<
  string,
  Record<
    string,
    Record<string, { address: string; type?: string; decimals?: number }>
  >
>;

/**
 * Look up a contract address by chainId + contractName using the explicit
 * namespace map. Returns undefined if chainId is not indexed or contract
 * is not present in the package for that namespace.
 */
export function getContractAddress(
  chainId: number,
  contractName: string,
): `0x${string}` | undefined {
  const ns = CONTRACT_NAMESPACE_BY_CHAIN[String(chainId)];
  if (!ns) return undefined;
  const entry = (_contractsJson as ContractsJson)[String(chainId)]?.[ns]?.[
    contractName
  ];
  return entry?.address as `0x${string}` | undefined;
}

/**
 * Like getContractAddress but throws at module init if the address is missing.
 * Use for addresses that are required for correct indexer operation — missing
 * addresses would cause silent data quality issues (wrong oracle counts, wrong
 * USDm direction detection, priceDifference collapsing to 0).
 */
export function requireContractAddress(
  chainId: number,
  contractName: string,
): `0x${string}` {
  const addr = getContractAddress(chainId, contractName);
  if (!addr) {
    throw new Error(
      `[contractAddresses] Missing address for ${contractName} on chain ${chainId} ` +
        `in @mento-protocol/contracts (namespace: ${CONTRACT_NAMESPACE_BY_CHAIN[String(chainId)] ?? "unknown"}). ` +
        `Update indexer-envio/config/deployment-namespaces.json and shared-config/deployment-namespaces.json, or bump the package version.`,
    );
  }
  return addr;
}

/**
 * Build a {chainId: address} map for a given contract name across all indexed chains.
 * Chains missing from @mento-protocol/contracts are skipped with a console warning
 * rather than throwing — this allows the indexer to start for chains that ARE in the
 * package even if new chains haven't been published yet.
 *
 * Use requireContractAddress() directly when you need a hard guarantee.
 */
export function buildAddressMap(
  contractName: string,
): Record<string, `0x${string}`> {
  const result: Record<string, `0x${string}`> = {};
  for (const chainId of Object.keys(CONTRACT_NAMESPACE_BY_CHAIN)) {
    const addr = getContractAddress(Number(chainId), contractName);
    if (addr) {
      result[chainId] = addr;
    } else {
      console.warn(
        `[contractAddresses] ${contractName} not found for chain ${chainId} ` +
          `(namespace: ${CONTRACT_NAMESPACE_BY_CHAIN[Number(chainId)] ?? "unknown"}) ` +
          `in @mento-protocol/contracts. Update the package when the deployment is published.`,
      );
    }
  }
  return result;
}
