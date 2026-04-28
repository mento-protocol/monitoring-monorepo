/**
 * Rebalance feasibility probe — slimmed-down counterpart to
 * `ui-dashboard/src/lib/rebalance-check.ts`.
 *
 * Behaviour mirrors the dashboard's probe with one exception: only the
 * Reserve-strategy enrichment is fetched (collateral balance + amount
 * needed). The Slack alert renders that pair inline as
 * "Reserve has insufficient axlUSDC. Current balance: X / Needed: Y" so
 * operators don't have to click through for the most-common diagnostic.
 * CDP / OLS / unknown branches stay annotation-light — operators click
 * through to the dashboard for those.
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
import { tokenSymbol } from "@mento-protocol/monitoring-config/tokens";

// Re-export for backwards compatibility — existing callers still import
// `ERROR_MESSAGES` from this module.
export { ERROR_MESSAGES };

/**
 * ERC20 + pool getters used by the reserve-enrichment fetch. Kept inline
 * (not in `shared-config/`) because they're standard interfaces that don't
 * need cross-package coordination — the strategy ABI is the only thing
 * with a real drift risk and lives there.
 */
const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
]);
const POOL_TOKEN_ABI = parseAbi([
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
]);

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
  /**
   * Chain id is only used for token-symbol resolution during reserve
   * enrichment (`RLS_RESERVE_OUT_OF_COLLATERAL`). Optional so existing
   * tests that don't exercise the enrichment branch keep working — the
   * enrichment call paths through `tokenSymbol(chainId, address)` which
   * tolerates the fallback to "collateral" when no chain is provided.
   */
  chainId?: number,
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
    const decoded = decodeBlockedRevert(err);

    // Reserve-strategy enrichment: when the breach is "reserve out of
    // collateral", fetch the on-chain balance + needed amount so the Slack
    // alert can render "Reserve has insufficient axlUSDC. Current balance:
    // 0 axlUSDC / Needed for rebalancing: 12,500 axlUSDC". Skipped for any
    // other strategy or reason code so the alert annotation falls through
    // to the bounded `reason_message` enum unchanged.
    if (
      decoded.kind === "blocked" &&
      strategyType === "reserve" &&
      decoded.reasonCode === "RLS_RESERVE_OUT_OF_COLLATERAL"
    ) {
      const enrichment = await fetchReserveEnrichment(
        client,
        strategyAddress,
        poolAddress,
        chainId ?? 0,
      );
      if (enrichment) {
        return {
          ...decoded,
          // Override the bounded enum's "Reserve has insufficient collateral
          // to rebalance" with the symbol-specific variant. Cardinality
          // stays bounded by the token list (~10 symbols across the index)
          // and the Slack-injection invariant holds because `tokenSymbol`
          // returns canonicalised names from `@mento-protocol/contracts` —
          // never user/contract input.
          reasonMessage: `Reserve has insufficient ${enrichment.tokenSymbol}`,
          reserveCollateral: enrichment,
        };
      }
      // Enrichment fetch failed (transport error inside reserve()/balanceOf
      // /etc.). Fall through to the generic decoded result so the alert
      // still gets the bounded reason message and the breach itself isn't
      // suppressed.
    }
    return decoded;
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
  /**
   * Reserve-strategy enrichment: current collateral balance held by the
   * reserve and the amount required to close the breach. Populated only
   * when `reasonCode === "RLS_RESERVE_OUT_OF_COLLATERAL"` AND the on-chain
   * fetches succeed. Drives the two `mento_pool_rebalance_collateral_*`
   * gauges (and through them the Slack alert annotation).
   *
   * Skipped (left undefined) for non-reserve strategies and for transport
   * errors during enrichment — the alert annotation falls through to the
   * generic `reason_message` in either case.
   */
  reserveCollateral?: {
    /** Reserve's current ERC20 balance of the collateral token (human units). */
    balance: number;
    /** Strategy's required transfer to close the breach (human units). */
    needed: number;
    /** Token symbol for the alert annotation. Falls back to "collateral". */
    tokenSymbol: string;
  };
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

/**
 * Convert a raw on-chain uint256 balance to a human-units number without
 * losing precision when the raw value exceeds 2^53. Mirror of
 * `ui-dashboard/src/lib/rebalance-check.ts:toHumanUnits` — keeps the two
 * probes' enrichment math identical so a balance reported by the alert
 * annotation matches what the dashboard tooltip shows.
 */
export function toHumanUnits(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = raw / divisor;
  const fractionScale = BigInt(1_000_000);
  const fraction = ((raw % divisor) * fractionScale) / divisor;
  return Number(whole) + Number(fraction) / Number(fractionScale);
}

/**
 * Reserve-strategy enrichment fetch — mirrors the dashboard's
 * `fetchReserveEnrichment` but pulls the "needed" amount straight off
 * `determineAction(pool).action.amountOwedToPool` (the strategy's required
 * transfer to close the breach). Returns `null` on any RPC failure so the
 * caller can fall back to the generic reason message without the gauges
 * landing in Prometheus.
 *
 * Token symbol resolution flows through `tokenSymbol` from
 * `@mento-protocol/monitoring-config/tokens` — same source as the existing
 * `reserve_share_token0/1` `token_symbol` labels, so the alert annotation
 * stays consistent across surfaces. Falls back to "collateral" when the
 * contract address isn't in `@mento-protocol/contracts` (matches the
 * existing fallback semantics for unknown tokens).
 */
async function fetchReserveEnrichment(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
  chainId: number,
): Promise<{ balance: number; needed: number; tokenSymbol: string } | null> {
  try {
    // 1. reserve() — the address holding the collateral.
    const reserveAddr = (await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "reserve",
    })) as `0x${string}`;

    // 2. determineAction(pool) — gives us the action's `amountOwedToPool`
    //    (the required transfer to close the breach) plus the ctx, which
    //    tells us which leg of the pool is the debt token.
    const [ctx, action] = (await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "determineAction",
      args: [pool],
    })) as readonly [{ isToken0Debt: boolean }, { amountOwedToPool: bigint }];

    // 3. The collateral token is the non-debt leg of the pool.
    const [token0, token1] = await Promise.all([
      client.readContract({
        address: pool,
        abi: POOL_TOKEN_ABI,
        functionName: "token0",
      }),
      client.readContract({
        address: pool,
        abi: POOL_TOKEN_ABI,
        functionName: "token1",
      }),
    ]);
    const collateralToken = (
      ctx.isToken0Debt ? token1 : token0
    ) as `0x${string}`;

    // 4. balanceOf + decimals on the collateral token.
    const [balance, decimals] = await Promise.all([
      client.readContract({
        address: collateralToken,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [reserveAddr],
      }),
      client.readContract({
        address: collateralToken,
        abi: ERC20_BALANCE_ABI,
        functionName: "decimals",
      }),
    ]);

    const decimalsNum = Number(decimals);
    return {
      balance: toHumanUnits(balance as bigint, decimalsNum),
      needed: toHumanUnits(action.amountOwedToPool, decimalsNum),
      tokenSymbol: tokenSymbol(chainId, collateralToken) ?? "collateral",
    };
  } catch {
    return null;
  }
}
