// ---------------------------------------------------------------------------
// Fee token subsystem: metadata resolution, backfill helpers, test mocks
// ---------------------------------------------------------------------------

import { ERC20_DECIMALS_ABI } from "./abis";
import { getRpcClient } from "./rpc";

/**
 * Address that receives all protocol fees across all chains.
 * Only Transfer events where `to` matches this address are stored.
 */
export const YIELD_SPLIT_ADDRESS =
  "0x0dd57f6f181d0469143fe9380762d8a112e96e4a" as const;

// ---------------------------------------------------------------------------
// Test hooks for fee-token metadata (resolveFeeTokenMeta RPC layer)
// ---------------------------------------------------------------------------

/** Map of cacheKey → mock metadata, used in tests to bypass RPC. */
const _testFeeTokenMeta = new Map<
  string,
  { symbol: string; decimals: number } | "FAIL"
>();

/**
 * Pre-seed a fee-token metadata response for tests.
 * Use "FAIL" as the value to simulate a transient RPC failure.
 */
export function _setMockFeeTokenMeta(
  chainId: number,
  tokenAddress: string,
  meta: { symbol: string; decimals: number } | "FAIL",
): void {
  _testFeeTokenMeta.set(`${chainId}:${tokenAddress.toLowerCase()}`, meta);
}

export function _clearMockFeeTokenMeta(): void {
  _testFeeTokenMeta.clear();
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Cache for token metadata fetched via RPC (one call per unique token, then cached). */
const feeTokenMetaCache = new Map<
  string,
  { symbol: string; decimals: number }
>();

/**
 * Tracks tokens whose UNKNOWN backfill has already run in this indexer session.
 * Prevents O(n²) DB scans by ensuring the backfill query runs at most once per
 * unique (chainId, tokenAddress) pair.
 */
export const backfilledTokens = new Set<string>();

export function _clearBackfilledTokens(): void {
  backfilledTokens.clear();
}

export function _clearFeeTokenMetaCache(): void {
  feeTokenMetaCache.clear();
}

// ---------------------------------------------------------------------------
// Metadata resolution
// ---------------------------------------------------------------------------

/**
 * Resolve symbol + decimals for a fee token via RPC (cached after first call).
 */
export async function resolveFeeTokenMeta(
  chainId: number,
  tokenAddress: string,
): Promise<{ symbol: string; decimals: number }> {
  const lower = tokenAddress.toLowerCase();
  const cacheKey = `${chainId}:${lower}`;
  const cached = feeTokenMetaCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Test hook — bypass RPC with pre-seeded metadata.
    const testMeta = _testFeeTokenMeta.get(cacheKey);
    if (testMeta !== undefined) {
      if (testMeta === "FAIL") throw new Error("[test] simulated RPC failure");
      feeTokenMetaCache.set(cacheKey, testMeta);
      return testMeta;
    }

    const client = getRpcClient(chainId);
    const [decimals, symbol] = await Promise.all([
      client.readContract({
        address: lower as `0x${string}`,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      }),
      client.readContract({
        address: lower as `0x${string}`,
        abi: ERC20_DECIMALS_ABI,
        functionName: "symbol",
      }),
    ]);
    const meta = { symbol: symbol as string, decimals: Number(decimals) };
    feeTokenMetaCache.set(cacheKey, meta);
    return meta;
  } catch {
    console.warn(
      `[ERC20FeeToken] Failed to read decimals/symbol for ${tokenAddress} on chain ${chainId}. ` +
        `Using fallback (18dp / UNKNOWN) for this event only — will retry on next transfer.`,
    );
    return { symbol: "UNKNOWN", decimals: 18 };
  }
}

// ---------------------------------------------------------------------------
// Pure backfill helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Filter a list of ProtocolFeeTransfer records to those that need backfilling:
 * - tokenSymbol === "UNKNOWN" (unresolved placeholder)
 * - id starts with `${chainId}_` (same chain only — prevents cross-chain corruption)
 */
export function selectStaleTransfers<
  T extends { id: string; tokenSymbol: string },
>(records: ReadonlyArray<T>, chainId: number): Array<T> {
  const prefix = `${chainId}_`;
  return records.filter(
    (r) => r.tokenSymbol === "UNKNOWN" && r.id.startsWith(prefix),
  );
}
