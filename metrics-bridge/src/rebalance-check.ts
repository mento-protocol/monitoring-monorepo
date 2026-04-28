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
  REASON_CODES,
  type ReasonCode,
  type SyntheticReasonCode,
} from "@mento-protocol/monitoring-config/rebalance-abi";
import {
  ERC20_ABI_SOURCES,
  POOL_PAIR_ABI_SOURCES,
} from "@mento-protocol/monitoring-config/erc20-abi";
import {
  tokenDecimals,
  tokenSymbol,
} from "@mento-protocol/monitoring-config/tokens";
import { toHumanUnits } from "@mento-protocol/monitoring-config/units";

// Re-export so existing callers (and the dashboard's mirror, prior to its
// own migration) keep importing from one canonical location.
export { toHumanUnits };

// Re-export for backwards compatibility — existing callers still import
// `ERROR_MESSAGES` from this module.
export { ERROR_MESSAGES };

/**
 * ERC20 + pool getters used by the reserve-enrichment fetch. Sources live
 * in `@mento-protocol/monitoring-config/erc20-abi` (shared with the
 * dashboard's pool-detail probe) so a future ABI tweak doesn't have to
 * be made in two places.
 */
const ERC20_BALANCE_ABI = parseAbi(ERC20_ABI_SOURCES);
const POOL_TOKEN_ABI = parseAbi(POOL_PAIR_ABI_SOURCES);

/**
 * Strongly-typed strategy ABI. The string sources live in `shared-config/`
 * (single source of truth shared with the dashboard); we hydrate them
 * with viem's `parseAbi` here so the typing flows through.
 */
const STRATEGY_ABI = parseAbi(STRATEGY_ABI_SOURCES);

/**
 * Detection result. The `reserve` variant carries the resolved reserve
 * address so downstream enrichment can skip a redundant `reserve()` call —
 * we already paid for it during detection, the address is part of the
 * Reserve strategy's identity, and it doesn't change between blocks.
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
 */
export async function detectStrategyType(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<DetectedStrategy> {
  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getCDPConfig",
      args: [pool],
    });
    return { type: "cdp" };
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  try {
    const reserveAddr = (await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "reserve",
    })) as `0x${string}`;
    return { type: "reserve", reserveAddr };
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getPools",
    });
    return { type: "ols" };
  } catch (err) {
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
   * Chain id forwarded to `tokenSymbol(chainId, address)` during reserve
   * enrichment (`RLS_RESERVE_OUT_OF_COLLATERAL`). Tests that don't exercise
   * the enrichment branch can pass `0` — `tokenSymbol` tolerates an unknown
   * chain and falls back to "collateral".
   */
  chainId: number,
): Promise<RebalanceProbeResult> {
  let detected: DetectedStrategy;
  try {
    detected = await detectStrategyType(client, strategyAddress, poolAddress);
  } catch (err: unknown) {
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
      detected.type === "reserve" &&
      decoded.reasonCode === REASON_CODES.RLS_RESERVE_OUT_OF_COLLATERAL
    ) {
      const enrichment = await fetchReserveEnrichment(
        client,
        strategyAddress,
        poolAddress,
        chainId,
        detected.reserveAddr,
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
      // Enrichment fetch failed (transport error inside balanceOf / decimals
      // / etc.). Fall through to the generic decoded result so the alert
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
 * Process-lifetime decimals cache for tokens whose `decimals()` we had to
 * read on-chain (i.e. addresses missing from `@mento-protocol/contracts`).
 * Decimals are immutable per contract, so once we know them they can never
 * change — the cache lives until the bridge process restarts.
 *
 * For canonical Mento tokens (~10 stablecoin / FX symbols) the cache is
 * never even consulted: `tokenDecimals(chainId, addr)` resolves from the
 * contracts manifest first, no RPC at all. Exposed for unit testing.
 */
const decimalsCache = new Map<string, number>();

/** Visible-for-testing: clear the on-chain decimals cache. */
export function _clearDecimalsCache(): void {
  decimalsCache.clear();
}

/**
 * Resolve ERC20 decimals for `(chainId, address)`. Tries the canonical
 * `@mento-protocol/contracts` manifest first (zero RPC cost), then the
 * process-lifetime cache, then falls back to a single on-chain
 * `decimals()` read. Throws if the RPC call fails — callers that want
 * graceful degradation should wrap in a try/catch.
 */
async function resolveDecimals(
  client: PublicClient,
  chainId: number,
  address: `0x${string}`,
): Promise<number> {
  const canonical = tokenDecimals(chainId, address);
  if (canonical !== null) return canonical;
  const key = `${chainId}:${address.toLowerCase()}`;
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const decimals = (await client.readContract({
    address,
    abi: ERC20_BALANCE_ABI,
    functionName: "decimals",
  })) as number;
  const decimalsNum = Number(decimals);
  decimalsCache.set(key, decimalsNum);
  return decimalsNum;
}

/**
 * Reserve-strategy enrichment fetch — mirrors the dashboard's
 * `fetchReserveEnrichment` but pulls the "needed" amount straight off
 * `determineAction(pool).action.amountOwedToPool` (the strategy's required
 * transfer to close the breach). Returns `null` on any RPC failure so the
 * caller can fall back to the generic reason message without the gauges
 * landing in Prometheus.
 *
 * The reserve address is threaded in from the upstream `detectStrategyType`
 * call (Reserve detection itself reads `reserve()`, and the address is
 * stable for a given strategy proxy), saving one RPC round-trip per probe.
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
  reserveAddr: `0x${string}`,
): Promise<{ balance: number; needed: number; tokenSymbol: string } | null> {
  try {
    // 1. determineAction(pool) — gives us the action's `amountOwedToPool`
    //    (the required transfer to close the breach) plus the ctx, which
    //    tells us which leg of the pool is the debt token. Issued in
    //    parallel with the pool's token0/token1 reads since neither
    //    dependency-graphs into the other.
    const [[ctx, action], token0, token1] = (await Promise.all([
      client.readContract({
        address: strategy,
        abi: STRATEGY_ABI,
        functionName: "determineAction",
        args: [pool],
      }),
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
    ])) as [
      readonly [{ isToken0Debt: boolean }, { amountOwedToPool: bigint }],
      `0x${string}`,
      `0x${string}`,
    ];

    // 2. The collateral token is the non-debt leg of the pool.
    const collateralToken = ctx.isToken0Debt ? token1 : token0;

    // 3. balanceOf + decimals on the collateral token. Decimals come from
    //    the canonical manifest (zero RPC) or the process-lifetime cache
    //    when available; only an unknown contract will fall through to an
    //    on-chain read. balanceOf is always read fresh.
    const [balance, decimalsNum] = await Promise.all([
      client.readContract({
        address: collateralToken,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [reserveAddr],
      }),
      resolveDecimals(client, chainId, collateralToken),
    ]);

    return {
      balance: toHumanUnits(balance as bigint, decimalsNum),
      needed: toHumanUnits(action.amountOwedToPool, decimalsNum),
      tokenSymbol: tokenSymbol(chainId, collateralToken) ?? "collateral",
    };
  } catch {
    return null;
  }
}
