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

// Explicit namespace per chain — must match the active deployment namespace in
// @mento-protocol/contracts.
//
// NOTE: ui-dashboard/src/lib/networks.ts defines the same mapping via
// ACTIVE_DEPLOYMENT. These two are intentionally kept in sync manually.
// A future improvement could extract a shared @mento-protocol/config package,
// but that would require cross-package infrastructure changes out of scope here.
export const CONTRACT_NAMESPACE_BY_CHAIN: Record<number, string> = {
  42220: "mainnet", // Celo mainnet — matches ACTIVE_DEPLOYMENT["celo-mainnet"]
  11142220: "testnet-v2-rc5", // Celo Sepolia — matches ACTIVE_DEPLOYMENT["celo-sepolia"]
};

type ContractsJson = Record<
  string,
  Record<string, Record<string, { address: string }>>
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
  const ns = CONTRACT_NAMESPACE_BY_CHAIN[chainId];
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
        `in @mento-protocol/contracts (namespace: ${CONTRACT_NAMESPACE_BY_CHAIN[chainId] ?? "unknown"}). ` +
        `Update CONTRACT_NAMESPACE_BY_CHAIN or the package version.`,
    );
  }
  return addr;
}

/**
 * Build a {chainId: address} map for a given contract name across all indexed chains.
 * All entries are required — throws at module init if any chain is missing the contract.
 */
export function buildRequiredAddressMap(
  contractName: string,
): Record<string, `0x${string}`> {
  const result: Record<string, `0x${string}`> = {};
  for (const chainId of Object.keys(CONTRACT_NAMESPACE_BY_CHAIN)) {
    result[chainId] = requireContractAddress(Number(chainId), contractName);
  }
  return result;
}
