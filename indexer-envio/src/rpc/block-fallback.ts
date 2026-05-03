// `readContractWithBlockFallback` — the shared retry/fallback primitive every
// fetcher in rpc.ts wraps `client.readContract` in. Extracted from rpc.ts in
// PR-S7; pinned by blockFallback.test.ts. Two transient-failure modes are
// handled here so individual fetchers don't have to: rate-limit retries
// (with secondary-RPC fallback) and "block not yet on this node" retries
// (with `latest` fallback).

import type { createPublicClient } from "viem";
import {
  RATE_LIMIT_RETRY_DELAYS_MS,
  _resetRpcFailureCounts,
  isRateLimitError,
  logRpcFailure,
} from "./client";

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
    return { result, usedFallback: false, usedLatestFallback: false };
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
          return { result, usedFallback: false, usedLatestFallback: false };
        } catch (retryErr) {
          if (!isRateLimitError(retryErr)) throw retryErr;
        }
      }
      // Retries exhausted — try fallback client if available.
      // Note: fallback client still queries the same `blockNumber`, so the
      // result IS block-scoped. usedLatestFallback stays false.
      if (fallbackClient) {
        console.warn(
          `[RPC_RATE_LIMIT_FALLBACK] fn=${fn} target=${target} — primary rate-limited, using fallback RPC`,
        );
        try {
          const result = await makeCall(fallbackClient, blockNumber);
          return { result, usedFallback: true, usedLatestFallback: false };
        } catch (fallbackErr) {
          // Throw the fallback error (not the primary rate-limit error) so
          // the caller can classify it — e.g. fetchRebalanceIncentiveAtBlock
          // needs to see "returned no data" to stamp the -2 sentinel for
          // older pools without the getter. The rate-limit context is
          // already in the [RPC_RATE_LIMIT_FALLBACK] warning above.
          throw fallbackErr;
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
      console.warn(
        `[RPC_BLOCK_FALLBACK] fn=${fn} target=${target} requestedBlock=${blockNumber} — retries exhausted, reading latest instead`,
      );
      const result = await makeCall(client, undefined);
      return { result, usedFallback: true, usedLatestFallback: true };
    }
    throw err;
  }
}
