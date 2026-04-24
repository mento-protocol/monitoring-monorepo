// ---------------------------------------------------------------------------
// RPC client management, fetch functions, caches, and test mocks
// ---------------------------------------------------------------------------

import { createPublicClient, http } from "viem";
import type { HandlerContext } from "generated/src/Types";
import type { Pool } from "generated";
import {
  SortedOraclesContract,
  FPMM_MINIMAL_ABI,
  FPMM_FEE_ABI,
  FPMM_TRADING_LIMITS_ABI,
  ERC20_DECIMALS_ABI,
} from "./abis";
import type { TradingLimitData } from "./tradingLimits";

// ---------------------------------------------------------------------------
// RPC failure logging
// ---------------------------------------------------------------------------

/** How many failures of the same (chainId, fn) to accumulate before emitting
 * an additional [RPC_FAILURE_BURST] summary line. Individual failures are
 * always logged; the burst line is the "pattern detected" signal for monitoring. */
const RPC_BURST_INTERVAL = 10;

/** Monotonically increasing failure count per `chainId:fn` key. */
const _rpcFailureCounts = new Map<string, number>();

function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/https?:\/\/[^\s,)""]*/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}/<redacted>`;
    } catch {
      return "<url-redacted>";
    }
  });
}

/** Known contract revert signatures and their human-readable meaning.
 * When a contract call reverts with one of these, it's expected behaviour
 * (e.g. stale oracle data) rather than an infrastructure problem, so we
 * log at debug level instead of warn. */
const KNOWN_REVERT_SIGNATURES: Record<string, string> = {
  "0xa407143a":
    "OracleStaleOrExpired — oracle data is stale or expired, getRebalancingState cannot compute",
};

/** Extract a 4-byte revert selector from an error message, if present. */
function extractRevertSignature(msg: string): string | undefined {
  const match = msg.match(/reverted with the following signature:\s*$/m);
  if (match) {
    // The signature is typically on the next line or nearby in the message.
    const sigMatch = msg.match(/\b(0x[0-9a-f]{8})\b/i);
    return sigMatch?.[1]?.toLowerCase();
  }
  // Also match inline: "reverted with the following signature: 0x..."
  const inline = msg.match(
    /reverted with the following signature:?\s*(0x[0-9a-f]{8})/i,
  );
  return inline?.[1]?.toLowerCase();
}

/**
 * Log a structured RPC failure. Known contract reverts are logged at debug
 * level with a human-readable explanation; unexpected failures are logged at
 * warn level. A burst-summary line is emitted every `RPC_BURST_INTERVAL`
 * failures for the same chain+function combination regardless of level.
 */
function logRpcFailure(
  chainId: number,
  fn: string,
  target: string,
  err: unknown,
  block?: bigint,
): void {
  const message =
    err instanceof Error
      ? sanitizeErrorMessage(err.message)
      : String(err ?? "unknown error");
  const blockStr = block !== undefined ? ` block=${block}` : "";

  // Check if this is a known contract revert (expected, not an RPC problem).
  const revertSig = extractRevertSignature(message);
  const knownRevert = revertSig
    ? KNOWN_REVERT_SIGNATURES[revertSig]
    : undefined;

  if (knownRevert) {
    console.debug(
      `[CONTRACT_REVERT] chainId=${chainId} fn=${fn} target=${target}${blockStr} — ${knownRevert}`,
    );
  } else {
    console.warn(
      `[RPC_FAILURE] chainId=${chainId} fn=${fn} target=${target}${blockStr} error=${message}`,
    );
  }

  const burstKey = `${chainId}:${fn}`;
  const count = (_rpcFailureCounts.get(burstKey) ?? 0) + 1;
  _rpcFailureCounts.set(burstKey, count);
  if (count % RPC_BURST_INTERVAL === 0) {
    const tag = knownRevert ? "CONTRACT_REVERT_BURST" : "RPC_FAILURE_BURST";
    console.warn(`[${tag}] chainId=${chainId} fn=${fn} failureCount=${count}`);
  }
}

// ---------------------------------------------------------------------------
// Test hooks — only used in unit tests to inject mock RPC responses.
// Never set in production; fetch* functions check these maps first.
// ---------------------------------------------------------------------------

const _testRebalancingStates = new Map<string, RebalancingState | null>();

/** @internal Test-only: pre-set a mock rebalancing state for a pool. */
export function _setMockRebalancingState(
  chainId: number,
  poolAddress: string,
  state: RebalancingState | null,
): void {
  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  if (state === null) {
    _testRebalancingStates.delete(key);
  } else {
    _testRebalancingStates.set(key, state);
  }
}

/** @internal Test-only: clear all mock rebalancing states. */
export function _clearMockRebalancingStates(): void {
  _testRebalancingStates.clear();
}

/** Sentinel value representing a mock null return (RPC failure simulation).
 * Distinct from "no mock set" (which falls through to real RPC). */
const NULL_RESERVES = Symbol("null-reserves");

const _testReserves = new Map<
  string,
  { reserve0: bigint; reserve1: bigint } | typeof NULL_RESERVES
>();

/** @internal Test-only: pre-set mock on-chain reserves for a pool.
 * Pass `null` to simulate an RPC failure (fetchReserves returns null).
 * Call `_clearMockReserves()` to remove all mocks and restore real RPC. */
export function _setMockReserves(
  chainId: number,
  poolAddress: string,
  reserves: { reserve0: bigint; reserve1: bigint } | null,
): void {
  const key = `${chainId}:${poolAddress.toLowerCase()}`;
  _testReserves.set(key, reserves === null ? NULL_RESERVES : reserves);
}

/** @internal Test-only: clear all mock reserves. */
export function _clearMockReserves(): void {
  _testReserves.clear();
}

/** @internal Test-only: pre-set mock ERC20 decimals for a token address. */
const _testERC20Decimals = new Map<string, number>();

export function _setMockERC20Decimals(
  chainId: number,
  tokenAddress: string,
  decimals: number,
): void {
  _testERC20Decimals.set(`${chainId}:${tokenAddress.toLowerCase()}`, decimals);
}

export function _clearMockERC20Decimals(): void {
  _testERC20Decimals.clear();
}

// ---------------------------------------------------------------------------
// Test mocks: referenceRateFeedID & reportExpiry (for self-heal testing)
// ---------------------------------------------------------------------------

const _testRateFeedIDs = new Map<string, string | null>();

/** @internal Test-only: pre-set a mock referenceRateFeedID for a pool. */
export function _setMockRateFeedID(
  chainId: number,
  poolAddress: string,
  rateFeedID: string | null,
): void {
  _testRateFeedIDs.set(`${chainId}:${poolAddress.toLowerCase()}`, rateFeedID);
}

export function _clearMockRateFeedIDs(): void {
  _testRateFeedIDs.clear();
}

const _testReportExpiry = new Map<string, bigint | null>();

/** @internal Test-only: pre-set a mock report expiry for a rateFeedID. */
export function _setMockReportExpiry(
  chainId: number,
  rateFeedID: string,
  expiry: bigint | null,
): void {
  _testReportExpiry.set(`${chainId}:${rateFeedID.toLowerCase()}`, expiry);
}

export function _clearMockReportExpiry(): void {
  _testReportExpiry.clear();
}

// ---------------------------------------------------------------------------
// RPC client management
// ---------------------------------------------------------------------------

// Lazy RPC clients per chainId (primary + fallback)
const rpcClients = new Map<number, ReturnType<typeof createPublicClient>>();
const fallbackRpcClients = new Map<
  number,
  ReturnType<typeof createPublicClient>
>();

/** @internal Test-only: clear the cached RPC clients so getRpcClient()
 * re-evaluates URL resolution and fail-fast logic. */
export function _clearRpcClients(): void {
  rpcClients.clear();
  fallbackRpcClients.clear();
}

/** @internal Test-only: inject a mock RPC client so tests can drive
 * downstream helpers (e.g. `fetchRebalancingState`'s cache path) without
 * hitting the network. Clients need a `readContract` method; any other
 * viem surface is unused by the functions tested via this hook. */
export function _setRpcClientForTests(
  chainId: number,
  client: { readContract: (args: unknown) => Promise<unknown> } | null,
): void {
  if (client === null) {
    rpcClients.delete(chainId);
    fallbackRpcClients.delete(chainId);
  } else {
    rpcClients.set(
      chainId,
      client as unknown as ReturnType<typeof createPublicClient>,
    );
  }
}

// Per-chain RPC config for contract reads (eth_call).
// Defaults MUST be full-node RPCs — Envio HyperRPC does NOT support eth_call.
// (Envio's own event syncing uses HyperSync, configured in the YAML files.)
const RPC_CONFIG_BY_CHAIN: Record<number, { default: string; envVar: string }> =
  {
    42220: { default: "https://forno.celo.org", envVar: "ENVIO_RPC_URL_42220" }, // Celo Mainnet
    11142220: {
      default: "https://forno.celo-sepolia.celo-testnet.org",
      envVar: "ENVIO_RPC_URL_11142220",
    }, // Celo Sepolia
    143: { default: "https://rpc2.monad.xyz", envVar: "ENVIO_RPC_URL_143" }, // Monad Mainnet
    10143: {
      default: "https://10143.rpc.hypersync.xyz",
      envVar: "ENVIO_RPC_URL_10143",
    }, // Monad Testnet (no public full-node RPC known)
  };

/**
 * Appends the ENVIO_API_TOKEN to a HyperRPC base URL.
 * HyperRPC requires the token as a path segment: `https://143.rpc.hypersync.xyz/<token>`
 * Returns the URL unchanged if:
 * - no token is set
 * - the URL is not a HyperRPC endpoint
 * - the URL already contains a path segment (i.e. already tokenized)
 */
export function withHyperRpcToken(url: string): string {
  const token = process.env.ENVIO_API_TOKEN;
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(".rpc.hypersync.xyz")) return url;
    // Skip if the URL already has a path beyond "/" (already tokenized).
    if (parsed.pathname !== "/" && parsed.pathname !== "") return url;
    parsed.pathname = `/${token}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Returns true if the URL is a bare (untokenized) HyperRPC endpoint. */
function isBareHyperRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith(".rpc.hypersync.xyz") &&
      (parsed.pathname === "/" || parsed.pathname === "")
    );
  } catch {
    return false;
  }
}

/**
 * Returns a viem public client for the given chainId.
 *
 * RPC resolution order (first match wins):
 * 1. `ENVIO_RPC_URL_{chainId}` — per-chain override (e.g. ENVIO_RPC_URL_42220)
 * 2. `ENVIO_RPC_URL` — legacy single-chain override; only safe when indexing
 *    exactly one chain. Do NOT set this in multichain mode — it will route
 *    all chains to the same endpoint, causing incorrect RPC calls.
 * 3. Hardcoded default in DEFAULT_RPC_BY_CHAIN.
 *
 * If the resolved URL is a HyperRPC endpoint, the ENVIO_API_TOKEN is
 * automatically appended as a path segment for authentication.
 */
export function getRpcClient(
  chainId: number,
): ReturnType<typeof createPublicClient> {
  if (!rpcClients.has(chainId)) {
    const config = RPC_CONFIG_BY_CHAIN[chainId];
    if (!config) {
      throw new Error(
        `[getRpcClient] No RPC config for chainId ${chainId}. ` +
          `Add an entry to RPC_CONFIG_BY_CHAIN in rpc.ts.`,
      );
    }
    // Prefer per-chain env var, then legacy global override, then hardcoded default.
    const perChainOverride = process.env[config.envVar];
    const legacyGlobal = process.env.ENVIO_RPC_URL;
    let rawUrl: string;
    if (perChainOverride) {
      rawUrl = perChainOverride;
    } else if (legacyGlobal) {
      console.warn(
        `[getRpcClient] chainId=${chainId} using legacy ENVIO_RPC_URL fallback. ` +
          `This routes ALL chains to the same endpoint. ` +
          `Set ${config.envVar} instead for multichain mode.`,
      );
      rawUrl = legacyGlobal;
    } else {
      rawUrl = config.default;
    }
    const rpcUrl = withHyperRpcToken(rawUrl);

    // Fail fast if a HyperRPC URL is selected but no token was appended.
    if (isBareHyperRpcUrl(rpcUrl)) {
      throw new Error(
        `[getRpcClient] chainId=${chainId} resolved to HyperRPC (${rawUrl}) ` +
          `but ENVIO_API_TOKEN is not set. Set it in .env or use a non-HyperRPC ` +
          `override via ${config.envVar}.`,
      );
    }

    rpcClients.set(
      chainId,
      createPublicClient({
        transport: http(rpcUrl, { batch: true }),
      }),
    );
  }
  return rpcClients.get(chainId)!;
}

/**
 * Returns a fallback viem public client for the given chainId.
 * Uses the hardcoded default RPC (public endpoint) — only created when the
 * primary client is a different URL (env-var override). Returns null if the
 * primary already IS the default (no point falling back to the same endpoint).
 */
function getFallbackRpcClient(
  chainId: number,
): ReturnType<typeof createPublicClient> | null {
  if (fallbackRpcClients.has(chainId)) {
    return fallbackRpcClients.get(chainId) ?? null;
  }
  const config = RPC_CONFIG_BY_CHAIN[chainId];
  if (!config) return null;

  const fallbackUrl = withHyperRpcToken(config.default);
  // Don't create a fallback if it's a bare HyperRPC URL without a token.
  if (isBareHyperRpcUrl(fallbackUrl)) return null;

  // Check if primary is already using the default — no point falling back to same URL.
  const perChainOverride = process.env[config.envVar];
  const legacyGlobal = process.env.ENVIO_RPC_URL;
  if (!perChainOverride && !legacyGlobal) return null;

  const client = createPublicClient({
    transport: http(fallbackUrl, { batch: true }),
  });
  fallbackRpcClients.set(chainId, client);
  return client;
}

// ---------------------------------------------------------------------------
// Rate limit detection & retry
// ---------------------------------------------------------------------------

/** Matches common rate-limit error messages from RPC providers. */
const RATE_LIMIT_RE =
  /rate limit|request limit reached|too many requests|429|throttl/i;

/** Returns true if the error looks like a rate-limit / 429 response. */
function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RATE_LIMIT_RE.test(err.message);
}

/** Delays for rate-limit retries before falling back. */
const RATE_LIMIT_RETRY_DELAYS_MS = [200, 500, 1000];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RebalancingState = {
  oraclePriceNumerator: bigint;
  oraclePriceDenominator: bigint;
  rebalanceThreshold: number;
  priceDifference: bigint;
};

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Returns SortedOracles address for chainId, throws if not in @mento-protocol/contracts. */
const SORTED_ORACLES_ADDRESS = SortedOraclesContract.address;

/** Per-chain block-scoped caches. Each cache holds entries for the most
 * recently seen block on each chain — when a chain advances to a new block,
 * its prior entries are evicted. Per-chain (rather than global) eviction is
 * required because the multichain configs run with `unordered_multichain_mode:
 * true`, so events from different chains can interleave at independent block
 * heights. Cardinality is bounded by `chains × keys_per_block`.
 *
 * Per-block keying remains correct for historical backfills (e.g. across an
 * oracle governance change): each fetch is keyed by its own blockNumber, so a
 * cached value can never be returned for a different block. */

/** Cache numRates: "chainId:feedId:blockNumber" → count. */
const numReportersCache = new Map<string, number>();
const numReportersCacheLastBlocks = new Map<number, bigint>();

/** Cache report expiry: "chainId:feedId:blockNumber" → expiry seconds. */
const reportExpiryCache = new Map<string, bigint>();
const reportExpiryCacheLastBlocks = new Map<number, bigint>();

/** Cache getReserves(): "chainId:poolAddress:blockNumber" → reserves. */
const reservesCache = new Map<string, { reserve0: bigint; reserve1: bigint }>();
const reservesCacheLastBlocks = new Map<number, bigint>();

/** Evict any entries for the given chain whose block doesn't match `blockNumber`.
 * Caller passes the cache and its per-chain lastBlocks tracker; we delete
 * entries with the `${chainId}:` prefix when the chain has advanced.
 * Exported under `_evictCacheForChain` for unit testing. */
function evictCacheForChain<T>(
  cache: Map<string, T>,
  lastBlocks: Map<number, bigint>,
  chainId: number,
  blockNumber: bigint,
): void {
  if (lastBlocks.get(chainId) === blockNumber) return;
  const prefix = `${chainId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  lastBlocks.set(chainId, blockNumber);
}

/** @internal Test-only: pure helper for unit-testing the eviction logic. */
export const _evictCacheForChain = evictCacheForChain;

/** @internal Test-only: snapshot block-scoped cache sizes for invariant
 * assertions. Caches are bounded by chains × keys-per-block; tests can drive
 * the fetchers across many blocks and assert the size never explodes. */
export function _getOracleCacheStats(): {
  numReporters: number;
  reportExpiry: number;
  reserves: number;
} {
  return {
    numReporters: numReportersCache.size,
    reportExpiry: reportExpiryCache.size,
    reserves: reservesCache.size,
  };
}

// ---------------------------------------------------------------------------
// Block fallback helper
// ---------------------------------------------------------------------------

/** Matches common RPC error messages indicating the requested block is not
 * yet available on the node. Different providers emit different messages:
 * - "block is out of range" (forno.celo.org)
 * - "block number out of range" (some Geth variants)
 * - "header not found" (Erigon, some Geth configurations)
 * - "unknown block" (Nethermind) */
const BLOCK_NOT_AVAILABLE_RE =
  /block is out of range|block number out of range|header not found|unknown block/i;

export type BlockFallbackResult = {
  result: unknown;
  usedFallback: boolean;
};

/** Maximum number of retries with the original blockNumber before falling back
 * to reading "latest". Each retry uses an increasing delay. */
const BLOCK_RETRY_DELAYS_MS = [500, 1000, 2000];

/** @internal Test-only hooks for overriding the delay function. */
export const _testHooks = {
  delayFn: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Wrapper around `client.readContract` that handles two transient failure modes:
 *
 * 1. **Rate limits** — retries with backoff, then falls back to a secondary
 *    (public) RPC client if available.
 * 2. **Block not available** — retries the original block with backoff, then
 *    falls back to reading "latest".
 *
 * Returns `{ result, usedFallback }` so callers can skip block-scoped cache
 * writes when fallback was used.
 */
export async function readContractWithBlockFallback(
  client: ReturnType<typeof createPublicClient>,
  args: Record<string, unknown>,
  blockNumber?: bigint,
  fallbackClient?: ReturnType<typeof createPublicClient> | null,
): Promise<BlockFallbackResult> {
  const makeCall = (c: ReturnType<typeof createPublicClient>, block?: bigint) =>
    c.readContract({
      ...args,
      ...(block !== undefined && { blockNumber: block }),
    } as any);

  const callWithBlock = () => makeCall(client, blockNumber);
  const fn = (args.functionName as string) ?? "unknown";
  const target = (args.address as string) ?? "unknown";

  try {
    const result = await callWithBlock();
    return { result, usedFallback: false };
  } catch (err) {
    // --- Rate limit handling: retry then fall back to secondary RPC ---
    if (isRateLimitError(err)) {
      for (let i = 0; i < RATE_LIMIT_RETRY_DELAYS_MS.length; i++) {
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[i];
        console.debug(
          `[RPC_RATE_LIMIT_RETRY] fn=${fn} target=${target} retry=${i + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length} delay=${delay}ms`,
        );
        await _testHooks.delayFn(delay);
        try {
          const result = await callWithBlock();
          return { result, usedFallback: false };
        } catch (retryErr) {
          if (!isRateLimitError(retryErr)) throw retryErr;
        }
      }
      // Retries exhausted — try fallback client if available.
      if (fallbackClient) {
        console.warn(
          `[RPC_RATE_LIMIT_FALLBACK] fn=${fn} target=${target} — primary rate-limited, using fallback RPC`,
        );
        try {
          const result = await makeCall(fallbackClient, blockNumber);
          return { result, usedFallback: true };
        } catch (fallbackErr) {
          // Fallback also failed — throw the original rate limit error.
          throw err;
        }
      }
      throw err;
    }

    // --- Block-not-available handling: retry then read "latest" ---
    if (
      blockNumber !== undefined &&
      err instanceof Error &&
      BLOCK_NOT_AVAILABLE_RE.test(err.message)
    ) {
      // Retry the original blockNumber a few times with increasing delays —
      // the RPC node may just be slightly behind HyperSync.
      for (let i = 0; i < BLOCK_RETRY_DELAYS_MS.length; i++) {
        const delay = BLOCK_RETRY_DELAYS_MS[i];
        console.warn(
          `[RPC_BLOCK_RETRY] fn=${fn} target=${target} requestedBlock=${blockNumber} retry=${i + 1}/${BLOCK_RETRY_DELAYS_MS.length} delay=${delay}ms`,
        );
        await _testHooks.delayFn(delay);
        try {
          const result = await callWithBlock();
          return { result, usedFallback: false };
        } catch (retryErr) {
          if (
            !(retryErr instanceof Error) ||
            !BLOCK_NOT_AVAILABLE_RE.test(retryErr.message)
          ) {
            throw retryErr;
          }
        }
      }

      // All retries exhausted — fall back to reading latest.
      console.warn(
        `[RPC_BLOCK_FALLBACK] fn=${fn} target=${target} requestedBlock=${blockNumber} — retries exhausted, reading latest instead`,
      );
      const result = await makeCall(client, undefined);
      return { result, usedFallback: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fetch functions
// ---------------------------------------------------------------------------

function parseRebalancingState(result: unknown): RebalancingState {
  const r = result as readonly [
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
    number,
    bigint,
  ];
  return {
    oraclePriceNumerator: r[0],
    oraclePriceDenominator: r[1],
    rebalanceThreshold: Number(r[5]),
    priceDifference: r[6],
  };
}

// Memoize `fetchRebalancingState` per (chainId, addr, blockNumber). FPMM
// emits 2× UR + 1× Rebalanced in the same rebalance tx → without this
// cache each handler re-RPCs for identical block state.
//
// Two important invariants (mirrors `fetchReserves` / `fetchReportExpiry`):
// 1. Only cache `usedFallback=false` results. If the request fell back
//    to `latest` (e.g. requested block not yet available), the response
//    isn't actually scoped to the cache key's blockNumber, so caching
//    it would serve stale-across-block data to later callers.
// 2. Only cache non-null results. A null means the RPC failed; a retry
//    next time is cheaper than serving the failure forever.
const REBALANCING_STATE_CACHE_MAX = 256;
const _rebalancingStateCache = new Map<
  string,
  Promise<RebalancingState | null>
>();

function rebalancingCacheKey(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
): string {
  return `${chainId}:${poolAddress.toLowerCase()}:${blockNumber}`;
}

export async function fetchRebalancingState(
  chainId: number,
  poolAddress: string,
  // `blockNumber` is required so the memoization key is always
  // block-scoped. Previously optional — an undefined caller would have
  // cached a `latest` response under a "latest" key, serving stale state
  // across wall-clock time to later callers.
  blockNumber: bigint,
): Promise<RebalancingState | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRebalancingStates.has(testKey)) {
    return _testRebalancingStates.get(testKey) ?? null;
  }

  const cacheKey = rebalancingCacheKey(chainId, poolAddress, blockNumber);
  const cached = _rebalancingStateCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh LRU position.
    _rebalancingStateCache.delete(cacheKey);
    _rebalancingStateCache.set(cacheKey, cached);
    return cached;
  }

  // Capture usedFallback + null from inside the closure so the outer
  // code can decide whether to cache. Storing the promise (not the
  // resolved value) is critical — concurrent callers share the flight.
  let cachedFallback = false;
  let cachedNull = false;
  const promise = (async (): Promise<RebalancingState | null> => {
    try {
      const client = getRpcClient(chainId);
      const { result, usedFallback } = await readContractWithBlockFallback(
        client,
        {
          address: poolAddress as `0x${string}`,
          abi: FPMM_MINIMAL_ABI,
          functionName: "getRebalancingState",
        },
        blockNumber,
        getFallbackRpcClient(chainId),
      );
      if (usedFallback) cachedFallback = true;
      return parseRebalancingState(result);
    } catch (err) {
      logRpcFailure(
        chainId,
        "getRebalancingState",
        poolAddress,
        err,
        blockNumber,
      );
      cachedNull = true;
      return null;
    }
  })();

  _rebalancingStateCache.set(cacheKey, promise);
  if (_rebalancingStateCache.size > REBALANCING_STATE_CACHE_MAX) {
    const oldestKey = _rebalancingStateCache.keys().next().value;
    if (oldestKey !== undefined) _rebalancingStateCache.delete(oldestKey);
  }
  // After the flight resolves, evict if the response is not a
  // block-scoped hit. In-flight dedup still works (concurrent callers
  // awaited the same promise); only LATER callers need a fresh attempt.
  promise.finally(() => {
    if (cachedFallback || cachedNull) {
      _rebalancingStateCache.delete(cacheKey);
    }
  });
  return promise;
}

/** Test-only cache reset — lets unit tests start from a clean slate. */
export function _resetRebalancingStateCacheForTests(): void {
  _rebalancingStateCache.clear();
}

/**
 * Fetch current on-chain reserves for a pool via getReserves().
 * Returns null on RPC failure so callers preserve stale reserves.
 */
export async function fetchReserves(
  chainId: number,
  poolAddress: string,
  blockNumber?: bigint,
): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
  const testKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testReserves.has(testKey)) {
    const mock = _testReserves.get(testKey);
    return mock === NULL_RESERVES ? null : (mock ?? null);
  }

  if (blockNumber !== undefined) {
    evictCacheForChain(
      reservesCache,
      reservesCacheLastBlocks,
      chainId,
      blockNumber,
    );
  }
  const cacheKey = `${chainId}:${poolAddress.toLowerCase()}:${blockNumber}`;
  const cached = reservesCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const { result, usedFallback } = await readContractWithBlockFallback(
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "getReserves",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    const r = result as readonly [bigint, bigint, bigint];
    const reserves = { reserve0: r[0], reserve1: r[1] };
    if (!usedFallback) {
      reservesCache.set(cacheKey, reserves);
    }
    return reserves;
  } catch (err) {
    logRpcFailure(chainId, "getReserves", poolAddress, err, blockNumber);
    return null;
  }
}

/** Fetch the pool's invertRateFeed flag. Returns false on error (default). */
export async function fetchInvertRateFeed(
  chainId: number,
  poolAddress: string,
): Promise<boolean> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "invertRateFeed",
    });
    return result as boolean;
  } catch (err) {
    logRpcFailure(chainId, "invertRateFeed", poolAddress, err);
    return false;
  }
}

/** Fetch the pool's rebalance threshold using standalone getters that do NOT
 * require the oracle to be live (unlike getRebalancingState which reverts when
 * the oracle is stale). Returns the max of thresholdAbove/thresholdBelow, or 0. */
export async function fetchRebalanceThreshold(
  chainId: number,
  poolAddress: string,
): Promise<number> {
  try {
    const client = getRpcClient(chainId);
    const [above, below] = await Promise.all([
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "rebalanceThresholdAbove",
      }),
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: FPMM_MINIMAL_ABI,
        functionName: "rebalanceThresholdBelow",
      }),
    ]);
    return Math.max(Number(above), Number(below));
  } catch (err) {
    logRpcFailure(chainId, "rebalanceThreshold", poolAddress, err);
    return 0;
  }
}

export async function fetchReferenceRateFeedID(
  chainId: number,
  poolAddress: string,
): Promise<string | null> {
  const mockKey = `${chainId}:${poolAddress.toLowerCase()}`;
  if (_testRateFeedIDs.has(mockKey)) return _testRateFeedIDs.get(mockKey)!;

  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "referenceRateFeedID",
    });
    return (result as string).toLowerCase();
  } catch (err) {
    logRpcFailure(chainId, "referenceRateFeedID", poolAddress, err);
    return null;
  }
}

/** Returns the number of active oracle reporters for the given rateFeedID at
 * the given block, or null on error. Results are cached per block. */
export async function fetchNumReporters(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<number | null> {
  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }

  evictCacheForChain(
    numReportersCache,
    numReportersCacheLastBlocks,
    chainId,
    blockNumber,
  );
  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = numReportersCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = getRpcClient(chainId);
    const { result, usedFallback } = await readContractWithBlockFallback(
      client,
      {
        address,
        abi: SortedOraclesContract.abi,
        functionName: "numRates",
        args: [rateFeedID as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    const value = Number(result);
    if (!usedFallback) {
      numReportersCache.set(cacheKey, value);
    }
    return value;
  } catch (err) {
    logRpcFailure(chainId, "numRates", rateFeedID, err, blockNumber);
    return null;
  }
}

// In-flight dedup for `fetchReportExpiry`. The value-level `reportExpiryCache`
// is populated only AFTER the RPC resolves, so under `Promise.all` fan-out
// (oracle handlers parallelize per pool — pools sharing a feed fire
// identical requests concurrently) every caller misses and re-RPCs. This
// Promise map collapses in-flight requests: concurrent callers share one
// flight, the value cache then absorbs subsequent calls. Entries are
// cleared on resolve (win + loss) so the value cache / retry path
// takes over afterwards.
const _reportExpiryInFlight = new Map<string, Promise<bigint | null>>();

/** Returns the effective oracle report expiry (seconds) for the given rateFeedID.
 * Returns null on RPC/address error so callers can preserve the previous known-good value. */
export async function fetchReportExpiry(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
): Promise<bigint | null> {
  const mockKey = `${chainId}:${rateFeedID.toLowerCase()}`;
  if (_testReportExpiry.has(mockKey)) return _testReportExpiry.get(mockKey)!;

  let address: `0x${string}`;
  try {
    address = SORTED_ORACLES_ADDRESS(chainId);
  } catch {
    return null;
  }

  evictCacheForChain(
    reportExpiryCache,
    reportExpiryCacheLastBlocks,
    chainId,
    blockNumber,
  );
  const cacheKey = `${chainId}:${rateFeedID}:${blockNumber}`;
  const cached = reportExpiryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const inFlight = _reportExpiryInFlight.get(cacheKey);
  if (inFlight !== undefined) return inFlight;

  const promise = (async (): Promise<bigint | null> => {
    try {
      const client = getRpcClient(chainId);
      let usedAnyFallback = false;
      const tokenExpiryRes = await readContractWithBlockFallback(
        client,
        {
          address,
          abi: SortedOraclesContract.abi,
          functionName: "tokenReportExpirySeconds",
          args: [rateFeedID as `0x${string}`],
        },
        blockNumber,
        getFallbackRpcClient(chainId),
      );
      if (tokenExpiryRes.usedFallback) usedAnyFallback = true;
      const tokenExpiry = tokenExpiryRes.result as bigint;
      let expiry: bigint;
      if (tokenExpiry > 0n) {
        expiry = tokenExpiry;
      } else {
        const globalRes = await readContractWithBlockFallback(
          client,
          {
            address,
            abi: SortedOraclesContract.abi,
            functionName: "reportExpirySeconds",
          },
          blockNumber,
          getFallbackRpcClient(chainId),
        );
        if (globalRes.usedFallback) usedAnyFallback = true;
        expiry = globalRes.result as bigint;
      }
      if (expiry <= 0n) return null;
      if (!usedAnyFallback) {
        reportExpiryCache.set(cacheKey, expiry);
      }
      return expiry;
    } catch (err) {
      logRpcFailure(chainId, "reportExpiry", rateFeedID, err, blockNumber);
      return null;
    }
  })();

  _reportExpiryInFlight.set(cacheKey, promise);
  promise.finally(() => {
    _reportExpiryInFlight.delete(cacheKey);
  });
  return promise;
}

/** Test-only: clear the in-flight `fetchReportExpiry` map. */
export function _resetReportExpiryInFlightForTests(): void {
  _reportExpiryInFlight.clear();
}

/** Fetches decimals0() or decimals1() from an FPMM pool — returns the scaling
 *  factor (e.g. 1000000000000000000n for 18dp, 1000000n for 6dp).
 *  Falls back to calling ERC20 decimals() on the token contract if the pool
 *  method fails. */
export async function fetchTokenDecimalsScaling(
  chainId: number,
  poolAddress: string,
  fn: "decimals0" | "decimals1",
  fallbackTokenAddress?: string,
): Promise<bigint | null> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: fn,
    });
    return result as bigint;
  } catch (err) {
    logRpcFailure(chainId, fn, poolAddress, err);
    if (!fallbackTokenAddress) return null;
    const erc20Key = `${chainId}:${fallbackTokenAddress.toLowerCase()}`;
    if (_testERC20Decimals.has(erc20Key)) {
      const d = _testERC20Decimals.get(erc20Key)!;
      return 10n ** BigInt(d);
    }
    try {
      const client = getRpcClient(chainId);
      const d = await client.readContract({
        address: fallbackTokenAddress as `0x${string}`,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      });
      const decimals = Number(d);
      if (decimals < 0 || decimals > 36) return null;
      return 10n ** BigInt(decimals);
    } catch (err) {
      logRpcFailure(chainId, "erc20Decimals", fallbackTokenAddress, err);
      return null;
    }
  }
}

export async function fetchTradingLimits(
  chainId: number,
  poolAddress: string,
  token: string,
  blockNumber?: bigint,
): Promise<TradingLimitData | null> {
  try {
    const client = getRpcClient(chainId);
    const { result: raw } = await readContractWithBlockFallback(
      client,
      {
        address: poolAddress as `0x${string}`,
        abi: FPMM_TRADING_LIMITS_ABI,
        functionName: "getTradingLimits",
        args: [token as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
    );
    const result = raw as unknown as [
      { limit0: bigint; limit1: bigint; decimals: number },
      {
        lastUpdated0: number;
        lastUpdated1: number;
        netflow0: bigint;
        netflow1: bigint;
      },
    ];
    const [config, state] = result;
    return { config, state };
  } catch (err) {
    logRpcFailure(chainId, "getTradingLimits", poolAddress, err, blockNumber);
    return null;
  }
}

/** Fetch lpFee, protocolFee, and rebalanceIncentive from the FPMM contract.
 * All three are uint256 in basis points (e.g. 15 = 0.15%). Returns only the
 * fields whose RPC call succeeded — callers spread the result, so a partial
 * result won't overwrite already-populated fields. Returns null only when
 * every call fails (no progress possible this touch; self-heal retries). */
export async function fetchFees(
  chainId: number,
  poolAddress: string,
): Promise<Partial<{
  lpFee: number;
  protocolFee: number;
  rebalanceReward: number;
}> | null> {
  const client = getRpcClient(chainId);
  const results = await Promise.allSettled([
    client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_FEE_ABI,
      functionName: "lpFee",
    }),
    client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_FEE_ABI,
      functionName: "protocolFee",
    }),
    client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_FEE_ABI,
      functionName: "rebalanceIncentive",
    }),
  ]);
  const [lpFeeR, protocolFeeR, rebalanceRewardR] = results;
  if (
    lpFeeR.status === "rejected" &&
    protocolFeeR.status === "rejected" &&
    rebalanceRewardR.status === "rejected"
  ) {
    logRpcFailure(chainId, "fetchFees", poolAddress, lpFeeR.reason);
    return null;
  }
  const fees: Partial<{
    lpFee: number;
    protocolFee: number;
    rebalanceReward: number;
  }> = {};
  if (lpFeeR.status === "fulfilled") {
    fees.lpFee = Number(lpFeeR.value as bigint);
  }
  if (protocolFeeR.status === "fulfilled") {
    fees.protocolFee = Number(protocolFeeR.value as bigint);
  }
  if (rebalanceRewardR.status === "fulfilled") {
    fees.rebalanceReward = Number(rebalanceRewardR.value as bigint);
  }
  return fees;
}

// ---------------------------------------------------------------------------
// Oracle DB query helpers (used by SortedOracles handlers)
// ---------------------------------------------------------------------------

/** Returns all FPMM pool IDs on the given chain that reference the given rateFeedID.
 * Uses context.Pool.getWhere (DB-backed) so it works correctly in Envio's
 * multi-process hosted environment.
 *
 * NOTE — in-memory chainId filter: Envio's getWhere only supports single-field
 * queries, so there is no compound "referenceRateFeedID + chainId" DB query.
 * We fetch all pools with the matching feedId across all chains and filter
 * locally. This is correct and safe: each oracle feed maps to at most ~4 FPMM
 * pools total across both chains, so the result set is always tiny. Do NOT
 * "simplify" this to a DB query — the API does not support it. */
export async function getPoolsByFeed(
  context: HandlerContext,
  chainId: number,
  rateFeedID: string,
): Promise<string[]> {
  const pools = await context.Pool.getWhere.referenceRateFeedID.eq(rateFeedID);
  return pools.filter((p) => p.chainId === chainId).map((p) => p.id);
}

export async function updatePoolsOracleExpiry(
  context: HandlerContext,
  poolIds: string[],
  oracleExpiry: bigint | null,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  if (oracleExpiry === null || poolIds.length === 0) return;

  for (const poolId of poolIds) {
    const existing = await context.Pool.get(poolId);
    if (!existing || existing.oracleExpiry === oracleExpiry) continue;

    const updatedPool: Pool = {
      ...existing,
      oracleExpiry,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    };
    context.Pool.set(updatedPool);
  }
}

/** Same in-memory filter rationale as getPoolsByFeed above — Envio getWhere is
 * single-field only, so we fetch all pools with a non-empty referenceRateFeedID
 * and filter by chainId locally. Result set is always small. */
export async function getPoolsWithReferenceFeed(
  context: HandlerContext,
  chainId: number,
): Promise<Pool[]> {
  const pools = await context.Pool.getWhere.referenceRateFeedID.gt("");
  return pools.filter((p) => p.chainId === chainId);
}
