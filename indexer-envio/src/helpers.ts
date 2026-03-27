// ---------------------------------------------------------------------------
// Shared pure utility functions
// ---------------------------------------------------------------------------

export const eventId = (
  chainId: number,
  blockNumber: number,
  logIndex: number,
): string => `${chainId}_${blockNumber}_${logIndex}`;

export const asAddress = (value: string): string => value.toLowerCase();

/**
 * Canonical multichain pool ID: "{chainId}-{lowercaseAddress}".
 *
 * Using this consistently across all handlers prevents cross-chain entity
 * collisions when the same contract address appears on multiple chains
 * (e.g. CREATE2-deployed contracts with identical addresses on Celo and Monad).
 */
export const makePoolId = (chainId: number, address: string): string =>
  `${chainId}-${asAddress(address)}`;

/**
 * Extract the raw pool address from a namespaced pool ID.
 * "{chainId}-{address}" → "{address}"
 *
 * Used when passing poolId to RPC functions that expect a raw address.
 */
export const poolIdToAddress = (poolId: string): string => {
  const idx = poolId.indexOf("-");
  return idx >= 0 ? poolId.slice(idx + 1) : poolId;
};
export const asBigInt = (value: number): bigint => BigInt(value);

export const SECONDS_PER_HOUR = 3600n;

/** Round a unix timestamp down to the start of its hour. */
export const hourBucket = (timestamp: bigint): bigint =>
  (timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;

/** Deterministic snapshot ID: "{poolId}-{hourTimestamp}" */
export const snapshotId = (poolId: string, hourTs: bigint): string =>
  `${poolId}-${hourTs}`;
