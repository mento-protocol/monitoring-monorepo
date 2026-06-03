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
    blockNumber,
    updatedAtTimestamp: eventTimestamp,
  });

  return {
    ...state,
    currentDayBucket: eventDay,
    lockedTodayBucket: 0n,
    unlockedTodayBucket: 0n,
  };
}
