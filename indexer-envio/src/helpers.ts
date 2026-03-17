// ---------------------------------------------------------------------------
// Shared pure utility functions
// ---------------------------------------------------------------------------

export const eventId = (
  chainId: number,
  blockNumber: number,
  logIndex: number,
): string => `${chainId}_${blockNumber}_${logIndex}`;

export const asAddress = (value: string): string => value.toLowerCase();
export const asBigInt = (value: number): bigint => BigInt(value);

export const SECONDS_PER_HOUR = 3600n;

/** Round a unix timestamp down to the start of its hour. */
export const hourBucket = (timestamp: bigint): bigint =>
  (timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;

/** Deterministic snapshot ID: "{poolId}-{hourTimestamp}" */
export const snapshotId = (poolId: string, hourTs: bigint): string =>
  `${poolId}-${hourTs}`;
