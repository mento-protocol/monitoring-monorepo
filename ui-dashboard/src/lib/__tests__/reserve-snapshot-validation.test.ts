import { describe, expect, it } from "vitest";
import {
  hasInvalidSusdsYieldDailySnapshotRow,
  isValidSusdsYieldDailySnapshotRow,
} from "@/lib/canonical-revenue/reserve-snapshot-validation";
import type { SusdsYieldDailySnapshotRow } from "@/lib/canonical-revenue/types";

const NONNEGATIVE_STRING_FIELDS = [
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

const POSITIVE_STRING_FIELDS = [
  "timestamp",
  "sharePriceUsdWei",
  "sampledAtBlock",
  "sampledAtTimestamp",
] as const satisfies ReadonlyArray<keyof SusdsYieldDailySnapshotRow>;

function snapshot(
  overrides: Partial<SusdsYieldDailySnapshotRow> = {},
): SusdsYieldDailySnapshotRow {
  return {
    id: "1-susds-1772668800",
    chainId: 1,
    token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
    timestamp: "1772668800",
    currentShares: "1000000000000000000",
    costBasisUsdWei: "1000000000000000000",
    realizedYieldUsdWei: "0",
    transferredOutYieldUsdWei: "0",
    redeemedYieldUsdWei: "0",
    currentValueUsdWei: "1100000000000000000",
    unrealizedYieldUsdWei: "100000000000000000",
    totalEarnedYieldUsdWei: "100000000000000000",
    dailyEarnedYieldUsdWei: "100000000000000000",
    dailyRealizedYieldUsdWei: "0",
    dailyUnrealizedYieldUsdWei: "100000000000000000",
    sharePriceUsdWei: "1100000000000000000",
    sampledAtBlock: "24000000",
    sampledAtTimestamp: "1772668800",
    ...overrides,
  };
}

const REQUIRED_FIELDS = Object.keys(snapshot()) as Array<
  keyof SusdsYieldDailySnapshotRow
>;

describe("sUSDS reserve snapshot validation", () => {
  it("accepts zero balances and yield totals", () => {
    const row = snapshot(
      Object.fromEntries(
        NONNEGATIVE_STRING_FIELDS.map((field) => [field, "0"]),
      ),
    );

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(true);
    expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(false);
  });

  it("accepts a snapshot with a negative unrealized daily delta", () => {
    const row = snapshot({ dailyUnrealizedYieldUsdWei: "-1" });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(true);
    expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(false);
  });

  it("accepts the configured sUSDS token address case-insensitively", () => {
    const row = snapshot({
      token: "0xA3931D71877C0E7A3148CB7EB4463524FEC27FBD",
    });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(true);
  });

  it("accepts whitespace around validated string values", () => {
    const row = snapshot({
      id: " 1-susds-1772668800 ",
      token: " 0xA3931D71877C0E7A3148CB7EB4463524FEC27FBD ",
      timestamp: " 1772668800 ",
      currentShares: " 1 ",
      dailyUnrealizedYieldUsdWei: " -1 ",
      sharePriceUsdWei: " 1 ",
      sampledAtBlock: " 1 ",
      sampledAtTimestamp: " 1772668801 ",
    });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(true);
  });

  it("accepts a sample within its UTC-day bucket", () => {
    const row = snapshot({ sampledAtTimestamp: "1772712000" });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(true);
  });

  it("accepts a sample at the last second of its UTC-day bucket", () => {
    const row = snapshot({ sampledAtTimestamp: "1772755199" });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(true);
  });

  it("rejects a snapshot bucket that does not contain its sample time", () => {
    const row = snapshot({ sampledAtTimestamp: "1772668799" });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
    expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(true);
  });

  it("rejects a sample at the start of the next UTC-day bucket", () => {
    const row = snapshot({ sampledAtTimestamp: "1772755200" });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
    expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(true);
  });

  it("rejects a snapshot for another token", () => {
    const row = snapshot({
      token: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
    expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(true);
  });

  it.each([...NONNEGATIVE_STRING_FIELDS, ...POSITIVE_STRING_FIELDS])(
    "rejects a negative %s value",
    (field) => {
      const row = snapshot({ [field]: "-1" });

      expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
      expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(true);
    },
  );

  it.each(POSITIVE_STRING_FIELDS)("rejects a zero %s value", (field) => {
    const row = snapshot({ [field]: "0" });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
    expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(true);
  });

  it.each([0, -1, 10])("rejects an unsupported chain ID (%s)", (chainId) => {
    const row = snapshot({ chainId });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
    expect(hasInvalidSusdsYieldDailySnapshotRow([row])).toBe(true);
  });

  it("rejects a timestamp outside the safe integer range", () => {
    const row = snapshot({ timestamp: "9007199254740992" });

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
  });

  it.each(REQUIRED_FIELDS)("rejects a missing %s field", (field) => {
    const row: Partial<Record<keyof SusdsYieldDailySnapshotRow, unknown>> = {
      ...snapshot(),
    };
    delete row[field];

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
  });

  it.each(REQUIRED_FIELDS)("rejects null for the %s field", (field) => {
    const row = { ...snapshot(), [field]: null };

    expect(isValidSusdsYieldDailySnapshotRow(row)).toBe(false);
  });
});
