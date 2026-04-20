import { ERC20_DECIMALS_ABI } from "./abis";
import { getRpcClient } from "./rpc";
import _contractsJson from "@mento-protocol/contracts/contracts.json";
import _namespaces from "../config/deployment-namespaces.json";

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
 * Relies on `decimals` fields in the contracts package (v0.4.0+).
 * Automatically covers all tokens across all indexed chains.
 *
 * Wormhole NTT hub/spoke split: Monad deployments are named "*Spoke" but the
 * on-chain ERC20 symbol() returns the canonical hub name. Keep name-stripping
 * in sync with ui-dashboard/src/lib/networks.ts buildNetworkMaps.
 */
import type { ContractsJson } from "./contractAddresses";

function buildKnownTokenMeta(): Map<
  string,
  { symbol: string; decimals: number }
> {
  const meta = new Map<string, { symbol: string; decimals: number }>();
  const contracts = _contractsJson as ContractsJson;
  for (const [chainId, namespaces] of Object.entries(contracts)) {
    const ns = (_namespaces as Record<string, string>)[chainId];
    if (!ns) continue;
    const entries = namespaces[ns];
    if (!entries) continue;
    for (const [name, info] of Object.entries(entries)) {
      if (info.type !== "token" || info.decimals === undefined) continue;
      // Skip internal deployment names (e.g. StableTokenSpoke, MockUSDm).
      // Only real ERC20 symbols like "USDm", "USDC", "EURm" should be used.
      if (name.startsWith("StableToken") || name.startsWith("Mock")) continue;
      const symbol = name.endsWith("Spoke") ? name.slice(0, -5) : name;
      const key = `${chainId}:${info.address.toLowerCase()}`;
      meta.set(key, { symbol, decimals: info.decimals });
    }
  }
  return meta;
}

const KNOWN_TOKEN_META = buildKnownTokenMeta();

/**
 * Test-only additions to the known-fee-token allowlist. Mirrors the pattern
 * used by _testFeeTokenMeta. Production code does not populate this set.
 */
const _testAllowedFeeTokens = new Set<string>();

/** Add a token to the allowlist for tests. */
export function _addMockAllowedFeeToken(
  chainId: number,
  tokenAddress: string,
): void {
  _testAllowedFeeTokens.add(`${chainId}:${tokenAddress.toLowerCase()}`);
}

/** Clear all test-only allowlist entries. */
export function _clearMockAllowedFeeTokens(): void {
  _testAllowedFeeTokens.clear();
}

/**
 * Returns true if `(chainId, tokenAddress)` is a known Mento fee token
 * according to `@mento-protocol/contracts`. Used as a registration gate by
 * `FPMMFactory.FPMMDeployed.contractRegister` to prevent an attacker-controlled
 * pool (if one ever slipped past governance) from registering arbitrary ERC20
 * addresses and forcing the indexer to consume their Transfer events.
 *
 * The Mento FPMMFactory is `onlyOwner`, so the exploit path requires a
 * compromised factory owner, but gating at the indexer is cheap insurance and
 * bounds the registered-contracts set to the canonical Mento token registry.
 * New legitimate tokens ship via a `@mento-protocol/contracts` version bump.
 */
export function isKnownFeeToken(
  chainId: number,
  tokenAddress: string,
): boolean {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  return KNOWN_TOKEN_META.has(key) || _testAllowedFeeTokens.has(key);
}

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
