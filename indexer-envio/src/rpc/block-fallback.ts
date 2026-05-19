// `readContractWithBlockFallback` — the shared retry/fallback primitive every
// fetcher in rpc.ts wraps `client.readContract` in. Two transient-failure
// modes are handled here so individual fetchers don't have to: rate-limit
// retries (with secondary-RPC fallback) and "block not yet on this node"
// retries (with a same-block secondary attempt before `latest` fallback).

import type { createPublicClient, ReadContractParameters } from "viem";
import {
  RATE_LIMIT_RETRY_DELAYS_MS,
  _resetRpcFailureCounts,
  describeKnownRevert,
  fallbackLikelyHasBlock,
  isRateLimitError,
  logRpcFailure,
  recordFallbackArchiveMiss,
  sanitizeErrorMessage,
} from "./client.js";
import { consoleLogger, type RpcLogger } from "./log.js";

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
   *  the requested block — i.e. either the secondary RPC client at the same
   *  block OR the `latest`-block fallback. Use this to skip block-scoped
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

type PublicClient = ReturnType<typeof createPublicClient>;
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

type MakeCall = (c: PublicClient, block?: bigint) => Promise<unknown>;

type RecoveryDeps = {
  chainId: number;
  client: PublicClient;
  fallbackClient: PublicClient | null | undefined;
  makeCall: MakeCall;
  callWithBlock: () => Promise<unknown>;
  blockNumber: bigint | undefined;
  fn: string;
  target: string;
  log: RpcLogger;
};

/**
 * Wrapper around `client.readContract` that handles two transient failure modes:
 *
 * 1. **Rate limits** — retries with backoff, then falls back to a secondary
 *    (public) RPC client if available.
 * 2. **Block not available** — retries the original block with backoff, then
 *    tries the secondary RPC at the same block before falling back to "latest".
 *
 * Returns `{ result, usedFallback, usedLatestFallback }`. Callers should skip
 * block-scoped cache writes when `usedFallback` is true, and additionally
 * reject the result for historical accuracy when `usedLatestFallback` is true
 * (the read returned `latest` instead of the requested block).
 */
export async function readContractWithBlockFallback(
  chainId: number,
  client: PublicClient,
  args: Record<string, unknown>,
  blockNumber?: bigint,
  fallbackClient?: PublicClient | null,
  log: RpcLogger = consoleLogger,
): Promise<BlockFallbackResult> {
  const makeCall: MakeCall = (c, block) =>
    c.readContract({
      ...args,
      ...(block !== undefined && { blockNumber: block }),
    } as ReadContractParameters);
  const callWithBlock = () => makeCall(client, blockNumber);
  const fn = (args.functionName as string) ?? "unknown";
  const target = (args.address as string) ?? "unknown";

  try {
    const result = await callWithBlock();
    return { result, usedFallback: false, usedLatestFallback: false };
  } catch (initialErr) {
    const deps: RecoveryDeps = {
      chainId,
      client,
      fallbackClient,
      makeCall,
      callWithBlock,
      blockNumber,
      fn,
      target,
      log,
    };
    let currentError: unknown = initialErr;
    if (isRateLimitError(currentError)) {
      const outcome = await attemptRateLimitRecovery(deps, currentError);
      if (outcome.kind === "result") return outcome.value;
      // fallthrough: archive-depth surfaced from a retry — try archive branch
      currentError = outcome.error;
    }
    if (isArchiveDepthErr(currentError, blockNumber)) {
      return await attemptArchiveDepthSecondary(deps, currentError);
    }
    if (isBlockNotAvailableErr(currentError, blockNumber)) {
      return await attemptBlockNotAvailableRecovery(deps);
    }
    throw currentError;
  }
}

function isArchiveDepthErr(
  err: unknown,
  blockNumber: bigint | undefined,
): err is Error {
  return (
    blockNumber !== undefined &&
    err instanceof Error &&
    ARCHIVE_DEPTH_RE.test(err.message)
  );
}

function isBlockNotAvailableErr(
  err: unknown,
  blockNumber: bigint | undefined,
): err is Error {
  return (
    blockNumber !== undefined &&
    err instanceof Error &&
    BLOCK_NOT_AVAILABLE_RE.test(err.message)
  );
}

/** Rate-limit retry can finish in three states: a recovered result, a non-rate-limit
 *  archive-depth error that should re-enter the archive-depth branch, or a thrown
 *  error (handled by caller). */
type RateLimitOutcome =
  | { kind: "result"; value: BlockFallbackResult }
  | { kind: "fallthrough"; error: unknown };

/** Retry the original call against the primary until rate-limit clears. If a
 *  retry surfaces an archive-depth error (primary recovered from 429 but lacks
 *  archive depth for the requested block), return `fallthrough` so the
 *  dispatcher consults the archive-depth secondary path. BLOCK_NOT_AVAILABLE
 *  errors surfaced from a retry are thrown instead — silently swapping in
 *  `latest` after a 429-then-block-miss would corrupt historical entity state
 *  for callers that destructure `result` without checking `usedLatestFallback`. */
async function retryThroughRateLimit(
  deps: RecoveryDeps,
  initialError: unknown,
): Promise<RateLimitOutcome | { kind: "exhausted"; error: unknown }> {
  const { callWithBlock, fn, target, log } = deps;
  let surfacedError: unknown = initialError;
  for (let i = 0; i < RATE_LIMIT_RETRY_DELAYS_MS.length; i++) {
    const delay = RATE_LIMIT_RETRY_DELAYS_MS[i] ?? 0;
    log.debug(
      `[RPC_RATE_LIMIT_RETRY] fn=${fn} target=${target} retry=${i + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length} delay=${delay}ms`,
    );
    await _testHooks.delayFn(delay);
    try {
      const result = await callWithBlock();
      return {
        kind: "result",
        value: { result, usedFallback: false, usedLatestFallback: false },
      };
    } catch (retryErr) {
      if (isRateLimitError(retryErr)) {
        surfacedError = retryErr;
        continue;
      }
      if (
        retryErr instanceof Error &&
        ARCHIVE_DEPTH_RE.test(retryErr.message)
      ) {
        return { kind: "fallthrough", error: retryErr };
      }
      throw retryErr;
    }
  }
  return { kind: "exhausted", error: surfacedError };
}

/** Rate-limit dispatcher: drive retries, then attempt the secondary RPC at the
 *  same block when the fallback's known horizon covers it. Returns a result if
 *  one of those succeeded, or `fallthrough` so the dispatcher reconsiders the
 *  current error against the archive-depth branch. */
async function attemptRateLimitRecovery(
  deps: RecoveryDeps,
  initialError: unknown,
): Promise<RateLimitOutcome> {
  const { chainId, makeCall, fallbackClient, blockNumber, fn, target, log } =
    deps;
  const retried = await retryThroughRateLimit(deps, initialError);
  if (retried.kind === "result" || retried.kind === "fallthrough") {
    return retried;
  }
  // Retries exhausted with rate-limit still in place — try the secondary IF
  // its archive horizon covers the requested block. A call to a fallback we
  // know lacks the block would just surface a confusing archive-miss error
  // masking the rate-limit cause, and waste a round trip.
  if (fallbackClient && fallbackLikelyHasBlock(chainId, blockNumber)) {
    log.warn(
      `[RPC_RATE_LIMIT_FALLBACK] fn=${fn} target=${target} — primary rate-limited, using fallback RPC`,
    );
    try {
      const result = await makeCall(fallbackClient, blockNumber);
      return {
        kind: "result",
        value: { result, usedFallback: true, usedLatestFallback: false },
      };
    } catch (fallbackErr) {
      if (
        blockNumber !== undefined &&
        isArchiveDepthErr(fallbackErr, blockNumber)
      ) {
        recordFallbackArchiveMiss(chainId, blockNumber);
      }
      // Throw the fallback error so the caller can classify it — e.g.
      // fetchRebalanceIncentiveAtBlock needs to see "returned no data" to
      // stamp the -2 sentinel for older pools without the getter.
      throw fallbackErr;
    }
  }
  throw retried.error;
}

/** Try the secondary RPC at the SAME block when the primary lacks archive
 *  depth. Fail-closed: if the secondary also fails (or no secondary is
 *  configured), throw. We never fall through to `latest` here — many callers
 *  consume `result` directly without checking `usedLatestFallback`, so
 *  silently swapping in current-block data would corrupt historical entity
 *  state. */
async function attemptArchiveDepthSecondary(
  deps: RecoveryDeps,
  currentError: unknown,
): Promise<BlockFallbackResult> {
  const { chainId, makeCall, fallbackClient, blockNumber, fn, target, log } =
    deps;
  if (blockNumber === undefined || !fallbackClient) {
    throw currentError;
  }
  try {
    const result = await makeCall(fallbackClient, blockNumber);
    const primaryMsg = sanitizeErrorMessage(
      currentError instanceof Error
        ? currentError.message
        : String(currentError),
    );
    log.debug(
      `[RPC_ARCHIVE_FALLBACK] fn=${fn} target=${target} requestedBlock=${blockNumber} primaryErr="${primaryMsg}" — primary lacks archive depth, used fallback RPC`,
    );
    return { result, usedFallback: true, usedLatestFallback: false };
  } catch (fallbackErr) {
    if (
      fallbackErr instanceof Error &&
      ARCHIVE_DEPTH_RE.test(fallbackErr.message)
    ) {
      recordFallbackArchiveMiss(chainId, blockNumber);
    }
    logArchiveFallbackError({
      log,
      fn,
      target,
      blockNumber,
      err: fallbackErr,
    });
    throw fallbackErr;
  }
}

/** Retry the primary at the same block (covering chain-head-propagation lag),
 *  then try the secondary at the same block, then fall back to reading
 *  `latest`. usedLatestFallback=true is set on the final fallback so callers
 *  that need historical accuracy can reject the result. */
async function attemptBlockNotAvailableRecovery(
  deps: RecoveryDeps,
): Promise<BlockFallbackResult> {
  const {
    chainId,
    client,
    callWithBlock,
    makeCall,
    fallbackClient,
    blockNumber,
    fn,
    target,
    log,
  } = deps;
  if (blockNumber === undefined) {
    throw new Error("attemptBlockNotAvailableRecovery: blockNumber required");
  }
  for (let i = 0; i < BLOCK_RETRY_DELAYS_MS.length; i++) {
    const delay = BLOCK_RETRY_DELAYS_MS[i] ?? 0;
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
  // Retries exhausted. Try the secondary at the same block before falling
  // back to `latest`: it preserves the requested block-scope for callers
  // that reject usedLatestFallback.
  if (fallbackClient && fallbackLikelyHasBlock(chainId, blockNumber)) {
    log.warn(
      `[RPC_BLOCK_SECONDARY_FALLBACK] fn=${fn} target=${target} requestedBlock=${blockNumber} — primary block retries exhausted, trying fallback RPC at same block`,
    );
    try {
      const result = await makeCall(fallbackClient, blockNumber);
      return { result, usedFallback: true, usedLatestFallback: false };
    } catch (fallbackErr) {
      if (isArchiveDepthErr(fallbackErr, blockNumber)) {
        recordFallbackArchiveMiss(chainId, blockNumber);
      }
      const secondaryMsg = sanitizeErrorMessage(
        fallbackErr instanceof Error
          ? fallbackErr.message
          : String(fallbackErr),
      );
      log.warn(
        `[RPC_BLOCK_SECONDARY_FALLBACK_FAILED] fn=${fn} target=${target} requestedBlock=${blockNumber} secondaryErr="${secondaryMsg}" — falling back to latest`,
      );
    }
  }
  log.warn(
    `[RPC_BLOCK_FALLBACK] fn=${fn} target=${target} requestedBlock=${blockNumber} — retries exhausted, reading latest instead`,
  );
  const result = await makeCall(client, undefined);
  return { result, usedFallback: true, usedLatestFallback: true };
}

function logArchiveFallbackError({
  log,
  fn,
  target,
  blockNumber,
  err,
}: {
  log: RpcLogger;
  fn: string;
  target: string;
  blockNumber: bigint;
  err: unknown;
}): void {
  const secondaryMsg = sanitizeErrorMessage(
    err instanceof Error ? err.message : String(err),
  );
  const knownRevert = describeKnownRevert(secondaryMsg);

  if (knownRevert) {
    log.debug(
      `[CONTRACT_REVERT] fn=${fn} target=${target} requestedBlock=${blockNumber} via archive fallback — ${knownRevert}`,
    );
    return;
  }

  log.warn(
    `[RPC_ARCHIVE_FALLBACK_FAILED] fn=${fn} target=${target} requestedBlock=${blockNumber} secondaryErr="${secondaryMsg}" — propagating to caller`,
  );
}
