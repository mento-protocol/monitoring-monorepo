import { describe, it, expect, beforeEach } from "vitest";
import {
  register,
  gauges,
  counters,
  updateMetrics,
  healthStatusToNumber,
} from "../src/metrics.js";
import { makePool, getGaugeValue } from "./fixtures.js";

describe("healthStatusToNumber", () => {
  it("maps OK to 0", () => expect(healthStatusToNumber("OK")).toBe(0));
  it("maps WARN to 1", () => expect(healthStatusToNumber("WARN")).toBe(1));
  it("maps CRITICAL to 2", () =>
    expect(healthStatusToNumber("CRITICAL")).toBe(2));
  it("maps N/A to 3", () => expect(healthStatusToNumber("N/A")).toBe(3));
  it("maps unknown to 3", () =>
    expect(healthStatusToNumber("UNKNOWN")).toBe(3));
});

describe("updateMetrics", () => {
  const poolLabels = {
    pool_id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
    chain_id: "42220",
    pair: "USDm/GBPm",
  };

  beforeEach(() => {
    register.resetMetrics();
  });

  it("sets oracle_ok to 1 when oracleOk is true", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(1);
  });

  it("sets oracle_ok to 0 when oracleOk is false", async () => {
    updateMetrics([makePool({ oracleOk: false })]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(0);
  });

  it("parses oracleTimestamp from BigInt string", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_timestamp", poolLabels),
    ).toBe(1713200000);
  });

  it("parses oracleExpiry from BigInt string", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_expiry", poolLabels),
    ).toBe(300);
  });

  it("parses lastDeviationRatio from fixed-point string", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_deviation_ratio", poolLabels),
    ).toBe(0.42);
  });

  it("skips deviationRatio when hasHealthData is false", async () => {
    updateMetrics([
      makePool({
        hasHealthData: false,
        lastDeviationRatio: "-1",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_deviation_ratio", poolLabels),
    ).toBeUndefined();
  });

  it("sets deviationBreachStart to 0 when no breach", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_breach_start",
        poolLabels,
      ),
    ).toBe(0);
  });

  it("sets deviationBreachStart when breached", async () => {
    updateMetrics([makePool({ deviationBreachStartedAt: "1713200500" })]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_breach_start",
        poolLabels,
      ),
    ).toBe(1713200500);
  });

  it("sets limit pressure per token index", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_limit_pressure", {
        ...poolLabels,
        token_index: "0",
      }),
    ).toBeCloseTo(0.123);
    expect(
      await getGaugeValue(register, "mento_pool_limit_pressure", {
        ...poolLabels,
        token_index: "1",
      }),
    ).toBeCloseTo(0.005);
  });

  it("sets health_status from string enum", async () => {
    updateMetrics([makePool({ healthStatus: "CRITICAL" })]);
    expect(
      await getGaugeValue(register, "mento_pool_health_status", poolLabels),
    ).toBe(2);
  });

  it("sets lastRebalancedAt", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_last_rebalanced_at",
        poolLabels,
      ),
    ).toBe(1713199000);
  });

  it("falls back to pool id when pair is unknown", async () => {
    const unknownPool = makePool({ id: "99999-0xunknown", chainId: 99999 });
    updateMetrics([unknownPool]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", {
        pool_id: "99999-0xunknown",
        chain_id: "99999",
        pair: "99999-0xunknown",
      }),
    ).toBe(1);
  });

  it("handles multiple pools", async () => {
    const pool1 = makePool();
    const pool2 = makePool({
      id: "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
      healthStatus: "WARN",
    });
    updateMetrics([pool1, pool2]);

    expect(
      await getGaugeValue(register, "mento_pool_health_status", poolLabels),
    ).toBe(0);
    expect(
      await getGaugeValue(register, "mento_pool_health_status", {
        pool_id: "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
        chain_id: "42220",
        pair: "USDm/USDC",
      }),
    ).toBe(1);
  });
});

describe("self-monitoring gauges", () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it("bridgeLastPoll defaults to 0", async () => {
    expect(await getGaugeValue(register, "mento_pool_bridge_last_poll")).toBe(
      0,
    );
  });

  it("bridgeLastPoll can be set", async () => {
    gauges.bridgeLastPoll.set(1713200000);
    expect(await getGaugeValue(register, "mento_pool_bridge_last_poll")).toBe(
      1713200000,
    );
  });

  it("pollErrors counter increments", async () => {
    counters.pollErrors.inc();
    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find(
      (m) => m.name === "mento_pool_bridge_poll_errors_total",
    );
    expect(counter).toBeDefined();
    const value = (counter as { values: Array<{ value: number }> }).values[0]
      ?.value;
    expect(value).toBe(1);
  });
});
