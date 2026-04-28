/**
 * Rebalance feasibility probe — slimmed-down counterpart to
 * `ui-dashboard/src/lib/rebalance-check.ts`.
 *
 * The dashboard runs a richer probe with collateral/balance enrichment for
 * the pool-detail page tooltip. The Slack alert annotation only needs the
 * error code + bounded human-readable message, so this module drops the
 * enrichment fetches (operators click through to the dashboard for that).
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

export type StrategyType = "cdp" | "reserve" | "ols" | "unknown";

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
 *   2. `reserve()` → Reserve
 *   3. `getPools()` → OLS
 *   4. otherwise → unknown (caller skips, no metric emitted)
 *
 * Only swallows contract-shape reverts ("function not found" on wrong ABI).
 * Transport errors propagate so the caller can log + skip without
 * mistaking an RPC outage for an unidentified strategy.
 */
export async function detectStrategyType(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<StrategyType> {
  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getCDPConfig",
      args: [pool],
    });
    return "cdp";
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "reserve",
    });
    return "reserve";
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getPools",
    });
    return "ols";
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  return "unknown";
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
): Promise<RebalanceProbeResult> {
  let strategyType: StrategyType;
  try {
    strategyType = await detectStrategyType(
      client,
      strategyAddress,
      poolAddress,
    );
  } catch (err: unknown) {
    return {
      kind: "transport_error",
      error: extractRawMessage(err) ?? "transport error",
    };
  }

  if (strategyType === "unknown") {
    return {
      kind: "skip",
      reason: "Unable to identify the liquidity strategy type",
    };
  }

  // OLS rebalance() transfers tokens to/from msg.sender, so simulating from
  // address(0) always reverts inside ERC20 — meaningless. Use determineAction
  // (view-only) instead for OLS. CDP/Reserve source tokens from the strategy
  // contract itself, so the rebalance() simulation from address(0) is valid.
  const probeFn = strategyType === "ols" ? "determineAction" : "rebalance";

  try {
    await client.call({
      to: strategyAddress,
      data: encodeFunctionData({
        abi: STRATEGY_ABI,
        functionName: probeFn,
        args: [poolAddress],
      }),
    });
    return { kind: "ok" };
  } catch (err: unknown) {
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
  reasonCode: string;
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

  return {
    kind: "blocked",
    reasonCode: errorName,
    reasonMessage:
      ERROR_MESSAGES[errorName] ?? `Rebalance reverted: ${errorName}`,
  };
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
