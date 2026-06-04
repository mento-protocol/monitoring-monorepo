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
import { stableBalanceOfEffect } from "../../rpc/effects.js";
import {
  findLockAndMintNttStableByAddress,
  makeStableTokenCustodyId,
} from "./config.js";
import {
  applyStableTokenCustodyTransferUpdate,
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
  await context.effect(stableBalanceOfEffect, {
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
  const info = findLockAndMintNttStableByAddress(chainId, tokenAddress);
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
  const info = findLockAndMintNttStableByAddress(chainId, tokenAddress);
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
    const baseline = await context.effect(stableBalanceOfEffect, {
      chainId,
      tokenAddress,
      account: managerAddress,
      blockNumber: blockNumber - 1n,
    });
    if (baseline === null) {
      throw new Error(
        `[stables/custody] balanceOf baseline failed for ${tokenAddress}.balanceOf(${managerAddress}) ` +
          `on chain ${chainId} at block ${blockNumber - 1n}. Retrying until RPC recovers.`,
      );
    }
    state = {
      ...state,
      lockedSupply: baseline,
      supplyBaselineSeeded: true,
    };
  }

  applyStableTokenCustodyTransferUpdate({
    context,
    state,
    amount: event.params.value,
    isLock,
    eventTimestamp: blockTimestamp,
    blockNumber,
  });
}
