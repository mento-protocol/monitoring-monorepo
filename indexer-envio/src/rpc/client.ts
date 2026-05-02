// RPC client management, structured failure logging, and rate-limit
// detection. Extracted from rpc.ts in PR-S6; pinned by rpcClient.test.ts +
// hyperRpcToken.test.ts. The internal helpers (`isRateLimitError`,
// `logRpcFailure`, `_rpcFailureCounts`, `RATE_LIMIT_RETRY_DELAYS_MS`) are
// re-exported back through rpc.ts so the remaining fetchers + the
// `_testHooks` proxy continue to work without touching every caller.

import { createPublicClient, http } from "viem";

// ---------------------------------------------------------------------------
// RPC failure logging
// ---------------------------------------------------------------------------

/** How many failures of the same (chainId, fn) to accumulate before emitting
 * an additional [RPC_FAILURE_BURST] summary line. Individual failures are
 * always logged; the burst line is the "pattern detected" signal for monitoring. */
const RPC_BURST_INTERVAL = 10;

/** Monotonically increasing failure count per `chainId:fn` key. */
export const _rpcFailureCounts = new Map<string, number>();

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
): void {
  const message =
    err instanceof Error
      ? sanitizeErrorMessage(err.message)
      : String(err ?? "unknown error");
  const blockStr = block !== undefined ? ` block=${block}` : "";

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
// RPC client management
// ---------------------------------------------------------------------------

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
 * Returns a fallback viem public client for the given chainId.
 * Uses the hardcoded default RPC (public endpoint) — only created when the
 * primary client is a different URL (env-var override). Returns null if the
 * primary already IS the default (no point falling back to the same endpoint).
 */
export function getFallbackRpcClient(
  chainId: number,
): ReturnType<typeof createPublicClient> | null {
  if (fallbackRpcClients.has(chainId)) {
    return fallbackRpcClients.get(chainId) ?? null;
  }
  const config = RPC_CONFIG_BY_CHAIN[chainId];
  if (!config) return null;

  const fallbackUrl = withHyperRpcToken(config.default);
  if (isBareHyperRpcUrl(fallbackUrl)) return null;

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
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RATE_LIMIT_RE.test(err.message);
}

/** Delays for rate-limit retries before falling back. */
export const RATE_LIMIT_RETRY_DELAYS_MS = [200, 500, 1000];
