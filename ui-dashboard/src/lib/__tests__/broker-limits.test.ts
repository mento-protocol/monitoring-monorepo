import { describe, expect, it } from "vitest";
import {
  enabledWindows,
  formatWholeUnits,
  orderRowsByPoolTokens,
  windowLabel,
  worstBrokerRow,
  worstRowStatus,
  LIMIT_FLAG_L0,
  LIMIT_FLAG_L1,
  LIMIT_FLAG_LG,
} from "@/lib/broker-limits";
import type { BrokerTradingLimitRow } from "@/lib/types";

const AUDM = "0x7175504c455076f15c04a2f90a8e352281f492f9";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";

function row(
  overrides: Partial<BrokerTradingLimitRow> = {},
): BrokerTradingLimitRow {
  return {
    id: `42220-0xexchange-${overrides.token ?? AUDM}`,
    chainId: 42220,
    exchangeId:
      "0xd580d237231109e6a96d67d82450611c610a805a26660c90281bdc0cd04a95c7",
    exchangeProvider: "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901",
    limitId:
      "0xd580d237231109e6a96d67d855253150245af6ab7a62ae692295e92e51be073e",
    poolId: "42220-0x1d013077b00b28038a3f1e7a29aba34e12e562e9",
    token: AUDM,
    configKnown: true,
    // AUD today: global limit only, both timesteps zero.
    flags: LIMIT_FLAG_LG,
    timestep0: "0",
    timestep1: "0",
    limit0: "0",
    limit1: "0",
    limitGlobal: "1597",
    stateKnown: true,
    netflow0: "0",
    netflow1: "0",
    netflowGlobal: "-1596",
    lastUpdated0: "0",
    lastUpdated1: "0",
    stateBlock: "77563625",
    stateTimestamp: "1757840000",
    limitPressure0: "0.0000",
    limitPressure1: "0.0000",
    limitPressureGlobal: "0.9994",
    limitStatus: "WARN",
    updatedAtBlock: "77563625",
    updatedAtTimestamp: "1757840000",
    ...overrides,
  };
}

describe("windowLabel", () => {
  it("humanizes the configured timestep", () => {
    expect(windowLabel("300")).toBe("5-minute");
    expect(windowLabel("3600")).toBe("Hourly");
    expect(windowLabel("43200")).toBe("12-hour");
    expect(windowLabel("86400")).toBe("Daily");
    expect(windowLabel("172800")).toBe("2-day");
    expect(windowLabel("45")).toBe("45-second");
  });

  it("falls back to a neutral label for a zero or unusable timestep", () => {
    expect(windowLabel("0")).toBe("Rolling");
    expect(windowLabel("")).toBe("Rolling");
    expect(windowLabel("not-a-number")).toBe("Rolling");
  });
});

describe("enabledWindows", () => {
  it("returns only the global window for the AUD exchange (flags=4)", () => {
    const windows = enabledWindows(row());
    expect(windows).toHaveLength(1);
    expect(windows[0]?.key).toBe("global");
    expect(windows[0]?.label).toBe("Global limit (LG)");
    expect(windows[0]?.netflow).toBe("-1596");
    expect(windows[0]?.limit).toBe("1597");
    expect(windows[0]?.pressure).toBe("0.9994");
  });

  it("orders global first and labels L0/L1 from their timesteps", () => {
    const windows = enabledWindows(
      row({
        flags: LIMIT_FLAG_L0 | LIMIT_FLAG_L1 | LIMIT_FLAG_LG,
        timestep0: "300",
        timestep1: "86400",
        limit0: "100",
        limit1: "500",
      }),
    );
    expect(windows.map((window) => window.label)).toEqual([
      "Global limit (LG)",
      "5-minute limit (L0)",
      "Daily limit (L1)",
    ]);
  });

  it("drops a flagged window whose limit is zero", () => {
    const windows = enabledWindows(
      row({ flags: LIMIT_FLAG_L0 | LIMIT_FLAG_LG, timestep0: "300" }),
    );
    expect(windows.map((window) => window.key)).toEqual(["global"]);
  });

  it("drops a window whose flag bit is unset even with a limit configured", () => {
    const windows = enabledWindows(
      row({ flags: LIMIT_FLAG_LG, timestep0: "300", limit0: "100" }),
    );
    expect(windows.map((window) => window.key)).toEqual(["global"]);
  });

  it("returns nothing until the config has been read", () => {
    expect(enabledWindows(row({ configKnown: false }))).toEqual([]);
  });

  it("ignores an unparsable limit instead of throwing", () => {
    expect(enabledWindows(row({ limitGlobal: "" }))).toEqual([]);
  });
});

describe("formatWholeUnits", () => {
  it("groups whole token units without decimals", () => {
    expect(formatWholeUnits("1139")).toBe("1,139");
    expect(formatWholeUnits("1597")).toBe("1,597");
    expect(formatWholeUnits("0")).toBe("0");
  });

  it("never applies the FPMM 15-decimal scale", () => {
    // 1596 whole AUDm, not 0.0000000000016.
    expect(formatWholeUnits("1596")).toBe("1,596");
  });

  it("returns an em-dash for a non-numeric value", () => {
    expect(formatWholeUnits("not-a-number")).toBe("—");
  });
});

describe("worstRowStatus", () => {
  it("takes the worst indexed status across the legs", () => {
    expect(
      worstRowStatus([
        row({ limitStatus: "OK" }),
        row({ limitStatus: "CRITICAL" }),
      ]),
    ).toBe("CRITICAL");
    expect(
      worstRowStatus([
        row({ limitStatus: "WARN" }),
        row({ limitStatus: "OK" }),
      ]),
    ).toBe("WARN");
  });

  it("is N/A with no rows and with an unknown status", () => {
    expect(worstRowStatus([])).toBe("N/A");
    expect(worstRowStatus([row({ limitStatus: "PENDING" })])).toBe("N/A");
  });

  it("prefers a real OK over an N/A sibling leg", () => {
    expect(
      worstRowStatus([row({ limitStatus: "N/A" }), row({ limitStatus: "OK" })]),
    ).toBe("OK");
  });
});

describe("worstBrokerRow", () => {
  it("picks the leg under the most pressure", () => {
    const tighter = row({ token: AUDM, limitPressureGlobal: "0.9994" });
    const looser = row({
      token: USDM,
      id: "usdm",
      limitPressureGlobal: "0.9956",
    });
    expect(worstBrokerRow([looser, tighter])?.token).toBe(AUDM);
  });

  it("skips a config-known leg whose state is still unread", () => {
    // Both legs read 0.0000, so the first one wins on a `>` comparison. The
    // unread leg renders as "—" downstream, hiding the leg that has a reading.
    const unread = row({ token: AUDM, stateKnown: false });
    const read = row({ token: USDM, id: "usdm" });
    expect(worstBrokerRow([unread, read])?.token).toBe(USDM);
    expect(worstBrokerRow([unread])).toBeNull();
  });

  it("skips legs with no enabled window", () => {
    const unconfigured = row({ token: AUDM, configKnown: false });
    const configured = row({
      token: USDM,
      id: "usdm",
      limitPressureGlobal: "0.0000",
    });
    expect(worstBrokerRow([unconfigured, configured])?.token).toBe(USDM);
  });

  it("returns null when no leg has an enabled window", () => {
    expect(worstBrokerRow([row({ configKnown: false })])).toBeNull();
    expect(worstBrokerRow([])).toBeNull();
  });
});

describe("orderRowsByPoolTokens", () => {
  it("puts the token0 leg first whatever order Hasura returned", () => {
    const rows = [row({ token: AUDM }), row({ token: USDM, id: "usdm" })];
    expect(
      orderRowsByPoolTokens(rows, USDM.toUpperCase(), AUDM).map(
        (item) => item.token,
      ),
    ).toEqual([USDM, AUDM]);
  });

  it("keeps a leg that matches neither pool token, sorted last", () => {
    const other = row({ token: "0xother", id: "other" });
    const ordered = orderRowsByPoolTokens([other, row()], AUDM, USDM);
    expect(ordered.map((item) => item.token)).toEqual([AUDM, "0xother"]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ token: AUDM }), row({ token: USDM, id: "usdm" })];
    orderRowsByPoolTokens(rows, USDM, AUDM);
    expect(rows.map((item) => item.token)).toEqual([AUDM, USDM]);
  });
});
