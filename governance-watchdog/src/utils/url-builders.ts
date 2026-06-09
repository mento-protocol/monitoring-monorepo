/**
 * Base URLs for external links
 */
const CELOSCAN_BASE_URL = "https://celoscan.io";
const GOVERNANCE_BASE_URL = "https://governance.mento.org";

/**
 * Creates a proposal link URL
 */
export function createProposalLink(proposalId: bigint): string {
  return `${GOVERNANCE_BASE_URL}/proposals/${proposalId.toString()}`;
}

/**
 * Creates a transaction link URL
 */
export function createTransactionLink(txHash: string): string {
  return `${CELOSCAN_BASE_URL}/tx/${txHash}`;
}

/**
 * Creates an address link URL
 */
export function createAddressLink(address: string): string {
  return `${CELOSCAN_BASE_URL}/address/${address}`;
}
