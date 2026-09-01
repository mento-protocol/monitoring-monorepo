import type { SusdsYieldDailySnapshotRow } from "./types";
import { z } from "zod/mini";
import {
  type ExhaustiveSchemaShape,
  integerStringSchema,
  matchesSampledUtcDay,
  nonemptyStringSchema,
  nonnegativeIntegerStringSchema,
  positiveIntegerStringSchema,
  safePositiveIntegerStringSchema,
} from "./snapshot-validation-schema";
import {
  RESERVE_YIELD_ETHEREUM_CHAIN_ID,
  SUSDS_TOKEN_ADDRESS,
} from "@/lib/reserve-yield-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const susdsYieldDailySnapshotRowSchema = z
  .object({
    id: nonemptyStringSchema,
    chainId: z.literal(RESERVE_YIELD_ETHEREUM_CHAIN_ID),
    token: z
      .string()
      .check(
        z.refine((value) => value.trim().toLowerCase() === SUSDS_TOKEN_ADDRESS),
      ),
    timestamp: safePositiveIntegerStringSchema,
    currentShares: nonnegativeIntegerStringSchema,
    costBasisUsdWei: nonnegativeIntegerStringSchema,
    realizedYieldUsdWei: nonnegativeIntegerStringSchema,
    transferredOutYieldUsdWei: nonnegativeIntegerStringSchema,
    redeemedYieldUsdWei: nonnegativeIntegerStringSchema,
    currentValueUsdWei: nonnegativeIntegerStringSchema,
    unrealizedYieldUsdWei: nonnegativeIntegerStringSchema,
    totalEarnedYieldUsdWei: nonnegativeIntegerStringSchema,
    dailyEarnedYieldUsdWei: nonnegativeIntegerStringSchema,
    dailyRealizedYieldUsdWei: nonnegativeIntegerStringSchema,
    dailyUnrealizedYieldUsdWei: integerStringSchema,
    sharePriceUsdWei: positiveIntegerStringSchema,
    sampledAtBlock: positiveIntegerStringSchema,
    sampledAtTimestamp: positiveIntegerStringSchema,
  } satisfies ExhaustiveSchemaShape<SusdsYieldDailySnapshotRow>)
  .check(z.refine(matchesSampledUtcDay));

export function isValidSusdsYieldDailySnapshotRow(
  value: unknown,
): value is SusdsYieldDailySnapshotRow {
  return susdsYieldDailySnapshotRowSchema.safeParse(value).success;
}

export function hasInvalidSusdsYieldDailySnapshotRow(
  rows: ReadonlyArray<unknown>,
): boolean {
  return rows.some((row) => {
    if (!isRecord(row)) return true;
    return !("wallet" in row) && !isValidSusdsYieldDailySnapshotRow(row);
  });
}
