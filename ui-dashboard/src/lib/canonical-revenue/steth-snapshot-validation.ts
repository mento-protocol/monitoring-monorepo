import type { StethYieldDailySnapshotRow } from "./types";
import { z } from "zod/mini";
import {
  type ExhaustiveSchemaShape,
  integerStringSchema,
  nonemptyStringSchema,
  nonnegativeIntegerStringSchema,
  positiveIntegerStringSchema,
  safePositiveIntegerStringSchema,
} from "./snapshot-validation-schema";
import {
  RESERVE_YIELD_ETHEREUM_CHAIN_ID,
  STETH_TOKEN_ADDRESS,
} from "@/lib/reserve-yield-types";
import { isTrackedStethWalletIdentifier } from "@/lib/reserve-yield-steth-coverage";

const stethYieldDailySnapshotRowSchema = z.object({
  id: nonemptyStringSchema,
  chainId: z.literal(RESERVE_YIELD_ETHEREUM_CHAIN_ID),
  token: z
    .string()
    .check(
      z.refine((value) => value.trim().toLowerCase() === STETH_TOKEN_ADDRESS),
    ),
  wallet: nonemptyStringSchema.check(z.refine(isTrackedStethWalletIdentifier)),
  timestamp: safePositiveIntegerStringSchema,
  balanceAmount: nonnegativeIntegerStringSchema,
  principalAmount: nonnegativeIntegerStringSchema,
  realizedYieldAmount: nonnegativeIntegerStringSchema,
  transferredOutYieldAmount: nonnegativeIntegerStringSchema,
  unrealizedYieldAmount: nonnegativeIntegerStringSchema,
  totalEarnedYieldAmount: nonnegativeIntegerStringSchema,
  dailyEarnedYieldAmount: nonnegativeIntegerStringSchema,
  dailyRealizedYieldAmount: nonnegativeIntegerStringSchema,
  dailyUnrealizedYieldAmount: integerStringSchema,
  sampledAtBlock: positiveIntegerStringSchema,
  sampledAtTimestamp: positiveIntegerStringSchema,
} satisfies ExhaustiveSchemaShape<StethYieldDailySnapshotRow>);

export function isValidStethYieldDailySnapshotRow(
  value: unknown,
): value is StethYieldDailySnapshotRow {
  return stethYieldDailySnapshotRowSchema.safeParse(value).success;
}
