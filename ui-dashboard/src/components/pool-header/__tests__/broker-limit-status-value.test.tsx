import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrokerLimitStatusValue } from "@/components/pool-header/broker-limit-status-value";
import {
  LIMIT_FLAG_L0,
  LIMIT_FLAG_L1,
  LIMIT_FLAG_LG,
  type BrokerLimitsState,
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

function render(overrides: Partial<BrokerLimitsState> = {}) {
  return renderToStaticMarkup(
    <BrokerLimitStatusValue
      state={{ rows: [], isLoading: false, hasError: false, ...overrides }}
    />,
  );
}

function progressBarCount(html: string): number {
  return html.split('role="progressbar"').length - 1;
}

describe("BrokerLimitStatusValue", () => {
  it("renders one mini-bar per enabled window of the tightest leg", () => {
    const html = render({
      rows: [
        row({ token: USDM, id: "usdm", limitPressureGlobal: "0.5000" }),
        row(),
      ],
    });

    expect(progressBarCount(html)).toBe(1);
    expect(html).toContain('aria-label="Global limit (LG)"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-valuetext="100%"');
    expect(html).toContain("LG ");
    expect(html).toContain("1.6K/1.6K");
  });

  it("renders up to three bars when every window is enabled", () => {
    const html = render({
      rows: [
        row({
          flags: LIMIT_FLAG_LG | LIMIT_FLAG_L0 | LIMIT_FLAG_L1,
          timestep0: "300",
          timestep1: "86400",
          limit0: "1000",
          limit1: "5000",
          netflow0: "-250",
          netflow1: "600",
          limitPressure0: "0.2500",
          limitPressure1: "0.1200",
        }),
      ],
    });

    expect(progressBarCount(html)).toBe(3);
    expect(html).toContain('aria-label="5-minute limit (L0)"');
    expect(html).toContain('aria-label="Daily limit (L1)"');
    expect(html).toContain("grid-cols-3");
    // Netflow is absolute for the "how close to the cap" reading.
    expect(html).toContain("250/1K");
  });

  it("marks a breached window without leaving the valid ARIA range", () => {
    const html = render({ rows: [row({ limitPressureGlobal: "1.2000" })] });

    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-valuetext="120% (over limit)"');
  });

  it("surfaces a query failure instead of a neutral dash", () => {
    expect(render({ hasError: true })).toContain("Query failed");
  });

  it("holds the grid slot invisibly while the first request is in flight", () => {
    const html = render({ isLoading: true });
    expect(html).toContain("invisible");
    expect(progressBarCount(html)).toBe(0);
  });

  it("shows a dash rather than a zeroed bar before config or state land", () => {
    expect(render()).toContain("—");
    expect(render({ rows: [row({ configKnown: false })] })).toContain("—");
    expect(
      progressBarCount(render({ rows: [row({ stateKnown: false })] })),
    ).toBe(0);
  });
});
