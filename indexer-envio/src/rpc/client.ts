// RPC client management, structured failure logging, and rate-limit
// detection. Extracted from rpc.ts in PR-S6; pinned by rpcClient.test.ts +
// hyperRpcToken.test.ts. The internal helpers (`isRateLimitError`,
// `logRpcFailure`, `_resetRpcFailureCounts`, `RATE_LIMIT_RETRY_DELAYS_MS`)
// are imported by rpc.ts for use by its remaining fetchers and the
// `_testHooks` proxy.

import { createPublicClient, http } from "viem";

import { consoleLogger, type RpcLogger } from "./log.js";

// ---------------------------------------------------------------------------
// RPC failure logging
// ---------------------------------------------------------------------------

/** How many failures of the same (chainId, fn) to accumulate before emitting
 * an additional [RPC_FAILURE_BURST] summary line. Individual failures are
 * always logged; the burst line is the "pattern detected" signal for monitoring. */
const RPC_BURST_INTERVAL = 10;

/** Monotonically increasing failure count per `chainId:fn` key. */
const _rpcFailureCounts = new Map<string, number>();

/** @internal Test-only: reset the burst-counter map between tests. */
export function _resetRpcFailureCounts(): void {
  _rpcFailureCounts.clear();
}

/** Strip URLs from RPC error messages so tokenized endpoints (HyperRPC,
 * quiknode, Alchemy) don't leak credentials into logs. Exported so
 * `block-fallback.ts` can sanitize secondary-RPC errors before logging
 * them in the archive-fallback diagnostic warning. */
export function sanitizeErrorMessage(msg: string): string {
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
  // Observed in Monad mainnet `getRebalancingState` reverts. Not in 4byte
  // and not matched against any common Mento error variant we tried.
  // Tagged here so it routes to debug instead of warn until someone with
  // the contract source labels it correctly.
  "0xeb0d3e81":
    "Unknown stale-state revert — observed on Monad getRebalancingState; treated as expected",
};

/** Extract a 4-byte revert selector from an error message, if present. */
function extractRevertSignature(msg: string): string | undefined {
  const match = msg.match(/reverted with the following signature:\s*$/m);
  if (match) {
    const sigMatch = msg.match(/\b(0x[0-9a-f]{8})\b/i);
    return sigMatch?.[1]?.toLowerCase();
  }
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
export function logRpcFailure(
  chainId: number,
  fn: string,
  target: string,
  err: unknown,
  block?: bigint,
  log: RpcLogger = consoleLogger,
): void {
  const message =
    err instanceof Error
      ? sanitizeErrorMessage(err.message)
      : typeof err === "string"
        ? sanitizeErrorMessage(err)
        : "unknown error";
  const blockStr = block !== undefined ? ` block=${block}` : "";

  const revertSig = extractRevertSignature(message);
  const knownRevert = revertSig
    ? KNOWN_REVERT_SIGNATURES[revertSig]
    : undefined;

  if (knownRevert) {
    log.debug(
      `[CONTRACT_REVERT] chainId=${chainId} fn=${fn} target=${target}${blockStr} — ${knownRevert}`,
    );
  } else {
    log.warn(
      `[RPC_FAILURE] chainId=${chainId} fn=${fn} target=${target}${blockStr} error=${message}`,
    );
  }

  const burstKey = `${chainId}:${fn}`;
  const count = (_rpcFailureCounts.get(burstKey) ?? 0) + 1;
  _rpcFailureCounts.set(burstKey, count);
  if (count % RPC_BURST_INTERVAL === 0) {
    const tag = knownRevert ? "CONTRACT_REVERT_BURST" : "RPC_FAILURE_BURST";
    log.warn(`[${tag}] chainId=${chainId} fn=${fn} failureCount=${count}`);
  }
}

// ---------------------------------------------------------------------------
// RPC client management
// ---------------------------------------------------------------------------

const rpcClients = new Map<number, ReturnType<typeof createPublicClient>>();
// Stores `null` explicitly when no fallback applies for a chain — `has()`
// then short-circuits the env-var + URL recomputation on every call.
const fallbackRpcClients = new Map<
  number,
  ReturnType<typeof createPublicClient> | null
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

// Per-chain RPC config for contract reads (eth_call). Defaults MUST be
// full-node RPCs — Envio HyperRPC does NOT support eth_call. (Envio's own
// event syncing uses HyperSync, configured in the YAML files.)
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
 * 3. Hardcoded default in RPC_CONFIG_BY_CHAIN.
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
          `Add an entry to RPC_CONFIG_BY_CHAIN in rpc/client.ts.`,
      );
    }
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
 * Returns a fallback viem public client for the given chainId, or null when
 * no useful fallback is available.
 *
 * Resolution:
 * 1. `ENVIO_RPC_FALLBACK_URL_{chainId}` — explicit per-chain fallback
 *    override. Use this when the primary you want to swap to (via
 *    `ENVIO_RPC_URL_{chainId}` unset → hardcoded default) doesn't already
 *    cover both backfill and live: e.g. set primary to `rpc2.monad.xyz`
 *    (deeper archive) and fallback to a tokenized QuickNode URL (higher
 *    rate limit at head).
 * 2. Hardcoded default in RPC_CONFIG_BY_CHAIN — used when the primary is
 *    set via env-var override and the default is a different URL.
 *
 * Returns null when the resolved fallback URL equals the primary URL (no
 * point falling back to the same endpoint), or when the resolved URL is a
 * bare HyperRPC endpoint (HyperRPC doesn't support eth_call).
 */
export function getFallbackRpcClient(
  chainId: number,
): ReturnType<typeof createPublicClient> | null {
  if (fallbackRpcClients.has(chainId)) {
    return fallbackRpcClients.get(chainId)!;
  }
  const config = RPC_CONFIG_BY_CHAIN[chainId];
  if (!config) {
    fallbackRpcClients.set(chainId, null);
    return null;
  }

  // Treat empty-string env var as unset. Hosted secret platforms sometimes
  // surface a blank value when an env var is created but not yet filled in;
  // an empty URL would crash `createPublicClient({ transport: http("") })`
  // with `UrlRequiredError` and silently disable the fallback path.
  const fallbackOverrideRaw = process.env[`ENVIO_RPC_FALLBACK_URL_${chainId}`];
  const fallbackOverride =
    fallbackOverrideRaw && fallbackOverrideRaw.length > 0
      ? fallbackOverrideRaw
      : undefined;
  const fallbackRawUrl = fallbackOverride ?? config.default;
  const fallbackUrl = withHyperRpcToken(fallbackRawUrl);
  if (isBareHyperRpcUrl(fallbackUrl)) {
    fallbackRpcClients.set(chainId, null);
    return null;
  }

  // Use truthiness (||), not nullish coalescing (??), so empty-string env
  // vars fall through to the next source — matching getRpcClient's `if
  // (perChainOverride)` resolution. Mismatched semantics here would let a
  // blank ENVIO_RPC_URL_<chainId> resolve `primaryUrl=""` while the actual
  // primary uses `config.default`, causing the `sameUrl` check below to
  // miss and produce a self-referencing fallback client.
  const primaryRawUrl =
    process.env[config.envVar] || process.env.ENVIO_RPC_URL || config.default;
  const primaryUrl = withHyperRpcToken(primaryRawUrl);
  if (sameUrl(fallbackUrl, primaryUrl)) {
    fallbackRpcClients.set(chainId, null);
    return null;
  }

  const client = createPublicClient({
    transport: http(fallbackUrl, { batch: true }),
  });
  fallbackRpcClients.set(chainId, client);
  return client;
}

/** Compare two URLs by their normalized `URL.href`, so e.g.
 * `"https://rpc2.monad.xyz"` and `"https://rpc2.monad.xyz/"` (with vs without
 * trailing slash) collapse to equal — which keeps `getFallbackRpcClient` from
 * spinning up a self-referencing fallback when the user types one variant in
 * the env var and the hardcoded default uses the other. Falls back to raw
 * string equality if either input fails to parse. */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

// ---------------------------------------------------------------------------
// Fallback archive-depth tracking
// ---------------------------------------------------------------------------

/** Per-chain deepest blockNumber where the fallback RPC has been seen to fail
 *  with archive-depth or invalid-block errors. Subsequent rate-limit fallback
 *  attempts skip the secondary when the requested block is older than this
 *  threshold — pointless to send the call, and worse, it surfaces a confusing
 *  "Invalid parameters" error that masks the underlying rate-limit cause.
 *
 *  This learns the fallback's archive horizon at runtime instead of
 *  requiring per-chain config. Reset by the test hook below. */
const _fallbackKnownArchiveDepth = new Map<number, bigint>();

/** @internal Test-only: clear the learned per-chain archive horizons. */
export function _resetFallbackArchiveDepth(): void {
  _fallbackKnownArchiveDepth.clear();
}

/** Record that the fallback RPC for `chainId` lacks archive coverage at
 *  `blockNumber`. Bumps the per-chain threshold to the deepest known miss. */
export function recordFallbackArchiveMiss(
  chainId: number,
  blockNumber: bigint,
): void {
  const existing = _fallbackKnownArchiveDepth.get(chainId);
  if (existing === undefined || blockNumber > existing) {
    _fallbackKnownArchiveDepth.set(chainId, blockNumber);
  }
}

/** True when the fallback RPC for `chainId` is likely to have archive
 *  coverage for `blockNumber` — i.e. `blockNumber` is strictly newer than
 *  the deepest miss we've recorded. With no recorded miss, returns true.
 *
 *  Block-scoped callers use this to skip the rate-limit fallback when the
 *  secondary's archive window definitely doesn't cover the requested block,
 *  preventing the rate-limit-then-archive-miss leak the `block-fallback`
 *  comment block describes. */
export function fallbackLikelyHasBlock(
  chainId: number,
  blockNumber: bigint | undefined,
): boolean {
  if (blockNumber === undefined) return true;
  const knownMissBlock = _fallbackKnownArchiveDepth.get(chainId);
  if (knownMissBlock === undefined) return true;
  return blockNumber > knownMissBlock;
}

// ---------------------------------------------------------------------------
// Rate limit detection & retry
// ---------------------------------------------------------------------------

/** Matches common rate-limit error messages from RPC providers.
 *
 * Provider-specific phrasings observed in production:
 * - QuickNode (Celo): `request limit reached`, `125/second request limit reached`
 * - rpc2.monad.xyz: `Request exceeds defined limit.`
 * - Generic / RFC 6585: `429`, `too many requests`, `throttled`
 *
 * Add new provider phrasings here when they show up in `[RPC_FAILURE]`
 * lines that should have been retried + faled-over instead. Without a
 * match, the rate-limit retry/fallback path in `block-fallback.ts` is
 * skipped and the error escapes to the caller (visible as a viem stack
 * trace dump in the logs). */
const RATE_LIMIT_RE =
  /rate limit|request limit reached|exceeds defined limit|too many requests|429|throttl/i;

/** Returns true if the error looks like a rate-limit / 429 response. */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RATE_LIMIT_RE.test(err.message);
}

/** Delays for rate-limit retries before falling back. */
export const RATE_LIMIT_RETRY_DELAYS_MS = [200, 500, 1000];
