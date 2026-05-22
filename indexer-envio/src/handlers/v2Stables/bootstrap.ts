// ---------------------------------------------------------------------------
// V2 stable supply bootstrap.
//
// Lazily creates the `V2StableTokenSupply` running-state row on first
// Transfer-zero event per (chainId, tokenAddress). Baseline `totalSupply` is
// seeded from the RPC `v2StableTotalSupplyEffect` at `block - 1` so we capture
// the exact pre-event supply, then deltas accumulate forward.
//
// Preload-mode hook: `preloadV2StableTokenSupply` pre-fetches the running
// entity + the RPC baseline if not yet seeded, mirroring `feeToken.ts`'s
// preload pattern. Preload returns early without writes; the steady-state
// handler does the write on its post-preload pass.
// ---------------------------------------------------------------------------

import type { EvmOnEventContext, V2StableTokenSupply } from "envio";
import { dayBucket } from "../../helpers.js";
import { findV2StableByAddress, makeV2StableSupplyId } from "./config.js";
import { v2StableTotalSupplyEffect } from "../../rpc/v2-stables.js";

// Use Envio's published context type so the effect caller, entity stores,
// and isPreload predicate are correctly typed. The locally-narrowed
// `SnapshotContext` pattern in src/handlers/liquity/instance.ts works for
// pure entity writers, but anything that calls `context.effect(...)` needs
// the real EffectCaller signature.
type BootstrapContext = EvmOnEventContext;

/**
 * Build a fresh `V2StableTokenSupply` row with `supplyBaselineSeeded: false`
 * and zero accumulators. Day bucket is initialized to the current event's
 * day so the first day-flush only fires once a real day boundary crosses
 * (avoiding a spurious flush at supply=0 on the very first event).
 */
export type MakeV2StableTokenSupplyArgs = {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  decimals: number;
  source: V2StableTokenSupply["source"];
  blockNumber: bigint;
  blockTimestamp: bigint;
};

export function makeV2StableTokenSupply(
  args: MakeV2StableTokenSupplyArgs,
): V2StableTokenSupply {
  const {
    chainId,
    tokenAddress,
    symbol,
    decimals,
    source,
    blockNumber,
    blockTimestamp,
  } = args;
  return {
    id: makeV2StableSupplyId(chainId, tokenAddress),
    chainId,
    tokenAddress,
    tokenSymbol: symbol,
    source,
    tokenDecimals: decimals,
    totalSupply: 0n,
    supplyBaselineSeeded: false,
    currentDayBucket: dayBucket(blockTimestamp),
    mintedTodayBucket: 0n,
    burnedTodayBucket: 0n,
    lastEventBlock: blockNumber,
    lastEventTimestamp: blockTimestamp,
  };
}

/**
 * Get the running supply row for (chainId, tokenAddress), creating it lazily
 * on first touch. Returns undefined if the token isn't in our registry
 * (defensive — the handler's `where` filter already gates address, but a
 * stale YAML deploy could let an event through).
 */
export async function getOrCreateV2StableTokenSupply(
  context: BootstrapContext,
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<V2StableTokenSupply | undefined> {
  const info = findV2StableByAddress(chainId, tokenAddress);
  if (!info) return undefined;

  const id = makeV2StableSupplyId(chainId, tokenAddress);
  const existing = await context.V2StableTokenSupply.get(id);
  if (existing) return existing;

  return makeV2StableTokenSupply({
    chainId,
    tokenAddress,
    symbol: info.symbol,
    decimals: info.decimals,
    source: info.source,
    blockNumber,
    blockTimestamp,
  });
}

/**
 * Preload-mode helper. Pre-fetches the running entity and (if not yet seeded)
 * the RPC baseline so Envio can dedupe the effect call across batch peers.
 * Safe no-op when called multiple times for the same (chainId, tokenAddress)
 * within a batch — the in-batch effect dedup serves the second-onward callers.
 */
export async function preloadV2StableTokenSupply(
  context: BootstrapContext,
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
): Promise<void> {
  const id = makeV2StableSupplyId(chainId, tokenAddress);
  const existing = await context.V2StableTokenSupply.get(id);
  if (existing?.supplyBaselineSeeded) return;
  await context.effect(v2StableTotalSupplyEffect, {
    chainId,
    tokenAddress,
    blockNumber: blockNumber - 1n,
  });
}
