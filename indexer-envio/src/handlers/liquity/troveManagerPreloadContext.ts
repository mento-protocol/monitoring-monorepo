import type {
  BorrowerInfo,
  InterestRateBracket,
  LiquityBorrowingRevenueDailySnapshot,
  PendingBatchMembershipOperation,
  PendingBatchedTroveUpdate,
  PendingRedemption,
} from "envio";
import type { LiquityPriceContext } from "./priceFeed.js";
import type { preloadSystemParams } from "./systemParams.js";

export type TroveManagerPreloadContext = Parameters<
  typeof preloadSystemParams
>[0] &
  LiquityPriceContext & {
    PendingBatchMembershipOperation: {
      get: (id: string) => Promise<PendingBatchMembershipOperation | undefined>;
      getWhere: (args: {
        txHash: { _eq: string };
      }) => Promise<PendingBatchMembershipOperation[]>;
      set: (entity: PendingBatchMembershipOperation) => void;
      deleteUnsafe: (id: string) => void;
    };
    PendingRedemption: {
      get: (id: string) => Promise<PendingRedemption | undefined>;
    };
    PendingBatchedTroveUpdate: {
      getWhere: (args: { txHash: { _eq: string } }) => Promise<
        Array<{
          collateralId: string;
          batchManager: string;
          logIndex: number;
          troveId: string;
          batchDebtShares: bigint;
        }>
      >;
      set: (entity: PendingBatchedTroveUpdate) => void;
    };
    InterestRateBracket: {
      get: (id: string) => Promise<InterestRateBracket | undefined>;
      getWhere: (args: {
        collateralId: { _eq: string };
      }) => Promise<InterestRateBracket[]>;
      set: (entity: InterestRateBracket) => void;
    };
    LiquityBorrowingRevenueDailySnapshot: {
      get: (
        id: string,
      ) => Promise<LiquityBorrowingRevenueDailySnapshot | undefined>;
      set: (entity: LiquityBorrowingRevenueDailySnapshot) => void;
    };
    BorrowerInfo: {
      get: (id: string) => Promise<BorrowerInfo | undefined>;
      set: (entity: BorrowerInfo) => void;
    };
  };

export type TroveOperationPreloadContext = TroveManagerPreloadContext & {
  PendingRedemption: {
    get: (id: string) => Promise<PendingRedemption | undefined>;
    set: (entity: PendingRedemption) => void;
  };
};

export type PendingBatchedTroveUpdateRow = Awaited<
  ReturnType<
    TroveManagerPreloadContext["PendingBatchedTroveUpdate"]["getWhere"]
  >
>[number];
