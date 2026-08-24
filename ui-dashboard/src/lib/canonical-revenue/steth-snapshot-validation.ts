import type { StethYieldDailySnapshotRow } from "./types";
import {
  RESERVE_YIELD_ETHEREUM_CHAIN_ID,
  STETH_TOKEN_ADDRESS,
} from "@/lib/reserve-yield-types";
import { isTrackedStethWalletIdentifier } from "@/lib/reserve-yield-steth-coverage";

const STETH_NONNEGATIVE_BIGINT_FIELDS = [
  "balanceAmount",
  "principalAmount",
  "realizedYieldAmount",
  "transferredOutYieldAmount",
  "unrealizedYieldAmount",
  "totalEarnedYieldAmount",
  "dailyEarnedYieldAmount",
  "dailyRealizedYieldAmount",
] as const satisfies ReadonlyArray<keyof StethYieldDailySnapshotRow>;

const STETH_SIGNED_DELTA_FIELDS = [
  "dailyUnrealizedYieldAmount",
] as const satisfies ReadonlyArray<keyof StethYieldDailySnapshotRow>;

const STETH_POSITIVE_BIGINT_FIELDS = [
  "sampledAtBlock",
  "sampledAtTimestamp",
] as const satisfies ReadonlyArray<keyof StethYieldDailySnapshotRow>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
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

export function isValidStethYieldDailySnapshotRow(
  value: unknown,
): value is StethYieldDailySnapshotRow {
  if (!isRecord(value)) return false;
  if (!isNonemptyString(value.id)) return false;
  if (
    typeof value.chainId !== "number" ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId !== RESERVE_YIELD_ETHEREUM_CHAIN_ID
  ) {
    return false;
  }
  if (
    !isNonemptyString(value.token) ||
    value.token.trim().toLowerCase() !== STETH_TOKEN_ADDRESS ||
    !isNonemptyString(value.wallet) ||
    !isTrackedStethWalletIdentifier(value.wallet)
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
    STETH_NONNEGATIVE_BIGINT_FIELDS.every((field) =>
      isNonnegativeIntegerString(value[field]),
    ) &&
    STETH_SIGNED_DELTA_FIELDS.every((field) => isIntegerString(value[field])) &&
    STETH_POSITIVE_BIGINT_FIELDS.every((field) =>
      isPositiveIntegerString(value[field]),
    )
  );
}
