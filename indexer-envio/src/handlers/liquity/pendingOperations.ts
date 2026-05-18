import { pendingTroveKey } from "./keys.js";

export function setPendingBatchMembershipOperation(
  context: {
    PendingBatchMembershipOperation: {
      set: (entity: {
        id: string;
        collateralId: string;
        txHash: string;
        troveId: string;
        operation: number;
        annualInterestRate: bigint;
        timestamp: bigint;
        blockNumber: bigint;
      }) => void;
    };
  },
  args: {
    chainId: number;
    txHash: string;
    collateralId: string;
    troveId: string;
    operation: number;
    annualInterestRate: bigint;
    timestamp: bigint;
    blockNumber: bigint;
  },
): void {
  context.PendingBatchMembershipOperation.set({
    id: pendingTroveKey(
      args.chainId,
      args.txHash,
      args.collateralId,
      args.troveId,
    ),
    collateralId: args.collateralId,
    txHash: args.txHash,
    troveId: args.troveId,
    operation: args.operation,
    annualInterestRate: args.annualInterestRate,
    timestamp: args.timestamp,
    blockNumber: args.blockNumber,
  });
}

export function setPendingRedemption(
  context: {
    PendingRedemption: {
      set: (entity: {
        id: string;
        collateralId: string;
        txHash: string;
        troveId: string;
        timestamp: bigint;
        blockNumber: bigint;
      }) => void;
    };
  },
  args: {
    chainId: number;
    txHash: string;
    collateralId: string;
    troveId: string;
    timestamp: bigint;
    blockNumber: bigint;
  },
): void {
  context.PendingRedemption.set({
    id: pendingTroveKey(
      args.chainId,
      args.txHash,
      args.collateralId,
      args.troveId,
    ),
    collateralId: args.collateralId,
    txHash: args.txHash,
    troveId: args.troveId,
    timestamp: args.timestamp,
    blockNumber: args.blockNumber,
  });
}
