// `readContractWithBlockFallback` — the shared retry/fallback primitive every
// fetcher in rpc.ts wraps `client.readContract` in. Two transient-failure
// modes are handled here so individual fetchers don't have to: rate-limit
// retries (with secondary-RPC fallback) and "block not yet on this node"
// retries (with `latest` fallback).

import type { createPublicClient } from "viem";
import {
  RATE_LIMIT_RETRY_DELAYS_MS,
  _resetRpcFailureCounts,
  fallbackLikelyHasBlock,
  isRateLimitError,
  logRpcFailure,
  recordFallbackArchiveMiss,
  sanitizeErrorMessage,
} from "./client";
import { consoleLogger, type RpcLogger } from "./log";

/** Matches common RPC error messages indicating the requested block is not
 * yet available on the node. Different providers emit different messages:
 * - "block is out of range" (forno.celo.org)
 * - "block number out of range" (some Geth variants)
 * - "header not found" (Erigon, some Geth configurations)
 * - "unknown block" (Nethermind)
 * - "block requested not found" (some providers, when used WITHOUT the
 *   "querying historical state" qualifier — bare phrasing tends to mean
 *   transient lag rather than archive depth). When the same string co-
 *   occurs with "querying historical state" we treat it as archive-depth
 *   instead via ARCHIVE_DEPTH_RE; the dispatcher checks ARCHIVE_DEPTH_RE
 *   first and never falls through to here for that combined phrasing. */
const BLOCK_NOT_AVAILABLE_RE =
  /block is out of range|block number out of range|header not found|unknown block|block requested not found/i;

/** Matches RPC error messages indicating the node lacks archive depth back
 * to the requested block — *the contract IS deployed there, the node just
 * doesn't have state pruned that far back*.
 *
 * Provider-specific phrasings:
 * - QuickNode: `"Block requested not found. Request might be querying
 *   historical state that is not available."` — match on `querying
 *   historical state`.
 * - QuickNode (alternate): `"Invalid parameters were provided to the RPC
 *   method. Double check you have provided the correct parameters."` — fires
 *   when the requested block is below the pruning window. Match the full
 *   two-sentence form so unrelated "Invalid parameters" errors (malformed
 *   address, wrong ABI selector, future provider-specific tweaks) don't
 *   trigger archive-depth handling and poison the runtime horizon.
 *
 * The bare `Block requested not found` phrase by itself can also mean
 * "transient lag — node hasn't seen this block yet" on some providers,
 * which is recoverable via the BLOCK_NOT_AVAILABLE_RE retry path; mis-
 * classifying it as archive-depth would skip those retries.
 *
 * Distinct from BLOCK_NOT_AVAILABLE_RE: archive-depth failures are
 * recoverable only via a deeper-archive secondary at the SAME block.
 * Reading `latest` is NOT a valid recovery — the result wouldn't be
 * scoped to the requested block, and several callers consume `result`
 * directly without checking `usedLatestFallback`, so silently swapping
 * in current-block data would corrupt historical entity state. The
 * archive-depth branch is therefore fail-closed: secondary failure or no
 * fallback throws, callers' existing try/catch returns null, indexer
 * preserves the prior known-good value (or schema default) until the
 * indexer reaches a block whose state the primary can serve. */
const ARCHIVE_DEPTH_RE =
  /querying historical state|Invalid parameters were provided to the RPC method\. Double check you have provided the correct parameters/i;

export type BlockFallbackResult = {
  result: unknown;
  /** True when the result came from anywhere other than the primary client at
   *  the requested block — i.e. either the secondary RPC client (rate-limit
   *  fallback) OR the `latest`-block fallback. Use this to skip block-scoped
   *  cache writes that could serve stale-across-fallbacks data. */
  usedFallback: boolean;
  /** True ONLY when the function fell back to reading `latest` instead of the
   *  requested block. The result is NOT scoped to `blockNumber`. Callers that
   *  need historical accuracy (rebalance delta computation, block-scoped event
   *  snapshots) must reject these results. False when `blockNumber` was not
   *  passed (caller didn't request a specific block) or when the fallback was
   *  to the secondary RPC client at the same requested block. */
  usedLatestFallback: boolean;
};

/** Maximum number of retries with the original blockNumber before falling back
 * to reading "latest". Each retry uses an increasing delay. */
const BLOCK_RETRY_DELAYS_MS = [500, 1000, 2000];

/** @internal Test-only hooks for overriding the delay function and exposing
 *  internal helpers (rate-limit classifier, structured failure logger, and
 *  the burst-counter reset) so unit tests can pin their behaviour without
 *  re-publishing them as part of the module's public API. */
export const _testHooks = {
  delayFn: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  isRateLimitError: (err: unknown): boolean => isRateLimitError(err),
  logRpcFailure: (
    chainId: number,
    fn: string,
    target: string,
    err: unknown,
    block?: bigint,
  ): void => logRpcFailure(chainId, fn, target, err, block),
  resetRpcFailureCounts: (): void => {
    _resetRpcFailureCounts();
  },
};

/**
 * Wrapper around `client.readContract` that handles two transient failure modes:
 *
 * 1. **Rate limits** — retries with backoff, then falls back to a secondary
 *    (public) RPC client if available.
 * 2. **Block not available** — retries the original block with backoff, then
 *    falls back to reading "latest".
 *
 * Returns `{ result, usedFallback, usedLatestFallback }`. Callers should skip
 * block-scoped cache writes when `usedFallback` is true, and additionally
 * reject the result for historical accuracy when `usedLatestFallback` is true
 * (the read returned `latest` instead of the requested block).
 */
export async function readContractWithBlockFallback(
  chainId: number,
  client: ReturnType<typeof createPublicClient>,
  args: Record<string, unknown>,
  blockNumber?: bigint,
  fallbackClient?: ReturnType<typeof createPublicClient> | null,
  log: RpcLogger = consoleLogger,
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
    return { result, usedFallback: false, usedLatestFallback: false };
  } catch (initialErr) {
    // `currentError` may be reassigned during the rate-limit retry loop if
    // a retry surfaces a non-rate-limit error (e.g. archive-depth — primary
    // recovered from rate-limit but the requested block isn't in its
    // archive). Letting the retry-surfaced error fall through to the
    // archive-depth / block-not-available branches below means we still
    // get the same-block secondary fallback for those.
    let currentError: unknown = initialErr;

    // --- Rate limit handling: retry then fall back to secondary RPC ---
    if (isRateLimitError(currentError)) {
      let exitedWithRateLimit = true;
      for (let i = 0; i < RATE_LIMIT_RETRY_DELAYS_MS.length; i++) {
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[i];
        log.debug(
          `[RPC_RATE_LIMIT_RETRY] fn=${fn} target=${target} retry=${i + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length} delay=${delay}ms`,
        );
        await _testHooks.delayFn(delay);
        try {
          const result = await callWithBlock();
          return { result, usedFallback: false, usedLatestFallback: false };
        } catch (retryErr) {
          if (!isRateLimitError(retryErr)) {
            // Archive-depth error surfaced after the rate-limit cleared:
            // route to the archive-depth branch below so the same-block
            // secondary fallback IS consulted (otherwise the call would
            // bubble straight to the caller with no recovery attempt).
            //
            // BLOCK_NOT_AVAILABLE-style errors from a retry are NOT
            // routed through — they'd hit the retry-then-`latest` path,
            // and several historical callers (fetchNumReporters,
            // fetchReportExpiry, fetchTradingLimits) destructure `result`
            // without checking `usedLatestFallback`, so silently swapping
            // in current-block data after a 429-then-block-miss would
            // corrupt their entity state. Throwing matches pre-PR
            // behaviour for the same retry-surfaced shape.
            if (
              retryErr instanceof Error &&
              ARCHIVE_DEPTH_RE.test(retryErr.message)
            ) {
              currentError = retryErr;
              exitedWithRateLimit = false;
              break;
            }
            throw retryErr;
          }
        }
      }
      if (exitedWithRateLimit) {
        // Retries exhausted with rate-limit still in place — try fallback
        // client at the same block IF the fallback's known archive horizon
        // covers it. Otherwise, throw the rate-limit error directly: a call
        // to a fallback we know lacks the block would just surface a
        // confusing archive-miss error masking the underlying rate-limit
        // cause, and waste a round trip we already know will fail.
        if (fallbackClient && fallbackLikelyHasBlock(chainId, blockNumber)) {
          log.warn(
            `[RPC_RATE_LIMIT_FALLBACK] fn=${fn} target=${target} — primary rate-limited, using fallback RPC`,
          );
          try {
            const result = await makeCall(fallbackClient, blockNumber);
            return { result, usedFallback: true, usedLatestFallback: false };
          } catch (fallbackErr) {
            // Fallback failed. If it's an archive-depth miss, record it so
            // future rate-limit fallbacks for older blocks on this chain
            // skip the secondary entirely.
            if (
              blockNumber !== undefined &&
              fallbackErr instanceof Error &&
              ARCHIVE_DEPTH_RE.test(fallbackErr.message)
            ) {
              recordFallbackArchiveMiss(chainId, blockNumber);
            }
            // Throw the fallback error (not the primary rate-limit error)
            // so the caller can classify it — e.g.
            // fetchRebalanceIncentiveAtBlock needs to see "returned no
            // data" to stamp the -2 sentinel for older pools without the
            // getter. The rate-limit context is already in the
            // [RPC_RATE_LIMIT_FALLBACK] warning above.
            throw fallbackErr;
          }
        }
        throw currentError;
      }
      // Otherwise: a non-rate-limit error surfaced from the retry. Fall
      // through to the archive-depth / block-not-available branches with
      // currentError set to the retry-surfaced error.
    }

    // --- Archive-depth handling: try the secondary RPC at the SAME block,
    // fail-closed otherwise.
    //
    // The primary's state is pruned past this block. The secondary may
    // have deeper archive coverage — try it at the requested block.
    // Observed in production: Monad mainnet's quiknode default has shallow
    // archive that fails ~5M blocks behind head, while `rpc2.monad.xyz`
    // (the hardcoded fallback) returns real data at the same blocks.
    //
    // If the secondary also fails (or no secondary is configured), THROW.
    // We must NOT fall through to `latest` here: many call sites — e.g.
    // fetchBreakerList, fetchReportExpiry, fetchTradingLimits in
    // src/rpc/{breakers,pool-state}.ts — destructure `result` directly
    // without checking `usedLatestFallback`, so silently swapping in
    // current-block data would corrupt historical entity state. Throwing
    // is the same behaviour those callers had before this PR (their
    // try/catch returns null), so fail-closed is the safe default.
    if (
      blockNumber !== undefined &&
      currentError instanceof Error &&
      ARCHIVE_DEPTH_RE.test(currentError.message)
    ) {
      if (fallbackClient) {
        log.warn(
          `[RPC_ARCHIVE_FALLBACK] fn=${fn} target=${target} requestedBlock=${blockNumber} — primary lacks archive depth, using fallback RPC`,
        );
        try {
          const result = await makeCall(fallbackClient, blockNumber);
          // Successful block-scoped read via the secondary —
          // usedLatestFallback stays false because the requested block
          // was honoured.
          return { result, usedFallback: true, usedLatestFallback: false };
        } catch (fallbackErr) {
          // Secondary also failed (rate-limit, deeper-archive miss,
          // contract-not-deployed-at-this-block, or some other transient).
          // If it's an archive-depth miss, learn the secondary's horizon
          // so future rate-limit fallbacks skip the secondary at deeper
          // blocks instead of surfacing a confusing "Invalid parameters"
          // error.
          if (
            fallbackErr instanceof Error &&
            ARCHIVE_DEPTH_RE.test(fallbackErr.message)
          ) {
            recordFallbackArchiveMiss(chainId, blockNumber);
          }
          // Throw the secondary's error so callers can classify it
          // correctly — e.g. fetchRebalanceIncentiveAtBlock needs to see
          // "returned no data" to stamp the -2 sentinel for older pools
          // without the getter.
          const secondaryMsg = sanitizeErrorMessage(
            fallbackErr instanceof Error
              ? fallbackErr.message
              : String(fallbackErr),
          );
          log.warn(
            `[RPC_ARCHIVE_FALLBACK_FAILED] fn=${fn} target=${target} requestedBlock=${blockNumber} secondaryErr="${secondaryMsg}" — propagating to caller`,
          );
          throw fallbackErr;
        }
      }
      // No fallback configured — primary's archive depth is our only
      // option, and it failed. Throw the original error so callers
      // degrade to null cleanly (matches pre-PR behaviour for this path).
      throw currentError;
    }

    // --- Block-not-available handling: retry then read "latest" ---
    // The primary may simply be slightly behind HyperSync (race between
    // chain head propagation and the RPC's view). Retries help here in a
    // way they don't for archive-depth.
    if (
      blockNumber !== undefined &&
      currentError instanceof Error &&
      BLOCK_NOT_AVAILABLE_RE.test(currentError.message)
    ) {
      // Retry the original blockNumber a few times with increasing delays —
      // the RPC node may just be slightly behind HyperSync.
      for (let i = 0; i < BLOCK_RETRY_DELAYS_MS.length; i++) {
        const delay = BLOCK_RETRY_DELAYS_MS[i];
        log.warn(
          `[RPC_BLOCK_RETRY] fn=${fn} target=${target} requestedBlock=${blockNumber} retry=${i + 1}/${BLOCK_RETRY_DELAYS_MS.length} delay=${delay}ms`,
        );
        await _testHooks.delayFn(delay);
        try {
          const result = await callWithBlock();
          return { result, usedFallback: false, usedLatestFallback: false };
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
      log.warn(
        `[RPC_BLOCK_FALLBACK] fn=${fn} target=${target} requestedBlock=${blockNumber} — retries exhausted, reading latest instead`,
      );
      const result = await makeCall(client, undefined);
      return { result, usedFallback: true, usedLatestFallback: true };
    }
    throw currentError;
  }
}
