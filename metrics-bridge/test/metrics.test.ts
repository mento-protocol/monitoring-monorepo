import { describe, it, expect, beforeEach, vi } from "vitest";
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
    chain_name: "celo",
    pair: "GBPm/USDm",
    pool_address_short: "0x8c00…cb56",
    block_explorer_url:
      "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
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

  it("skips deviationRatio when sentinel value -1", async () => {
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

  it("skips deviationRatio during no-data interval even with hasHealthData true", async () => {
    updateMetrics([
      makePool({
        hasHealthData: true,
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

  it("falls back to pool id when pair/chain/explorer are unknown", async () => {
    const unknownPool = makePool({
      id: "99999-0x1234567890abcdef1234567890abcdef12345678",
      chainId: 99999,
    });
    updateMetrics([unknownPool]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", {
        pool_id: "99999-0x1234567890abcdef1234567890abcdef12345678",
        chain_id: "99999",
        chain_name: "99999",
        pair: "99999-0x1234567890abcdef1234567890abcdef12345678",
        pool_address_short: "0x1234…5678",
        block_explorer_url: "",
      }),
    ).toBe(1);
  });

  it("handles multiple pools", async () => {
    const pool1 = makePool();
    const pool2 = makePool({
      id: "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
      // USDC/USDm pool
      token0: "0x765de816845861e75a25fca122bb6898b8b1282a",
      token1: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
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
        chain_name: "celo",
        pair: "USDC/USDm",
        pool_address_short: "0x462f…a19e",
        block_explorer_url:
          "https://celoscan.io/address/0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
      }),
    ).toBe(1);
  });

  it("attaches monad chain_name and monadscan explorer URL to Monad pools", async () => {
    const monadPool = makePool({
      id: "143-0x93e15a22fda39fefccce82d387a09ccf030ead61",
      chainId: 143,
      // EURmSpoke/USDmSpoke on Monad — canonicalizes to EURm/USDm.
      token0: "0x4d502d735b4c574b487ed641ae87ceae884731c7",
      token1: "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115",
    });
    updateMetrics([monadPool]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", {
        pool_id: "143-0x93e15a22fda39fefccce82d387a09ccf030ead61",
        chain_id: "143",
        chain_name: "monad",
        pair: "EURm/USDm",
        pool_address_short: "0x93e1…ad61",
        block_explorer_url:
          "https://monadscan.com/address/0x93e15a22fda39fefccce82d387a09ccf030ead61",
      }),
    ).toBe(1);
  });

  it("falls back to pool id for pair when tokens aren't in contracts.json but chain IS known (the real PR #209 scenario)", async () => {
    const pool = makePool({
      id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
      chainId: 42220,
      token0: "0xdeadbeef",
      token1: "0xfeedface",
    });
    updateMetrics([pool]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", {
        pool_id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
        chain_id: "42220",
        chain_name: "celo",
        pair: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
        pool_address_short: "0x8c00…cb56",
        block_explorer_url:
          "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
      }),
    ).toBe(1);
  });

  it("falls back to pool id when token0 or token1 is null (PoolRow nullable columns)", async () => {
    const pool = makePool({
      id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
      token0: null,
      token1: "0xccf663b1ff11028f0b19058d0f7b674004a40746",
    });
    updateMetrics([pool]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", {
        pool_id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
        chain_id: "42220",
        chain_name: "celo",
        pair: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
        pool_address_short: "0x8c00…cb56",
        block_explorer_url:
          "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
      }),
    ).toBe(1);
  });

  it("warns once per pool when derivation falls back (warnedUnknownPools dedup)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unknownChain = makePool({
        id: "88888-0xabc0000000000000000000000000000000000001",
        chainId: 88888,
      });
      updateMetrics([unknownChain]);
      updateMetrics([unknownChain]);
      updateMetrics([unknownChain]);
      const callsForThisPool = warn.mock.calls.filter(
        ([msg]) =>
          typeof msg === "string" &&
          msg.includes("88888-0xabc0000000000000000000000000000000000001"),
      );
      expect(callsForThisPool).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
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
