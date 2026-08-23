import { describe, it, expect, beforeEach } from "vitest";
import { register } from "../src/metrics.js";
import { cdpGauges, updateCdpMetrics } from "../src/cdp-metrics.js";
import { getGaugeValue, getMetricValues } from "./fixtures.js";
import type { CdpInstance } from "../src/types.js";

// GBPm prod-shaped row: 18-decimal debt token, SP healthy, no shutdown.
function makeCdp(
  overrides: {
    instance?: Partial<CdpInstance["instance"]>;
    collateral?: Partial<CdpInstance["collateral"]>;
  } = {},
): CdpInstance {
  return {
    instance: {
      id: "42220-0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
      collateralId: "42220-0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
      chainId: 42220,
      systemDebt: "305501174571211348688277", // ~305_501 GBPm
      spDeposits: "9216312198471370821833", // ~9_216 GBPm
      spHeadroom: "9215312198471370821833", // deposits − 1 floor
      isShutDown: false,
      liqCountCum: 0,
      redemptionCountCum: 395,
      rebalanceRedemptionCountCum: 394,
      shortfallSubsidyCum: "0",
      ...overrides.instance,
    },
    collateral: {
      id: "42220-0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
      symbol: "GBPm",
      chainId: 42220,
      troveManager: "0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
      debtToken: "0x0000000000000000000000000000000000000001",
      systemParamsLoaded: true,
      ...overrides.collateral,
    },
  };
}

const labels = {
  symbol: "GBPm",
  chain_id: "42220",
  chain_name: "celo",
  collateral_id: "42220-0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
};

describe("updateCdpMetrics", () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it("starts with no successful CDP poll", async () => {
    expect(
      await getGaugeValue(register, "mento_cdp_last_successful_poll"),
    ).toBe(0);
  });

  it("marks both loaded and incomplete rows fresh when publication succeeds", async () => {
    updateCdpMetrics(
      [
        makeCdp(),
        makeCdp({
          instance: {
            id: "42220-0x2222222222222222222222222222222222222222",
            collateralId: "42220-0x2222222222222222222222222222222222222222",
          },
          collateral: {
            id: "42220-0x2222222222222222222222222222222222222222",
            symbol: "CHFm",
            troveManager: "0x2222222222222222222222222222222222222222",
            systemParamsLoaded: false,
          },
        }),
      ],
      100,
    );

    expect(
      await getGaugeValue(register, "mento_cdp_last_successful_poll"),
    ).toBe(100);
    expect(
      await getGaugeValue(register, "mento_cdp_system_params_loaded", labels),
    ).toBe(1);
    expect(
      (await getMetricValues(register, "mento_cdp_system_params_loaded")).find(
        (series) => series.labels.symbol === "CHFm",
      )?.value,
    ).toBe(0);
  });

  it("sets shutdown 0 when not shut down, 1 when shut down", async () => {
    updateCdpMetrics([makeCdp()]);
    expect(await getGaugeValue(register, "mento_cdp_shutdown", labels)).toBe(0);

    updateCdpMetrics([makeCdp({ instance: { isShutDown: true } })]);
    expect(await getGaugeValue(register, "mento_cdp_shutdown", labels)).toBe(1);
  });

  it("publishes SystemParams readiness as a binary gauge", async () => {
    updateCdpMetrics([makeCdp()]);
    expect(
      await getGaugeValue(register, "mento_cdp_system_params_loaded", labels),
    ).toBe(1);

    updateCdpMetrics([makeCdp({ collateral: { systemParamsLoaded: false } })]);
    expect(
      await getGaugeValue(register, "mento_cdp_system_params_loaded", labels),
    ).toBe(0);
  });

  it("keeps SystemParams labels bounded to the existing CDP label set", async () => {
    updateCdpMetrics([makeCdp()]);
    const [series] = await getMetricValues(
      register,
      "mento_cdp_system_params_loaded",
    );
    expect(Object.keys(series.labels).sort()).toEqual([
      "block_explorer_url",
      "chain_id",
      "chain_name",
      "collateral_id",
      "symbol",
    ]);
  });

  it("converts token-denominated columns to human units", async () => {
    updateCdpMetrics([makeCdp()]);
    expect(
      await getGaugeValue(register, "mento_cdp_sp_deposits", labels),
    ).toBeCloseTo(9216.312, 2);
    expect(
      await getGaugeValue(register, "mento_cdp_system_debt", labels),
    ).toBeCloseTo(305501.17, 1);
    // headroom = deposits − MIN_BOLD_IN_SP (1 token for GBPm)
    expect(
      await getGaugeValue(register, "mento_cdp_sp_headroom", labels),
    ).toBeCloseTo(9215.312, 2);
  });

  it("reports user redemptions as total minus rebalance subset (never negative)", async () => {
    updateCdpMetrics([makeCdp()]); // 395 − 394 = 1
    expect(
      await getGaugeValue(register, "mento_cdp_user_redemption_total", labels),
    ).toBe(1);

    // Defensive clamp: rebalance count temporarily exceeding total must not
    // emit a negative gauge.
    updateCdpMetrics([
      makeCdp({
        instance: { redemptionCountCum: 10, rebalanceRedemptionCountCum: 13 },
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_cdp_user_redemption_total", labels),
    ).toBe(0);
  });

  it("publishes a NEGATIVE headroom for a sub-microtoken floor breach (sign preserved below toHumanUnits precision)", async () => {
    // deposits 1 wei below MIN_BOLD_IN_SP → headroom = -1 wei. toHumanUnits
    // truncates |x| < 1e-6 to 0; without sign preservation the < 0 critical
    // rule would never fire on a genuine just-below-floor breach.
    updateCdpMetrics([
      makeCdp({
        instance: { spHeadroom: "-1" },
        collateral: { systemParamsLoaded: true },
      }),
    ]);
    const headroom = await getGaugeValue(
      register,
      "mento_cdp_sp_headroom",
      labels,
    );
    expect(headroom).toBeLessThan(0);
  });

  it("publishes a POSITIVE shortfall total for a sub-microtoken subsidy (so increase() > 0 fires)", async () => {
    // First RedemptionShortfallSubsidized adds 1 wei. toHumanUnits truncates it
    // to 0; without dust preservation increase(shortfall_total[6h]) stays 0 and
    // the critical "protocol absorbed a loss" rule never fires.
    updateCdpMetrics([makeCdp({ instance: { shortfallSubsidyCum: "1" } })]);
    expect(
      await getGaugeValue(
        register,
        "mento_cdp_shortfall_subsidy_total",
        labels,
      ),
    ).toBeGreaterThan(0);
  });

  it("keeps successive sub-microtoken shortfall increments distinct (monotonic, so increase() catches each)", async () => {
    // 1 wei → 2 wei, both well below 1e-6 tokens. The exported sample must
    // change so increase(shortfall_total[6h]) > 0 catches the second loss too.
    updateCdpMetrics([makeCdp({ instance: { shortfallSubsidyCum: "1" } })]);
    const first = (await getGaugeValue(
      register,
      "mento_cdp_shortfall_subsidy_total",
      labels,
    )) as number;
    updateCdpMetrics([makeCdp({ instance: { shortfallSubsidyCum: "2" } })]);
    const second = (await getGaugeValue(
      register,
      "mento_cdp_shortfall_subsidy_total",
      labels,
    )) as number;
    expect(second).toBeGreaterThan(first);
  });

  it("withholds the headroom gauge until SystemParams is loaded (sentinel guard)", async () => {
    updateCdpMetrics([
      makeCdp({
        instance: { spHeadroom: "-1" },
        collateral: { systemParamsLoaded: false },
      }),
    ]);
    // No series — so the critical 'below floor' rule cannot read −1 wei as a breach.
    expect(
      await getGaugeValue(register, "mento_cdp_sp_headroom", labels),
    ).toBeUndefined();
    // Other gauges still publish.
    expect(await getGaugeValue(register, "mento_cdp_shutdown", labels)).toBe(0);
    expect(
      await getGaugeValue(register, "mento_cdp_system_params_loaded", labels),
    ).toBe(0);
  });

  it("evicts series for markets that drop out of the response", async () => {
    updateCdpMetrics([makeCdp()], 100);
    expect((await getMetricValues(register, "mento_cdp_shutdown")).length).toBe(
      1,
    );
    updateCdpMetrics([], 130);
    expect((await getMetricValues(register, "mento_cdp_shutdown")).length).toBe(
      0,
    );
    expect(
      await getGaugeValue(register, "mento_cdp_last_successful_poll"),
    ).toBe(130);
  });

  it("throws on a malformed row BEFORE clearing the registry (no silent all-clear)", async () => {
    // Seed a known-good poll.
    updateCdpMetrics([makeCdp()], 100);
    expect(await getGaugeValue(register, "mento_cdp_shutdown", labels)).toBe(0);

    // A row with an unparsable BigInt must throw during preparation, leaving
    // the previously-published series intact (the poll loop logs cdp_update and
    // retries next cycle) — never a half-cleared registry that no_data_state=OK
    // would read as an all-clear.
    expect(() =>
      updateCdpMetrics([makeCdp({ instance: { systemDebt: "not-a-number" } })]),
    ).toThrow();
    expect(await getGaugeValue(register, "mento_cdp_shutdown", labels)).toBe(0);
    expect(
      await getGaugeValue(register, "mento_cdp_system_debt", labels),
    ).toBeCloseTo(305501.17, 1);
    expect(
      await getGaugeValue(register, "mento_cdp_system_params_loaded", labels),
    ).toBe(1);
    expect(
      await getGaugeValue(register, "mento_cdp_last_successful_poll"),
    ).toBe(100);
  });

  it("keeps the restart timestamp at zero when the first update is malformed", async () => {
    expect(() =>
      updateCdpMetrics(
        [makeCdp({ instance: { systemDebt: "not-a-number" } })],
        100,
      ),
    ).toThrow();
    expect(
      await getGaugeValue(register, "mento_cdp_last_successful_poll"),
    ).toBe(0);
  });

  it("retains the last successful publication while a malformed update ages", async () => {
    updateCdpMetrics(
      [makeCdp({ collateral: { systemParamsLoaded: false } })],
      100,
    );
    expect(() =>
      updateCdpMetrics(
        [makeCdp({ instance: { systemDebt: "not-a-number" } })],
        130,
      ),
    ).toThrow();

    expect(
      await getGaugeValue(register, "mento_cdp_system_params_loaded", labels),
    ).toBe(0);
    expect(
      await getGaugeValue(register, "mento_cdp_last_successful_poll"),
    ).toBe(100);
  });

  it("updates freshness across incomplete-to-loaded recovery", async () => {
    updateCdpMetrics(
      [makeCdp({ collateral: { systemParamsLoaded: false } })],
      100,
    );
    updateCdpMetrics([makeCdp()], 160);

    expect(
      await getGaugeValue(register, "mento_cdp_system_params_loaded", labels),
    ).toBe(1);
    expect(
      await getGaugeValue(register, "mento_cdp_last_successful_poll"),
    ).toBe(160);
  });

  it("carries a TroveManager block-explorer deep link", async () => {
    updateCdpMetrics([makeCdp()]);
    const [series] = await getMetricValues(register, "mento_cdp_shutdown");
    expect(series.labels.block_explorer_url).toBe(
      "https://celoscan.io/address/0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
    );
  });
});

describe("cdpGauges", () => {
  it("registers every gauge under the mento_cdp_ namespace", () => {
    for (const gauge of Object.values(cdpGauges)) {
      // prom-client stores the configured name on the gauge.
      expect((gauge as unknown as { name: string }).name).toMatch(
        /^mento_cdp_/,
      );
    }
  });
});
