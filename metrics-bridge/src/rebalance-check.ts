/**
 * Rebalance feasibility probe — slimmed-down counterpart to
 * `ui-dashboard/src/lib/rebalance-check.ts`.
 *
 * Behaviour: simulate the strategy's `rebalance(pool)` (or `determineAction`
 * for OLS) from `address(0)` and decode the revert into a bounded
 * `(reason_code, reason_message)` pair the alert annotation can render.
 *
 * Reserve-collateral enrichment was removed in PR #238 — the dashboard's
 * pool-detail tooltip still does its own enrichment via direct on-chain
 * reads, but the Slack alert path reads reserve balances out of Aegis's
 * existing `${TOKEN}_balanceOf{owner="Reserve",chain="celo"}` series
 * instead. The in-bridge enrichment that lived here previously was
 * failing in production with `Missing or invalid parameters`, leaving
 * the gauges absent and propagating NoData through the critical
 * deviation-breach rule.
 *
 * Strategy-type detection IS retained — OLS pools route `rebalance` through
 * ERC20 transfers from `msg.sender`, so simulating from `address(0)`
 * reverts inside ERC20 with a meaningless error every time. The dashboard
 * branches on the detected type and uses `determineAction(pool)` (a view-
 * only function that handles the zero-sender path explicitly) for OLS.
 *
 * Canonical ABI + error map live in `@mento-protocol/monitoring-config/rebalance-abi`
 * — both this probe and the dashboard's import the same data so a revert
 * decoded by one always decodes by the other.
 */

import {
  decodeErrorResult,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  parseAbi,
} from "viem";
import {
  STRATEGY_ABI_SOURCES,
  ERROR_MESSAGES,
  HEALTHY_NO_OP_ERRORS,
  type ReasonCode,
  type SyntheticReasonCode,
} from "@mento-protocol/monitoring-config/rebalance-abi";

// Re-export for backwards compatibility — existing callers still import
// `ERROR_MESSAGES` from this module.
export { ERROR_MESSAGES };

/**
 * Strongly-typed strategy ABI. The string sources live in `shared-config/`
 * (single source of truth shared with the dashboard); we hydrate them
 * with viem's `parseAbi` here so the typing flows through.
 */
const STRATEGY_ABI = parseAbi(STRATEGY_ABI_SOURCES);

/**
 * Detection result. Reserve detection still resolves the reserve address
 * (it's a free side-effect of the `reserve()` probe) so the type carries
 * it for any future enrichment branch — currently unused by the probe
 * itself, but documenting the strategy proxy's identity is cheap.
 */
export type DetectedStrategy =
  | { type: "cdp" }
  | { type: "reserve"; reserveAddr: `0x${string}` }
  | { type: "ols" }
  | { type: "unknown" };

export type RebalanceProbeResult =
  | { kind: "ok" } // Probe succeeded — pool is rebalanceable.
  | RebalanceProbeBlocked
  | { kind: "transport_error"; error: string } // RPC down / 401 / timeout.
  | { kind: "skip"; reason: string }; // Detection failed — no metric, no log spam.

/**
 * Detect the liquidity strategy type by probing strategy-specific getters.
 * Mirror of `detectStrategyType` in
 * `ui-dashboard/src/lib/rebalance-check.ts:300`.
 *
 *   1. `getCDPConfig(pool)` → CDP
 *   2. `reserve()` → Reserve (returns the reserve address along with the type)
 *   3. `getPools()` → OLS
 *   4. otherwise → unknown (caller skips, no metric emitted)
 *
 * Only swallows contract-shape reverts ("function not found" on wrong ABI).
 * Transport errors propagate so the caller can log + skip without
 * mistaking an RPC outage for an unidentified strategy.
 *
 * The optional `signal` is forwarded by `probeOne`'s per-probe
 * AbortController so a stuck endpoint can't keep this detection chain
 * alive after the wall-clock timeout has fired — see
 * `metrics-bridge/src/rebalance-probe.ts:probeOne`.
 */
export async function detectStrategyType(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
  signal?: AbortSignal,
): Promise<DetectedStrategy> {
  try {
    await abortable(
      client.readContract({
        address: strategy,
        abi: STRATEGY_ABI,
        functionName: "getCDPConfig",
        args: [pool],
      }),
      signal,
    );
    return { type: "cdp" };
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!isContractRevert(err)) throw err;
  }

  try {
    const reserveAddr = (await abortable(
      client.readContract({
        address: strategy,
        abi: STRATEGY_ABI,
        functionName: "reserve",
      }),
      signal,
    )) as `0x${string}`;
    return { type: "reserve", reserveAddr };
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!isContractRevert(err)) throw err;
  }

  try {
    await abortable(
      client.readContract({
        address: strategy,
        abi: STRATEGY_ABI,
        functionName: "getPools",
      }),
      signal,
    );
    return { type: "ols" };
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!isContractRevert(err)) throw err;
  }

  return { type: "unknown" };
}

/**
 * Simulate the appropriate probe function against the strategy contract and
 * decode the revert. Returns:
 *   - `ok`         — the probe succeeded (no revert). Caller emits no metric.
 *   - `blocked`    — the probe reverted with a known/decodable error.
 *   - `transport_error` — RPC / network failure. Caller emits no metric and
 *                         logs the failure for operator awareness.
 *   - `skip`       — strategy type couldn't be identified (EOA, wrong proxy,
 *                    new strategy class). Caller emits no metric.
 *
 * Probe selection by strategy type:
 *   - CDP / Reserve: simulate `rebalance(pool)` from `address(0)` — these
 *     strategies source tokens from the strategy contract itself, so the
 *     zero-sender simulation is valid.
 *   - OLS: simulate `determineAction(pool)` instead — OLS `rebalance` routes
 *     ERC20 transfers from `msg.sender`, which always reverts inside ERC20
 *     when called with `address(0)`.
 *   - unknown: skip without emitting a metric — better than a misleading
 *     "blocked" annotation in the Slack alert.
 *
 * Healthy no-op codes (pool below threshold) collapse to `ok` so the alert
 * doesn't render "blocked" for a pool that's mid-recovery.
 */
export async function probeRebalance(
  client: PublicClient,
  poolAddress: `0x${string}`,
  strategyAddress: `0x${string}`,
  /**
   * Optional abort signal threaded by the runner (`probeOne` →
   * `runRebalanceProbes`). When the signal aborts, in-flight RPC reads
   * reject with an `AbortError` so the runner can short-circuit the
   * detection / simulation chain instead of holding stale
   * eth_calls past the wall-clock timeout.
   */
  signal?: AbortSignal,
): Promise<RebalanceProbeResult> {
  let detected: DetectedStrategy;
  try {
    detected = await detectStrategyType(
      client,
      strategyAddress,
      poolAddress,
      signal,
    );
  } catch (err: unknown) {
    if (isAbortError(err)) throw err;
    return {
      kind: "transport_error",
      error: extractRawMessage(err) ?? "transport error",
    };
  }

  if (detected.type === "unknown") {
    return {
      kind: "skip",
      reason: "Unable to identify the liquidity strategy type",
    };
  }

  // OLS rebalance() transfers tokens to/from msg.sender, so simulating from
  // address(0) always reverts inside ERC20 — meaningless. Use determineAction
  // (view-only) instead for OLS. CDP/Reserve source tokens from the strategy
  // contract itself, so the rebalance() simulation from address(0) is valid.
  const probeFn = detected.type === "ols" ? "determineAction" : "rebalance";

  try {
    await abortable(
      client.call({
        to: strategyAddress,
        data: encodeFunctionData({
          abi: STRATEGY_ABI,
          functionName: probeFn,
          args: [poolAddress],
        }),
      }),
      signal,
    );
    return { kind: "ok" };
  } catch (err: unknown) {
    if (isAbortError(err)) throw err;
    if (!isContractRevert(err)) {
      return {
        kind: "transport_error",
        error: extractRawMessage(err) ?? "transport error",
      };
    }
    return decodeBlockedRevert(err);
  }
}

/**
 * Diagnostic detail extracted from a decoded revert that's useful for
 * operator log spelunking but MUST NOT enter the Prometheus label set.
 *
 * Why this is a separate channel from `reason_message`:
 *   - Cardinality: `reason_message` is bounded to the `ERROR_MESSAGES` enum
 *     (~30 values) so Prometheus series count stays bounded across revert
 *     types. Embedding contract-supplied strings / panic codes / raw hex
 *     would let an attacker (or a buggy strategy) explode the label space.
 *   - Slack injection: the `reason_message` label is rendered into the
 *     Slack alert body as mrkdwn. A non-canonical strategy contract could
 *     return an `Error(string)` revert containing `*bold*` / `<url|text>` /
 *     newlines and pollute the alert. Operators see only enum-derived
 *     strings; the raw payload lives in Cloud Run logs.
 *
 * Caller contract: pass `diagnostic` to `console.warn` keyed on the pool
 * + chain so the on-call operator can correlate the bounded label with
 * the unbounded payload when investigating.
 */
export type RebalanceProbeBlocked = {
  kind: "blocked";
  /**
   * Either a canonical Solidity-error name from `ERROR_MESSAGES`
   * (`ReasonCode`) or one of the synthetic kinds emitted for built-in
   * Solidity reverts and unrecognised payloads (`Error` / `Panic` /
   * `unknown`). The discriminated union prevents typos in downstream
   * comparisons — see `REASON_CODES.*` for callable references.
   */
  reasonCode: ReasonCode | SyntheticReasonCode;
  reasonMessage: string;
  /** Unbounded operator detail — log-only, never label. */
  diagnostic?: string;
};

function decodeBlockedRevert(err: unknown): RebalanceProbeResult {
  const revertData = extractRevertData(err);
  if (!revertData) {
    return {
      kind: "blocked",
      reasonCode: "unknown",
      reasonMessage: "Rebalance reverted with an unknown error",
    };
  }

  let errorName: string;
  let errorArgs: readonly unknown[] | undefined;
  try {
    const decoded = decodeErrorResult({ abi: STRATEGY_ABI, data: revertData });
    errorName = decoded.errorName;
    errorArgs = decoded.args;
  } catch {
    // Don't embed the raw hex in `reason_message` — that's an unbounded
    // label-cardinality explosion AND a Slack injection vector. The
    // truncated payload is logged via `diagnostic` for operator spelunking.
    return {
      kind: "blocked",
      reasonCode: "unknown",
      reasonMessage: "Unknown revert",
      diagnostic: `unrecognised revert payload ${truncateHex(revertData)}`,
    };
  }

  // A healthy pool's strategy refused to rebalance — collapse to ok so the
  // alert doesn't paint a deceptive "blocked" line.
  if (HEALTHY_NO_OP_ERRORS.has(errorName)) {
    return { kind: "ok" };
  }

  // Built-in Solidity reverts (Error / Panic) don't carry meaningful names.
  // We DO NOT embed the contract-supplied string (Error) or the panic code
  // (Panic) into `reason_message`:
  //   - Cardinality: would defeat the bounded-enum promise (~30 values).
  //   - Slack injection: a non-canonical strategy could return
  //     `Error("*pwned* <https://evil/|click>")` and pollute the alert body.
  // The raw payload is logged via `diagnostic` so operators investigating
  // a "Reverted with revert string" alert can find it in Cloud Run logs.
  if (errorName === "Error" && typeof errorArgs?.[0] === "string") {
    return {
      kind: "blocked",
      reasonCode: "Error",
      reasonMessage: "Reverted with revert string",
      diagnostic: `Error(string) payload: ${truncateString(errorArgs[0])}`,
    };
  }
  if (errorName === "Panic" && typeof errorArgs?.[0] === "bigint") {
    return {
      kind: "blocked",
      reasonCode: "Panic",
      reasonMessage: "Solidity panic",
      diagnostic: `Panic code 0x${errorArgs[0].toString(16)}`,
    };
  }

  // Canonical strategy ABI errors land here. `errorName` came out of
  // `decodeErrorResult({ abi: STRATEGY_ABI })`, so any name viem accepted
  // is one we authored in `STRATEGY_ABI_SOURCES` — those names are exactly
  // the keys of `ERROR_MESSAGES`. The cast surfaces that invariant to the
  // type system; the lookup-or-fallback covers the unlikely diff between
  // ABI list and message map.
  if (errorName in ERROR_MESSAGES) {
    const code = errorName as ReasonCode;
    return {
      kind: "blocked",
      reasonCode: code,
      reasonMessage: ERROR_MESSAGES[code],
    };
  }
  return {
    kind: "blocked",
    reasonCode: "unknown",
    reasonMessage: `Rebalance reverted: ${errorName}`,
    diagnostic: `unmapped error name ${truncateString(errorName, 60)}`,
  };
}

/**
 * Race a viem RPC promise against an abort signal. When the signal fires,
 * the wrapper rejects with the signal's `reason` (an `AbortError`-shaped
 * `Error` we construct in `probeOne`) so the awaiter can short-circuit
 * the detection / simulation / enrichment chain instead of holding stale
 * eth_calls past the wall-clock timeout.
 *
 * Note: viem 2.47.0 doesn't accept a per-call `signal` on `client.call` /
 * `client.readContract` (the http transport accepts `fetchOptions.signal`
 * only at transport-creation time, not per call). The orphaned fetch
 * itself can't be cancelled mid-flight, but the JS-visible promise
 * rejects immediately so the runner stops awaiting it. Once viem adds
 * native per-call signal support this wrapper can be retired in favour
 * of plumbing `signal` directly into the action options.
 */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(
    typeof reason === "string" ? reason : "operation was aborted",
  );
  err.name = "AbortError";
  return err;
}

/**
 * Detect an abort-error thrown by `abortable` (or by Node's built-in
 * abort plumbing). Used in `detectStrategyType` / `probeRebalance` so
 * abort signals propagate cleanly past the contract-revert classifier
 * (which would otherwise misinterpret them as transport errors).
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

/**
 * Heuristic: contract reverts contain revert data or "execution reverted" /
 * "returned no data" in the message. Transport errors (fetch failures, 401,
 * timeouts) do not match either branch.
 *
 * Mirror of the dashboard's `isContractRevert` (`rebalance-check.ts:432`) so
 * both probes classify the same way.
 */
function isContractRevert(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (extractRevertData(err)) return true;
  const msg = (err as { message?: string }).message ?? "";
  return /revert|returned no data/i.test(msg);
}

function extractRevertData(err: unknown): Hex | null {
  if (err && typeof err === "object") {
    let current: Record<string, unknown> = err as Record<string, unknown>;
    for (let i = 0; i < 5; i++) {
      if (typeof current.data === "string" && current.data.startsWith("0x")) {
        return current.data as Hex;
      }
      if (
        current.data &&
        typeof current.data === "object" &&
        typeof (current.data as Record<string, unknown>).data === "string"
      ) {
        const nested = (current.data as Record<string, unknown>).data as string;
        if (nested.startsWith("0x")) return nested as Hex;
      }
      if (current.cause && typeof current.cause === "object") {
        current = current.cause as Record<string, unknown>;
      } else {
        break;
      }
    }
  }
  return null;
}

function extractRawMessage(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  // viem transport errors routinely embed the failing URL ("HTTP request
  // failed. URL: https://eth-mainnet.g.alchemy.com/v2/<APIKEY>..."), so
  // operators on Alchemy / Infura / any path-based-auth RPC would have
  // their API keys leaked into Cloud Run logs on every transport failure.
  // The chain id is logged separately by the caller, so swapping the URL
  // for a marker is no loss of operator signal.
  return scrubUrls(raw).slice(0, 200);
}

/**
 * Replace any http(s) URL substring with `<rpc-url-redacted>`. Used to
 * sanitise error messages before logging — viem error messages routinely
 * embed the failing RPC URL, which on path-based-auth endpoints (Alchemy,
 * Infura, etc.) is itself the API credential. Exported for unit tests.
 */
export function scrubUrls(s: string): string {
  return s.replace(/https?:\/\/[^\s)]+/gi, "<rpc-url-redacted>");
}

/** Cap diagnostic-channel strings before they hit Cloud Run logs. */
function truncateString(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function truncateHex(hex: Hex, max = 18): string {
  return hex.length > max ? `${hex.slice(0, max - 1)}…` : hex;
}
