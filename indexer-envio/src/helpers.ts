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
 *
 * chainId is typed as number | bigint to match Envio's event.chainId runtime type,
 * which may be either depending on the Envio version.
 */
export const makePoolId = (chainId: number | bigint, address: string): string =>
  `${chainId}-${asAddress(address)}`;

/**
 * Extract the raw Ethereum address from a namespaced pool ID.
 * "{chainId}-{0xaddress}" → "{0xaddress}"
 *
 * This function must only ever receive namespaced IDs produced by makePoolId.
 * If a bare address reaches here post-migration, it indicates a bug at the
 * call site — we throw unconditionally rather than silently returning garbage.
 *
 * Ethereum addresses are hex-only (0-9a-f) and can never contain a dash, so
 * the first dash is always the chainId separator. We validate the extracted
 * value starts with "0x" in all environments to catch double-namespacing
 * (e.g. "42220-42220-0x...") as early as possible.
 *
 * Used when passing poolId to RPC functions that expect a raw contract address.
 */
export const extractAddressFromPoolId = (poolId: string): string => {
  const match = poolId.match(/^\d+-(.+)$/);
  if (!match) {
    throw new Error(
      `[extractAddressFromPoolId] Expected namespaced pool ID "{chainId}-0x{hex}", got "${poolId}". ` +
        `Call site is passing a bare address — use event.srcAddress instead.`,
    );
  }
  const addr = match[1]!;
  if (!addr.startsWith("0x")) {
    throw new Error(
      `[extractAddressFromPoolId] Unexpected format — extracted "${addr}" from poolId "${poolId}". ` +
        `Possible double-namespacing (e.g. "42220-42220-0x..."). Expected "{chainId}-0x{hex}".`,
    );
  }
  return addr;
};
export const asBigInt = (value: number): bigint => BigInt(value);

export const SECONDS_PER_HOUR = 3600n;

/** Round a unix timestamp down to the start of its hour. */
export const hourBucket = (timestamp: bigint): bigint =>
  (timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;

/** Deterministic snapshot ID: "{poolId}-{hourTimestamp}" */
export const snapshotId = (poolId: string, hourTs: bigint): string =>
  `${poolId}-${hourTs}`;
