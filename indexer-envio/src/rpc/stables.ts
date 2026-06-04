// ---------------------------------------------------------------------------
// Stable supply — totalSupply() RPC fetcher + effect declaration.
//
// Co-locating the effect with its fetcher (instead of in `effects.ts`) keeps
// the central effects file under the 600-line soft cap and stays out of the
// Group A/B/C/D taxonomy in effects.ts — this is a block-scoped, address-
// keyed effect (would be Group C if it lived there), and the Group C rule is
// `cache: false` forever to survive Celo archive-block reorgs without
// silently corrupting persisted cache values.
//
// Used exactly once per (chainId, tokenAddress) by the stable Transfer
// handler to seed the per-token supply baseline on the first observed
// Transfer-with-zero event. Subsequent supply changes are derived from
// Transfer deltas in the handler — this fetcher is the once-per-token entry
// point.
// ---------------------------------------------------------------------------

import { createEffect, S } from "envio";
import { ERC20_BALANCE_OF_ABI, ERC20_TOTAL_SUPPLY_ABI } from "../abis.js";
import { readContractWithBlockFallback } from "./block-fallback.js";
import { getFallbackRpcClient, getRpcClient, logRpcFailure } from "./client.js";
import { consoleLogger, type RpcLogger } from "./log.js";

const _testTotalSupply = new Map<string, bigint | null>();
const _testBalanceOf = new Map<string, bigint | null>();

/** @internal Test-only: pre-set a mock totalSupply for a token at a block.
 *  Pass `null` to simulate an RPC failure (fetch returns null). Key includes
 *  the block number so a single test can seed pre-event and post-event values
 *  separately if needed. Used by `test/stables.test.ts` baseline-seed
 *  scenarios. */
export function _setMockStableTotalSupply(
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  value: bigint | null,
): void {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${blockNumber}`;
  _testTotalSupply.set(key, value);
}

/** @internal Test-only: clear all mock totalSupply values. */
export function _clearMockStableTotalSupply(): void {
  _testTotalSupply.clear();
}

/** @internal Test-only: pre-set a mock ERC20 balanceOf(account) at a block. */
export function _setMockStableBalanceOf({
  chainId,
  tokenAddress,
  account,
  blockNumber,
  value,
}: {
  chainId: number;
  tokenAddress: string;
  account: string;
  blockNumber: bigint;
  value: bigint | null;
}): void {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${account.toLowerCase()}:${blockNumber}`;
  _testBalanceOf.set(key, value);
}

/** @internal Test-only: clear all mock balanceOf values. */
export function _clearMockStableBalanceOf(): void {
  _testBalanceOf.clear();
}

/**
 * Returns the on-chain totalSupply for an ERC20 at the given block, or null
 * on RPC failure (callers must skip the entity write and retry on the next
 * event — never persist a degraded baseline).
 *
 * blockNumber is required: callers pin the event's `block - 1` to capture
 * the exact pre-event state we use as the delta baseline. Guards against
 * `readContractWithBlockFallback` quietly falling back to `latest` (which
 * would return the POST-event supply and silently corrupt the baseline
 * forever — see block-fallback.ts:56-64 and the matching guard in
 * pool-fees.ts:205).
 */
export async function fetchStableTotalSupply(
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${blockNumber}`;
  const mocked = _testTotalSupply.get(key);
  if (mocked !== undefined) return mocked;
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: tokenAddress as `0x${string}`,
        abi: ERC20_TOTAL_SUPPLY_ABI,
        functionName: "totalSupply",
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    // `usedLatestFallback === true` means we got a post-event supply
    // value, not the pre-event baseline we need. Returning null here is
    // mandatory — persisting this value as the baseline would corrupt all
    // forward deltas for this token (the bug correctness review caught).
    if (usedLatestFallback) return null;
    return result as bigint;
  } catch (err) {
    // viem stamps "returned no data" on a `ContractFunctionExecutionError`
    // when the underlying eth_call returns `0x` — for ERC20 `totalSupply`
    // specifically that can only mean the address has no bytecode at the
    // queried block (every real ERC20 implements the function). For our 13
    // stables this is unreachable in practice (all deployed pre-
    // `start_block`), but the safe-baseline path matters if a future
    // token is added to the registry at its deploy block: throwing here
    // would halt ingestion forever because the retry hits the same pre-
    // deployment block. Returning `0n` lets the handler seed the baseline
    // correctly (token didn't exist → supply was 0).
    if (isContractNotDeployedError(err)) {
      log.info?.(
        `[stableTotalSupply] ${tokenAddress} on chain ${chainId} returned no data at block ${blockNumber} — pre-deployment block, seeding baseline = 0n.`,
      );
      return BigInt(0);
    }
    logRpcFailure(
      chainId,
      "stableTotalSupply",
      tokenAddress,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

/**
 * Returns the on-chain ERC20 balanceOf(account) at the given block, or null
 * on RPC failure. Used to seed NTT lock-custody state at `event.block - 1`.
 */
export async function fetchStableBalanceOf(
  {
    chainId,
    tokenAddress,
    account,
    blockNumber,
  }: {
    chainId: number;
    tokenAddress: string;
    account: string;
    blockNumber: bigint;
  },
  log: RpcLogger = consoleLogger,
): Promise<bigint | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}:${account.toLowerCase()}:${blockNumber}`;
  const mocked = _testBalanceOf.get(key);
  if (mocked !== undefined) return mocked;
  try {
    const client = getRpcClient(chainId);
    const { result, usedLatestFallback } = await readContractWithBlockFallback(
      chainId,
      client,
      {
        address: tokenAddress as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [account as `0x${string}`],
      },
      blockNumber,
      getFallbackRpcClient(chainId),
      log,
    );
    if (usedLatestFallback) return null;
    return result as bigint;
  } catch (err) {
    if (isContractNotDeployedError(err)) {
      log.info?.(
        `[stableBalanceOf] ${tokenAddress}.balanceOf(${account}) on chain ${chainId} returned no data at block ${blockNumber} — pre-deployment block, seeding baseline = 0n.`,
      );
      return BigInt(0);
    }
    logRpcFailure(
      chainId,
      "stableBalanceOf",
      `${tokenAddress}:${account}`,
      err,
      blockNumber,
      log,
    );
    return null;
  }
}

// Mirrors `isUnsupportedGetterError` in pool-fees.ts. viem's
// `ContractFunctionExecutionError` wraps the "returned no data" message when
// the underlying call yields `0x`. For totalSupply on an ERC20 address this
// can only mean the contract has no code at the queried block.
function isContractNotDeployedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("returned no data");
}

// ---------------------------------------------------------------------------
// Effect — block-scoped, address-keyed, `cache: false`.
//
// Group C semantics (see effects.ts:460-465): block-scoped + address-keyed
// effects MUST stay `cache: false` permanently. Celo archive reorgs (rare
// but real) would otherwise replay against persisted cache values — the
// post-reorg block at the same `(chainId, tokenAddress, blockNumber)` key
// can yield a different totalSupply if a mint/burn was rolled back. Fresh
// reads on reindex are the only safe behavior.
//
// On RPC failure or `usedLatestFallback`, the fetcher returns null. The
// handler treats null as "retry" — see src/handlers/stables/transfer.ts.
// (The outer `cache: false` already covers null results too; no
// per-branch `context.cache = false` needed.)
// ---------------------------------------------------------------------------
export const stableTotalSupplyEffect = createEffect(
  {
    name: "stableTotalSupply",
    input: { chainId: S.int32, tokenAddress: S.string, blockNumber: S.bigint },
    output: S.nullable(S.bigint),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input, context }) => {
    const result = await fetchStableTotalSupply(
      input.chainId,
      input.tokenAddress,
      input.blockNumber,
      context.log,
    );
    return result;
  },
);

export const stableBalanceOfEffect = createEffect(
  {
    name: "stableBalanceOf",
    input: {
      chainId: S.int32,
      tokenAddress: S.string,
      account: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(S.bigint),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input, context }) => {
    const result = await fetchStableBalanceOf(
      {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        account: input.account,
        blockNumber: input.blockNumber,
      },
      context.log,
    );
    return result;
  },
);
