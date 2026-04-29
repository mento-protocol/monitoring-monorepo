/**
 * Reserve-strategy enrichment helper — shared by the dashboard's pool-detail
 * tooltip and the metrics-bridge Slack-alert probe. Both consumers walk the
 * same chain (`reserve()` → debt-leg lookup → `balanceOf` + `decimals` on
 * collateral); the only consumer-specific concerns are:
 *
 *   - WHERE the debt-leg flag comes from. Bridge reads `determineAction(pool)`
 *     to also recover `amountOwedToPool` (the strategy's required transfer to
 *     close the breach); dashboard reads `poolConfigs(pool)` and skips the
 *     needed-amount lookup. Encoded by `mode: "needed" | "balance-only"`.
 *   - WHAT the symbol resolver looks like. Bridge calls
 *     `tokenSymbol(chainId, addr)` from the canonical manifest; dashboard
 *     reads `symbol()` on-chain. Encoded by an injected `resolveSymbol`
 *     callback.
 *   - HOW decimals get resolved. Bridge memoizes via the canonical manifest
 *     plus a process-lifetime cache; dashboard reads `decimals()` on-chain.
 *     Encoded by an injected `resolveDecimals` callback.
 *
 * shared-config stays viem-free: the consumer passes an opaque
 * `EnrichmentRpc` shape (just the `readContract` calls we need) so the
 * function compiles without depending on viem's `PublicClient`.
 */

import { ERC20_ABI_SOURCES, POOL_PAIR_ABI_SOURCES } from "./erc20-abi.js";
import { STRATEGY_ABI_SOURCES } from "./rebalance-abi.js";
import { toHumanUnits } from "./units.js";

/**
 * Re-export the source ABI strings so consumers don't have to thread two
 * imports together to call `parseAbi(...)` on the same fragments. Keeping
 * the strings (not parsed ABIs) keeps shared-config viem-free.
 */
export { ERC20_ABI_SOURCES, POOL_PAIR_ABI_SOURCES, STRATEGY_ABI_SOURCES };

/**
 * Minimal RPC surface the enrichment fetch needs. The four dispatchers
 * mirror viem's `client.readContract` shape (per-callsite ABI / function
 * name / args / return type) so consumers can adapt their viem client with
 * a single thin wrapper. See `metrics-bridge/src/rebalance-check.ts` and
 * `ui-dashboard/src/lib/rebalance-check.ts` for the call shape.
 *
 * Each dispatcher accepts an optional `signal: AbortSignal`. When present
 * and aborted, the dispatcher MUST reject promptly so the caller's await
 * unblocks (the underlying viem `client.readContract` doesn't natively
 * accept a per-call signal in viem 2.47.0, so consumers wrap each call in
 * a `Promise.race`-style abort guard — see metrics-bridge's `abortable`
 * helper). This lets the metrics-bridge probe runner cancel an outlived
 * cycle's enrichment fetches without leaking RPC calls.
 */
export interface EnrichmentRpc {
  /** Read `determineAction(pool)` — used in `mode: "needed"`. */
  readDetermineAction(args: {
    strategy: `0x${string}`;
    pool: `0x${string}`;
    signal?: AbortSignal;
  }): Promise<{ isToken0Debt: boolean; amountOwedToPool: bigint }>;
  /** Read `poolConfigs(pool)` — used in `mode: "balance-only"`. */
  readPoolConfigs(args: {
    strategy: `0x${string}`;
    pool: `0x${string}`;
    signal?: AbortSignal;
  }): Promise<{ isToken0Debt: boolean }>;
  /** Read pool's `token0()` and `token1()` in parallel. */
  readPoolTokens(
    pool: `0x${string}`,
    signal?: AbortSignal,
  ): Promise<{ token0: `0x${string}`; token1: `0x${string}` }>;
  /** Read `balanceOf(holder)` against an ERC20. */
  readBalanceOf(args: {
    token: `0x${string}`;
    holder: `0x${string}`;
    signal?: AbortSignal;
  }): Promise<bigint>;
}

export interface EnrichmentOptions {
  chainId: number;
  /**
   * Reserve address — bridge threads this in from the upstream detection
   * call (Reserve detection itself reads `reserve()`, so it's free), saving
   * one RPC per probe. Dashboard reads it on-demand and passes the resolved
   * value here.
   */
  reserveAddr: `0x${string}`;
  /**
   * `"needed"` reads `determineAction(pool)` (returns `amountOwedToPool`
   * alongside `isToken0Debt`). `"balance-only"` reads `poolConfigs(pool)`
   * and skips the needed-amount lookup.
   */
  mode: "needed" | "balance-only";
  /**
   * Symbol resolver — receives `(chainId, address)`, returns the canonical
   * symbol or `null`. Bridge passes `tokenSymbol` from the contracts
   * manifest; dashboard passes a wrapper around its on-chain `symbol()`
   * read.
   */
  resolveSymbol(
    chainId: number,
    address: `0x${string}`,
  ): Promise<string | null> | string | null;
  /**
   * Decimals resolver — receives `(chainId, address)`, returns the
   * decimals. Both consumers prefer the canonical manifest first (zero
   * RPC) and fall back to an on-chain read; the difference is in the
   * caching strategy. Throw on unrecoverable RPC failure.
   *
   * The optional `signal` is forwarded by the bridge probe so a timed-out
   * cycle can short-circuit on-chain decimal lookups too — dashboards
   * that don't aim a signal at this resolver simply omit the argument.
   */
  resolveDecimals(
    chainId: number,
    address: `0x${string}`,
    signal?: AbortSignal,
  ): Promise<number>;
  /**
   * Optional abort signal threaded through every RPC call this enrichment
   * fetch issues. When the signal aborts, all in-flight reads MUST reject
   * promptly so the caller can stop holding stale state. The metrics-bridge
   * probe sets this to its per-probe AbortController; the dashboard tooltip
   * leaves it undefined (no cancellation requirement on user-initiated
   * tooltip fetches).
   */
  signal?: AbortSignal;
}

export interface EnrichmentResult {
  collateralToken: `0x${string}`;
  /** Reserve's current ERC20 balance of the collateral, in human units. */
  balance: number;
  /** Strategy's required transfer to close the breach, in human units. Absent in `balance-only` mode. */
  needed?: number;
  /** Resolved collateral token symbol — `null` when the manifest lookup misses. */
  tokenSymbol: string | null;
  /** Decimals of the collateral token. */
  decimals: number;
}

/**
 * Fetch the reserve-collateral state needed to annotate a
 * `RLS_RESERVE_OUT_OF_COLLATERAL` revert with on-chain context. Returns
 * `null` on any RPC failure so consumers can fall back to the generic
 * reason message without crashing the breach alert.
 */
export async function fetchReserveEnrichment(
  rpc: EnrichmentRpc,
  strategy: `0x${string}`,
  pool: `0x${string}`,
  options: EnrichmentOptions,
): Promise<EnrichmentResult | null> {
  try {
    // 1. Determine which leg is debt + (in needed-mode) the required
    //    transfer amount. Issued in parallel with the pool's token0/token1
    //    reads since neither dependency-graphs into the other. Strategy
    //    debt-leg read goes first so consumers with sequential / order-
    //    sensitive mocks (vitest `mockResolvedValueOnce` chains) can stay
    //    deterministic without overhauling their fixtures.
    const { signal } = options;
    const [debtInfo, { token0, token1 }] = await Promise.all([
      options.mode === "needed"
        ? rpc.readDetermineAction({ strategy, pool, signal })
        : rpc.readPoolConfigs({ strategy, pool, signal }),
      rpc.readPoolTokens(pool, signal),
    ]);

    // 2. Collateral is the non-debt leg.
    const collateralToken = debtInfo.isToken0Debt ? token1 : token0;

    // 3. balanceOf + symbol + decimals on the collateral token. All three
    //    reads are independent of each other given `collateralToken`, so
    //    we issue them in parallel. Decimals + symbol may resolve from the
    //    consumer's manifest / cache (zero RPC) or fall back to an on-chain
    //    read; balanceOf is always fresh.
    const [balance, tokenSymbol, decimals] = await Promise.all([
      rpc.readBalanceOf({
        token: collateralToken,
        holder: options.reserveAddr,
        signal,
      }),
      options.resolveSymbol(options.chainId, collateralToken),
      options.resolveDecimals(options.chainId, collateralToken, signal),
    ]);

    const result: EnrichmentResult = {
      collateralToken,
      balance: toHumanUnits(balance, decimals),
      tokenSymbol,
      decimals,
    };
    if (
      options.mode === "needed" &&
      "amountOwedToPool" in debtInfo &&
      typeof debtInfo.amountOwedToPool === "bigint"
    ) {
      result.needed = toHumanUnits(debtInfo.amountOwedToPool, decimals);
    }
    return result;
  } catch (err) {
    // Re-throw aborts so the caller's wall-clock timeout actually short-
    // circuits — otherwise an AbortError mid-enrichment gets swallowed and
    // the probe returns the un-enriched blocked result instead of a
    // transport_error, defeating the abort guarantee for any pool whose
    // signal happens to fire during reserve enrichment.
    if (
      err &&
      typeof err === "object" &&
      ((err as { name?: string }).name === "AbortError" ||
        (err as { code?: string }).code === "ABORT_ERR")
    ) {
      throw err;
    }
    return null;
  }
}
