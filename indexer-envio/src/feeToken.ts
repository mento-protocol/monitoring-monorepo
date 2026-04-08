import { ERC20_DECIMALS_ABI } from "./abis";
import { getRpcClient } from "./rpc";

/**
 * Address that receives all protocol fees across all chains.
 * Only Transfer events where `to` matches this address are stored.
 */
export const YIELD_SPLIT_ADDRESS =
  "0x0dd57f6f181d0469143fe9380762d8a112e96e4a" as const;

/** Map of cacheKey → mock metadata, used in tests to bypass RPC. */
const _testFeeTokenMeta = new Map<
  string,
  { symbol: string; decimals: number } | "FAIL"
>();

/** Pre-seed a fee-token metadata response for tests. Use "FAIL" to simulate RPC failure. */
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

/**
 * Static fallback for known Mento fee tokens when RPC is unavailable.
 * Intentionally separate from the dashboard's @mento-protocol/contracts
 * package -- the indexer runs independently and needs a self-contained fallback.
 */
const KNOWN_TOKEN_META = new Map<string, { symbol: string; decimals: number }>([
  // Celo Mainnet (42220)
  [
    "42220:0x765de816845861e75a25fca122bb6898b8b1282a",
    { symbol: "USDm", decimals: 18 },
  ],
  [
    "42220:0xceba9300f2b948710d2653dd7b07f33a8b32118c",
    { symbol: "USDC", decimals: 6 },
  ],
  [
    "42220:0xeb466342c4d449bc9f53a865d5cb90586f405215",
    { symbol: "axlUSDC", decimals: 6 },
  ],
  [
    "42220:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
    { symbol: "USD\u20AE", decimals: 6 },
  ],
  // EUR-pegged
  [
    "42220:0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73",
    { symbol: "EURm", decimals: 18 },
  ],
  [
    "42220:0x061cc5a2c863e0c1cb404006d559db18a34c762d",
    { symbol: "axlEUROC", decimals: 6 },
  ],
  // Other fiat stablecoins (all 18 decimals)
  [
    "42220:0xccf663b1ff11028f0b19058d0f7b674004a40746",
    { symbol: "GBPm", decimals: 18 },
  ],
  [
    "42220:0x7175504c455076f15c04a2f90a8e352281f492f9",
    { symbol: "AUDm", decimals: 18 },
  ],
  [
    "42220:0xff4ab19391af240c311c54200a492233052b6325",
    { symbol: "CADm", decimals: 18 },
  ],
  [
    "42220:0xb55a79f398e759e43c95b979163f30ec87ee131d",
    { symbol: "CHFm", decimals: 18 },
  ],
  [
    "42220:0x456a3d042c0dbd3db53d5489e98dfb038553b0d0",
    { symbol: "KESm", decimals: 18 },
  ],
  [
    "42220:0xe8537a3d056da446677b9e9d6c5db704eaab4787",
    { symbol: "BRLm", decimals: 18 },
  ],
  [
    "42220:0x8a567e2ae79ca692bd748ab832081c45de4041ea",
    { symbol: "COPm", decimals: 18 },
  ],
  [
    "42220:0xfaea5f3404bba20d3cc2f8c4b0a888f55a3c7313",
    { symbol: "GHSm", decimals: 18 },
  ],
  [
    "42220:0xc45ecf20f3cd864b32d9794d6f76814ae8892e20",
    { symbol: "JPYm", decimals: 18 },
  ],
  [
    "42220:0xe2702bd97ee33c88c8f6f92da3b733608aa76f71",
    { symbol: "NGNm", decimals: 18 },
  ],
  [
    "42220:0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b",
    { symbol: "PHPm", decimals: 18 },
  ],
  [
    "42220:0x73f93dcc49cb8a239e2032663e9475dd5ef29a08",
    { symbol: "XOFm", decimals: 18 },
  ],
  [
    "42220:0x4c35853a3b4e647fd266f4de678dcc8fec410bf6",
    { symbol: "ZARm", decimals: 18 },
  ],
  // Monad Mainnet (143)
  [
    "143:0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    { symbol: "AUSD", decimals: 6 },
  ],
  [
    "143:0xbc69212b8e4d445b2307c9d32dd68e2a4df00115",
    { symbol: "USDm", decimals: 18 },
  ],
  [
    "143:0x754704bc059f8c67012fed69bc8a327a5aafb603",
    { symbol: "USDC", decimals: 6 },
  ],
  [
    "143:0x39bb4e0a204412bb98e821d25e7d955e69d40fd1",
    { symbol: "GBPm", decimals: 18 },
  ],
]);

/**
 * Resolve symbol + decimals for a fee token via RPC (cached after first call).
 * Falls back to a static map of known Mento tokens when RPC is unavailable.
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
    // Try static fallback before giving up
    const staticMeta = KNOWN_TOKEN_META.get(cacheKey);
    if (staticMeta) {
      console.warn(
        `[ERC20FeeToken] RPC failed for ${tokenAddress} on chain ${chainId}. ` +
          `Using static fallback: ${staticMeta.symbol} (${staticMeta.decimals}dp).`,
      );
      feeTokenMetaCache.set(cacheKey, staticMeta);
      return staticMeta;
    }
    console.warn(
      `[ERC20FeeToken] Failed to read decimals/symbol for ${tokenAddress} on chain ${chainId}. ` +
        `No static fallback available. Using (18dp / UNKNOWN) for this event only — will retry on next transfer.`,
    );
    return { symbol: "UNKNOWN", decimals: 18 };
  }
}

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
