import type { SusdsYieldDailySnapshotRow } from "./types";
import {
  RESERVE_YIELD_ETHEREUM_CHAIN_ID,
  SUSDS_TOKEN_ADDRESS,
} from "@/lib/reserve-yield-types";

const SUSDS_NONNEGATIVE_BIGINT_FIELDS = [
  "currentShares",
  "costBasisUsdWei",
  "realizedYieldUsdWei",
  "transferredOutYieldUsdWei",
  "redeemedYieldUsdWei",
  "currentValueUsdWei",
  "unrealizedYieldUsdWei",
  "totalEarnedYieldUsdWei",
  "dailyEarnedYieldUsdWei",
  "dailyRealizedYieldUsdWei",
] as const satisfies ReadonlyArray<keyof SusdsYieldDailySnapshotRow>;

const SUSDS_POSITIVE_BIGINT_FIELDS = [
  "sharePriceUsdWei",
  "sampledAtBlock",
  "sampledAtTimestamp",
] as const satisfies ReadonlyArray<keyof SusdsYieldDailySnapshotRow>;

const SUSDS_SIGNED_DELTA_FIELDS = [
  "dailyUnrealizedYieldUsdWei",
] as const satisfies ReadonlyArray<keyof SusdsYieldDailySnapshotRow>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value.trim());
}

function isNonnegativeIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^0*[1-9]\d*$/.test(value.trim());
}

export function isValidSusdsYieldDailySnapshotRow(
  value: unknown,
): value is SusdsYieldDailySnapshotRow {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (
    typeof value.chainId !== "number" ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId !== RESERVE_YIELD_ETHEREUM_CHAIN_ID
  ) {
    return false;
  }
  if (
    typeof value.token !== "string" ||
    value.token.trim().toLowerCase() !== SUSDS_TOKEN_ADDRESS
  ) {
    return false;
  }
  if (
    !isPositiveIntegerString(value.timestamp) ||
    !Number.isSafeInteger(Number(value.timestamp))
  ) {
    return false;
  }
  return (
    SUSDS_NONNEGATIVE_BIGINT_FIELDS.every((field) =>
      isNonnegativeIntegerString(value[field]),
    ) &&
    SUSDS_POSITIVE_BIGINT_FIELDS.every((field) =>
      isPositiveIntegerString(value[field]),
    ) &&
    SUSDS_SIGNED_DELTA_FIELDS.every((field) => isIntegerString(value[field]))
  );
}

export function hasInvalidSusdsYieldDailySnapshotRow(
  rows: ReadonlyArray<unknown>,
): boolean {
  return rows.some((row) => {
    if (!isRecord(row)) return true;
    return !("wallet" in row) && !isValidSusdsYieldDailySnapshotRow(row);
  });
}
