import type { SusdsYieldDailySnapshotRow } from "./types";

const SUSDS_BIGINT_FIELDS = [
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
  "dailyUnrealizedYieldUsdWei",
  "sharePriceUsdWei",
  "sampledAtBlock",
  "sampledAtTimestamp",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value.trim());
}

export function isValidSusdsYieldDailySnapshotRow(
  value: unknown,
): value is SusdsYieldDailySnapshotRow {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (typeof value.chainId !== "number" || !Number.isInteger(value.chainId)) {
    return false;
  }
  if (typeof value.token !== "string" || value.token.trim() === "") {
    return false;
  }
  if (
    !isIntegerString(value.timestamp) ||
    !Number.isSafeInteger(Number(value.timestamp))
  ) {
    return false;
  }
  return SUSDS_BIGINT_FIELDS.every((field) => isIntegerString(value[field]));
}

export function hasInvalidSusdsYieldDailySnapshotRow(
  rows: ReadonlyArray<unknown>,
): boolean {
  return rows.some((row) => {
    if (!isRecord(row)) return true;
    return !("wallet" in row) && !isValidSusdsYieldDailySnapshotRow(row);
  });
}
