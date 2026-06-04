import type { StableTokenCustodyState } from "envio";
import { asAddress, dayBucket } from "../../helpers.js";
import {
  makeStableTokenCustodyDailySnapshotId,
  makeStableTokenCustodyId,
} from "./config.js";

type CustodyContext = {
  StableTokenCustodyDailySnapshot: {
    set: (entity: {
      id: string;
      chainId: number;
      tokenAddress: string;
      tokenSymbol: string;
      source: StableTokenCustodyState["source"];
      tokenDecimals: number;
      managerAddress: string;
      timestamp: bigint;
      lockedSupply: bigint;
      dailyLockedAmount: bigint;
      dailyUnlockedAmount: bigint;
      blockNumber: bigint;
      updatedAtTimestamp: bigint;
    }) => void;
  };
};

type CustodyUpdateContext = CustodyContext & {
  StableTokenCustodyState: {
    set: (entity: StableTokenCustodyState) => void;
  };
  log?: {
    warn?: (message: string) => void;
  };
};

export type MakeStableTokenCustodyStateArgs = {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  decimals: number;
  source: StableTokenCustodyState["source"];
  managerAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
};

export function makeStableTokenCustodyState(
  args: MakeStableTokenCustodyStateArgs,
): StableTokenCustodyState {
  return {
    id: makeStableTokenCustodyId(args.chainId, args.tokenAddress),
    chainId: args.chainId,
    tokenAddress: asAddress(args.tokenAddress),
    tokenSymbol: args.symbol,
    source: args.source,
    tokenDecimals: args.decimals,
    managerAddress: asAddress(args.managerAddress),
    lockedSupply: 0n,
    supplyBaselineSeeded: false,
    currentDayBucket: dayBucket(args.blockTimestamp),
    lockedTodayBucket: 0n,
    unlockedTodayBucket: 0n,
    lastEventBlock: args.blockNumber,
    lastEventTimestamp: args.blockTimestamp,
  };
}

export function flushStableTokenCustodyDailySnapshot(
  context: CustodyContext,
  state: StableTokenCustodyState,
  eventTimestamp: bigint,
  blockNumber: bigint,
): StableTokenCustodyState {
  const eventDay = dayBucket(eventTimestamp);
  if (state.currentDayBucket >= eventDay) return state;

  setStableTokenCustodyDailySnapshot(
    context,
    state,
    eventTimestamp,
    blockNumber,
  );

  return {
    ...state,
    currentDayBucket: eventDay,
    lockedTodayBucket: 0n,
    unlockedTodayBucket: 0n,
  };
}

export function applyStableTokenCustodyTransferUpdate({
  context,
  state,
  amount,
  isLock,
  eventTimestamp,
  blockNumber,
}: {
  context: CustodyUpdateContext;
  state: StableTokenCustodyState;
  amount: bigint;
  isLock: boolean;
  eventTimestamp: bigint;
  blockNumber: bigint;
}): StableTokenCustodyState {
  const flushed = flushStableTokenCustodyDailySnapshot(
    context,
    state,
    eventTimestamp,
    blockNumber,
  );
  const isUnlock = !isLock;
  const nextLockedSupply = isLock
    ? flushed.lockedSupply + amount
    : flushed.lockedSupply >= amount
      ? flushed.lockedSupply - amount
      : 0n;
  if (isUnlock && amount > flushed.lockedSupply) {
    context.log?.warn?.(
      `[stables/custody] Unlock amount ${amount} exceeds tracked lockedSupply ${flushed.lockedSupply} ` +
        `for ${flushed.tokenAddress} on chain ${flushed.chainId}; flooring lockedSupply at 0.`,
    );
  }

  const nextState = {
    ...flushed,
    lockedSupply: nextLockedSupply,
    lockedTodayBucket: flushed.lockedTodayBucket + (isLock ? amount : 0n),
    unlockedTodayBucket: flushed.unlockedTodayBucket + (isUnlock ? amount : 0n),
    lastEventBlock: blockNumber,
    lastEventTimestamp: eventTimestamp,
  };

  context.StableTokenCustodyState.set(nextState);
  setStableTokenCustodyDailySnapshot(
    context,
    nextState,
    eventTimestamp,
    blockNumber,
  );
  return nextState;
}

export function setStableTokenCustodyDailySnapshot(
  context: CustodyContext,
  state: StableTokenCustodyState,
  eventTimestamp: bigint,
  blockNumber: bigint,
): void {
  context.StableTokenCustodyDailySnapshot.set({
    id: makeStableTokenCustodyDailySnapshotId(
      state.chainId,
      state.tokenAddress,
      state.currentDayBucket,
    ),
    chainId: state.chainId,
    tokenAddress: state.tokenAddress,
    tokenSymbol: state.tokenSymbol,
    source: state.source,
    tokenDecimals: state.tokenDecimals,
    managerAddress: state.managerAddress,
    timestamp: state.currentDayBucket,
    lockedSupply: state.lockedSupply,
    dailyLockedAmount: state.lockedTodayBucket,
    dailyUnlockedAmount: state.unlockedTodayBucket,
    // For rollover rows this is the flush-trigger event's block, not the
    // previous day's final block. For current-day upserts, it is the custody
    // event that refreshed the row.
    blockNumber,
    updatedAtTimestamp: eventTimestamp,
  });
}
