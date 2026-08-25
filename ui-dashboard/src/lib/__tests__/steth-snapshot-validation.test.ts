import { describe, expect, it } from "vitest";
import { isValidStethYieldDailySnapshotRow } from "@/lib/canonical-revenue/steth-snapshot-validation";
import type { StethYieldDailySnapshotRow } from "@/lib/canonical-revenue/types";

const NONNEGATIVE_STRING_FIELDS = [
  "balanceAmount",
  "principalAmount",
  "realizedYieldAmount",
  "transferredOutYieldAmount",
  "unrealizedYieldAmount",
  "totalEarnedYieldAmount",
  "dailyEarnedYieldAmount",
  "dailyRealizedYieldAmount",
] as const satisfies ReadonlyArray<keyof StethYieldDailySnapshotRow>;

const POSITIVE_STRING_FIELDS = [
  "timestamp",
  "sampledAtBlock",
  "sampledAtTimestamp",
] as const satisfies ReadonlyArray<keyof StethYieldDailySnapshotRow>;

function snapshot(
  overrides: Partial<StethYieldDailySnapshotRow> = {},
): StethYieldDailySnapshotRow {
  return {
    id: "1-steth-wallet-1772668800",
    chainId: 1,
    token: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    wallet: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
    timestamp: "1772668800",
    balanceAmount: "1000000000000000000",
    principalAmount: "1000000000000000000",
    realizedYieldAmount: "0",
    transferredOutYieldAmount: "0",
    unrealizedYieldAmount: "100000000000000000",
    totalEarnedYieldAmount: "100000000000000000",
    dailyEarnedYieldAmount: "100000000000000000",
    dailyRealizedYieldAmount: "0",
    dailyUnrealizedYieldAmount: "100000000000000000",
    sampledAtBlock: "24000000",
    sampledAtTimestamp: "1772668800",
    ...overrides,
  };
}

const REQUIRED_FIELDS = Object.keys(snapshot()) as Array<
  keyof StethYieldDailySnapshotRow
>;

describe("stETH reserve snapshot validation", () => {
  it("accepts zero balances and yield totals", () => {
    const row = snapshot(
      Object.fromEntries(
        NONNEGATIVE_STRING_FIELDS.map((field) => [field, "0"]),
      ),
    );

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(true);
  });

  it("accepts whitespace, case-insensitive identifiers, and a signed daily delta", () => {
    const row = snapshot({
      id: " 1-steth-wallet-1772668800 ",
      token: " 0xAE7AB96520DE3A18E5E111B5EAAB095312D7FE84 ",
      wallet: " 0xD0697F70E79476195B742D5AFAB14BE50F98CC1E ",
      timestamp: " 1772668800 ",
      balanceAmount: " 1 ",
      dailyUnrealizedYieldAmount: " -1 ",
      sampledAtBlock: " 1 ",
      sampledAtTimestamp: " 1772668801 ",
    });

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(true);
  });

  it("accepts a sample within its UTC-day bucket", () => {
    const row = snapshot({ sampledAtTimestamp: "1772712000" });

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(true);
  });

  it("accepts a sample at the last second of its UTC-day bucket", () => {
    const row = snapshot({ sampledAtTimestamp: "1772755199" });

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(true);
  });

  it("rejects a snapshot bucket that does not contain its sample time", () => {
    const row = snapshot({ sampledAtTimestamp: "1772668799" });

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(false);
  });

  it("rejects a sample at the start of the next UTC-day bucket", () => {
    const row = snapshot({ sampledAtTimestamp: "1772755200" });

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(false);
  });

  it.each([...NONNEGATIVE_STRING_FIELDS, ...POSITIVE_STRING_FIELDS])(
    "rejects a negative %s value",
    (field) => {
      const row = snapshot({ [field]: "-1" });

      expect(isValidStethYieldDailySnapshotRow(row)).toBe(false);
    },
  );

  it.each(POSITIVE_STRING_FIELDS)("rejects a zero %s value", (field) => {
    const row = snapshot({ [field]: "0" });

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(false);
  });

  it.each([0, -1, 10])("rejects an unsupported chain ID (%s)", (chainId) => {
    expect(isValidStethYieldDailySnapshotRow(snapshot({ chainId }))).toBe(
      false,
    );
  });

  it("rejects another token or an untracked wallet", () => {
    expect(
      isValidStethYieldDailySnapshotRow(
        snapshot({
          token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
        }),
      ),
    ).toBe(false);
    expect(
      isValidStethYieldDailySnapshotRow(
        snapshot({ wallet: "0x0000000000000000000000000000000000000001" }),
      ),
    ).toBe(false);
  });

  it("rejects a timestamp outside the safe integer range", () => {
    expect(
      isValidStethYieldDailySnapshotRow(
        snapshot({ timestamp: "9007199254740992" }),
      ),
    ).toBe(false);
  });

  it.each(REQUIRED_FIELDS)("rejects a missing %s field", (field) => {
    const row: Partial<Record<keyof StethYieldDailySnapshotRow, unknown>> = {
      ...snapshot(),
    };
    delete row[field];

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(false);
  });

  it.each(REQUIRED_FIELDS)("rejects null for the %s field", (field) => {
    const row = { ...snapshot(), [field]: null };

    expect(isValidStethYieldDailySnapshotRow(row)).toBe(false);
  });
});
