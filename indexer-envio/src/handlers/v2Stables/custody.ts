// ---------------------------------------------------------------------------
// Wormhole NTT lock-custody tracking.
//
// Lock/mint NTT deployments keep source-chain supply in the ERC20 contract
// while minting matching destination-chain supply. To avoid double counting
// global Mento stable supply, the dashboard subtracts the source-chain NTT
// manager balance from the raw source-chain StableSupplyDailySnapshot.
//
// This handler writes that separate custody series. It intentionally does NOT
// mutate StableSupplyDailySnapshot: raw supply stays auditable, and
// circulating/global supply is derived in the UI.
// ---------------------------------------------------------------------------

import type { EvmOnEventContext, StableTokenCustodyState } from "envio";
import { asAddress } from "../../helpers.js";
import { v2StableBalanceOfEffect } from "../../rpc/effects.js";
import {
  findLockingNttStableByAddress,
  makeStableTokenCustodyId,
} from "./config.js";
import {
  flushStableTokenCustodyDailySnapshot,
  makeStableTokenCustodyState,
} from "./custodyState.js";

type StableTokenTransferEvent = {
  chainId: number;
  srcAddress: string;
  params: {
    from: string;
    to: string;
    value: bigint;
  };
  block: {
    number: number;
    timestamp: number;
  };
};

async function preloadStableTokenCustodyState(
  context: EvmOnEventContext,
  chainId: number,
  tokenAddress: string,
  managerAddress: string,
  blockNumber: bigint,
): Promise<void> {
  const id = makeStableTokenCustodyId(chainId, tokenAddress);
  const existing = await context.StableTokenCustodyState.get(id);
  if (existing?.supplyBaselineSeeded) return;
  await context.effect(v2StableBalanceOfEffect, {
    chainId,
    tokenAddress,
    account: managerAddress,
    blockNumber: blockNumber - 1n,
  });
}

async function getOrCreateStableTokenCustodyState(
  context: EvmOnEventContext,
  chainId: number,
  tokenAddress: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<StableTokenCustodyState | undefined> {
  const info = findLockingNttStableByAddress(chainId, tokenAddress);
  if (!info) return undefined;
  const id = makeStableTokenCustodyId(chainId, tokenAddress);
  const existing = await context.StableTokenCustodyState.get(id);
  if (existing) return existing;
  return makeStableTokenCustodyState({
    chainId,
    tokenAddress,
    symbol: info.symbol,
    decimals: info.decimals,
    source: info.source,
    managerAddress: info.nttManagerAddress,
    blockNumber,
    blockTimestamp,
  });
}

export async function handleStableTokenCustodyTransfer({
  event,
  context,
}: {
  event: StableTokenTransferEvent;
  context: EvmOnEventContext;
}): Promise<void> {
  const { chainId, srcAddress } = event;
  const tokenAddress = asAddress(srcAddress);
  const info = findLockingNttStableByAddress(chainId, tokenAddress);
  if (!info) return;

  const managerAddress = info.nttManagerAddress;
  const from = asAddress(event.params.from);
  const to = asAddress(event.params.to);
  const isLock = to === managerAddress;
  const isUnlock = from === managerAddress;
  // Skip regular transfers and manager-to-manager no-ops; only one side of a
  // custody-changing transfer can be the NTT manager.
  if (isLock === isUnlock) return;

  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  if (context.isPreload) {
    await preloadStableTokenCustodyState(
      context,
      chainId,
      tokenAddress,
      managerAddress,
      blockNumber,
    );
    return;
  }

  let state = await getOrCreateStableTokenCustodyState(
    context,
    chainId,
    tokenAddress,
    blockNumber,
    blockTimestamp,
  );
  if (!state) return;

  if (!state.supplyBaselineSeeded) {
    const baseline = await context.effect(v2StableBalanceOfEffect, {
      chainId,
      tokenAddress,
      account: managerAddress,
      blockNumber: blockNumber - 1n,
    });
    if (baseline === null) {
      throw new Error(
        `[v2Stables/custody] balanceOf baseline failed for ${tokenAddress}.balanceOf(${managerAddress}) ` +
          `on chain ${chainId} at block ${blockNumber - 1n}. Retrying until RPC recovers.`,
      );
    }
    state = {
      ...state,
      lockedSupply: baseline,
      supplyBaselineSeeded: true,
    };
  }

  state = flushStableTokenCustodyDailySnapshot(
    context,
    state,
    blockTimestamp,
    blockNumber,
  );

  const amount = event.params.value;
  const nextLockedSupply = isLock
    ? state.lockedSupply + amount
    : state.lockedSupply >= amount
      ? state.lockedSupply - amount
      : 0n;
  if (!isLock && amount > state.lockedSupply) {
    context.log.warn?.(
      `[v2Stables/custody] Unlock amount ${amount} exceeds tracked lockedSupply ${state.lockedSupply} ` +
        `for ${tokenAddress} on chain ${chainId}; flooring lockedSupply at 0.`,
    );
  }

  context.StableTokenCustodyState.set({
    ...state,
    lockedSupply: nextLockedSupply,
    lockedTodayBucket: state.lockedTodayBucket + (isLock ? amount : 0n),
    unlockedTodayBucket: state.unlockedTodayBucket + (isUnlock ? amount : 0n),
    lastEventBlock: blockNumber,
    lastEventTimestamp: blockTimestamp,
  });
}
