import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  register,
  gauges,
  counters,
  updateMetrics,
  healthStatusToNumber,
  isOracleLive,
} from "../src/metrics.js";
import { resetDeviationAlertStateForTests } from "../src/deviation-alert-state.js";
import { makePool, getGaugeValue, getMetricValues } from "./fixtures.js";

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
  const DEFAULT_NOW_SECONDS = 1713200100;
  const poolLabels = {
    pool_id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
    chain_id: "42220",
    chain_name: "celo",
    pair: "GBPm/USDm",
    pool_address_short: "0x8c00…cb56",
    block_explorer_url:
      "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
  };
  const oracleLabels = {
    ...poolLabels,
    last_oracle_update_url:
      "https://celoscan.io/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DEFAULT_NOW_SECONDS * 1000));
    register.resetMetrics();
    resetDeviationAlertStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets oracle_ok to 1 when oracleOk is true and the report is fresh", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(1);
  });

  it("publishes virtual-pool oracle freshness from the VP freshness window", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBe(1);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBeUndefined();
  });

  it("marks virtual-pool oracle freshness stale after the VP window", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 600),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBe(0);
  });

  it("suppresses virtual-pool oracle freshness while the VP cursor is untrusted", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        tokenDecimalsKnown: false,
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 600),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("suppresses invalid VirtualPool medians while token decimals are unknown", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        tokenDecimalsKnown: false,
        medianLive: false,
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("suppresses known VirtualPool quorum failures while token decimals are unknown", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        tokenDecimalsKnown: false,
        medianLive: true,
        oracleNumReporters: 1,
        wrappedExchangeMinimumReports: "2",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("keeps missing VirtualPool median inputs unknown", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        medianLive: undefined,
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("uses the live VP oracle cursor when median updates lag flat reports", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        lastOracleReportAt: String(DEFAULT_NOW_SECONDS - 600),
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBe(1);
  });

  it("marks virtual-pool oracle freshness stale when the live median is invalid", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        medianLive: false,
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBe(0);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBe(0);
  });

  it("marks virtual-pool oracle freshness stale when reporters are below minimumReports", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        oracleNumReporters: 2,
        wrappedExchangeMinimumReports: "3",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBe(0);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBe(0);
  });

  it("suppresses virtual-pool oracle freshness when reporter count is unknown", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        oracleNumReporters: -1,
        wrappedExchangeMinimumReports: "3",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("suppresses virtual-pool oracle freshness for deprecated wrappers", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 600),
        oracleFreshnessWindow: "360",
        wrappedExchangeDeprecated: true,
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("skips virtual-pool oracle freshness when the VP window is unknown", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 600),
        oracleFreshnessWindow: "0",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("skips virtual-pool oracle freshness when minimumReports is unknown", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        wrappedExchangeMinimumReports: "0",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("suppresses invalid median when minimumReports is unknown", async () => {
    updateMetrics([
      makePool({
        source: "virtual_pool_factory",
        wrappedExchangeId:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        medianLive: false,
        wrappedExchangeMinimumReports: "0",
        oracleTimestamp: String(DEFAULT_NOW_SECONDS - 120),
        oracleFreshnessWindow: "360",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_vp_oracle_fresh", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_vp_oracle_median_valid",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("sets oracle_contract_ok to the raw event-time contract flag", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_contract_ok",
        poolLabels,
      ),
    ).toBe(1);
  });

  it("sets oracle_ok to 0 when oracleOk is false", async () => {
    updateMetrics([makePool({ oracleOk: false })]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(0);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_contract_ok",
        poolLabels,
      ),
    ).toBe(0);
  });

  it("sets oracle_ok to 0 when the last report has crossed expiry", async () => {
    updateMetrics([makePool()], 1713200301);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(0);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_contract_ok",
        poolLabels,
      ),
    ).toBe(1);
  });

  it("keeps oracle_ok at 1 at the exact expiry boundary", async () => {
    updateMetrics([makePool()], 1713200300);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(1);
  });

  it("honors a one-year expiry for sparse Polygon FX feeds", () => {
    expect(
      isOracleLive(
        makePool({
          chainId: 137,
          oracleExpiry: "31536000",
          lastOracleReportAt: String(DEFAULT_NOW_SECONDS - 6 * 86_400),
        }),
        DEFAULT_NOW_SECONDS,
      ),
    ).toBe(true);
  });

  it("uses the exact median timestamp for freshness while keeping the raw timestamp diagnostic", async () => {
    updateMetrics(
      [
        makePool({
          oracleTimestamp: "1713200099",
          lastOracleReportAt: "1713200000",
        }),
      ],
      1713200001,
    );
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_live_timestamp",
        poolLabels,
      ),
    ).toBe(1713200000);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_timestamp", {
        ...poolLabels,
        last_oracle_update_url:
          "https://celoscan.io/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toBe(1713200099);
  });

  it("uses the Celo fallback expiry when indexed expiry is unavailable", async () => {
    updateMetrics([makePool({ oracleExpiry: "0" })], DEFAULT_NOW_SECONDS);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(1);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_expiry", oracleLabels),
    ).toBe(300);
  });

  it("marks reports stale after the Celo fallback expiry", async () => {
    updateMetrics(
      [
        makePool({
          oracleExpiry: "0",
          lastOracleReportAt: String(DEFAULT_NOW_SECONDS - 301),
        }),
      ],
      DEFAULT_NOW_SECONDS,
    );
    expect(
      await getGaugeValue(register, "mento_pool_oracle_ok", poolLabels),
    ).toBe(0);
  });

  it("uses the Monad fallback expiry for zero-expiry live checks", () => {
    expect(
      isOracleLive(
        makePool({
          chainId: 143,
          oracleExpiry: "0",
          lastOracleReportAt: String(DEFAULT_NOW_SECONDS - 360),
        }),
        DEFAULT_NOW_SECONDS,
      ),
    ).toBe(true);
    expect(
      isOracleLive(
        makePool({
          chainId: 143,
          oracleExpiry: "0",
          lastOracleReportAt: String(DEFAULT_NOW_SECONDS - 361),
        }),
        DEFAULT_NOW_SECONDS,
      ),
    ).toBe(false);
  });

  it("publishes FX weekend market pause during the closed window", async () => {
    const fridayClose = Date.UTC(2024, 3, 19, 21, 0, 0) / 1000;
    updateMetrics([makePool()], fridayClose);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_market_pause", {
        ...poolLabels,
        reason: "fx_weekend_closed",
      }),
    ).toBe(1);
  });

  it("publishes FX reopen grace after the weekend gate drops", async () => {
    const sundayReopen = Date.UTC(2024, 3, 21, 23, 0, 0) / 1000;
    updateMetrics([makePool()], sundayReopen);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_market_pause", {
        ...poolLabels,
        reason: "fx_reopen_grace",
      }),
    ).toBe(1);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_market_pause", {
        ...poolLabels,
        reason: "fx_weekend_closed",
      }),
    ).toBeUndefined();
  });

  it("does not publish FX market pause after reopen grace", async () => {
    const afterGrace = Date.UTC(2024, 3, 22, 0, 0, 0) / 1000;
    updateMetrics([makePool()], afterGrace);
    expect(
      await getMetricValues(register, "mento_pool_oracle_market_pause"),
    ).toHaveLength(0);
  });

  it("does not market-pause USD-pegged pools or malformed pair labels", async () => {
    const fridayClose = Date.UTC(2024, 3, 19, 21, 0, 0) / 1000;
    updateMetrics(
      [
        makePool({
          id: "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
          token0: "0x765de816845861e75a25fca122bb6898b8b1282a",
          token1: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
        }),
        makePool({
          id: "42220-0xdeadbeef00000000000000000000000000000000",
          token0: "0xdeadbeef00000000000000000000000000000000",
          token1: "0xfeedface00000000000000000000000000000000",
        }),
      ],
      fridayClose,
    );
    expect(
      await getMetricValues(register, "mento_pool_oracle_market_pause"),
    ).toHaveLength(0);
  });

  it("parses oracleTimestamp from BigInt string", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_timestamp",
        oracleLabels,
      ),
    ).toBe(1713200000);
  });

  it("parses the live oracle timestamp from the exact median anchor", async () => {
    updateMetrics([makePool({ lastOracleReportAt: "1713199900" })]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_live_timestamp",
        poolLabels,
      ),
    ).toBe(1713199900);
  });

  it("leaves oracle update URL empty when oracleTxHash is absent", async () => {
    updateMetrics([makePool({ oracleTxHash: "" })]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_timestamp", {
        ...poolLabels,
        last_oracle_update_url: "",
      }),
    ).toBe(1713200000);
  });

  it("parses oracleExpiry from BigInt string", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_expiry", oracleLabels),
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

  it("parses lastEffectivenessRatio from fixed-point string", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_rebalance_effectiveness",
        poolLabels,
      ),
    ).toBe(0.5);
  });

  it("skips rebalanceEffectiveness when sentinel value -1", async () => {
    updateMetrics([makePool({ lastEffectivenessRatio: "-1" })]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_rebalance_effectiveness",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("publishes negative effectiveness (rebalance made deviation WORSE)", async () => {
    // Legitimate signal — the indexer's helper returns "-1" as the no-data
    // sentinel, so any other negative value is a real observation. Filtering
    // those out would hide the worst failure mode from the alert.
    updateMetrics([makePool({ lastEffectivenessRatio: "-0.3000" })]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_rebalance_effectiveness",
        poolLabels,
      ),
    ).toBe(-0.3);
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

  it("publishes exactly one deviation alert state per pool", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200900,
    );

    const stateValues = await getMetricValues(
      register,
      "mento_pool_deviation_alert_state",
    );
    expect(stateValues).toHaveLength(1);
    expect(stateValues[0]?.labels).toMatchObject({
      ...poolLabels,
      state: "warning",
    });
    expect(stateValues[0]?.value).toBe(1);
  });

  it("increments a recovered transition once and exposes formatted transition labels", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200300,
    );
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBeUndefined();

    updateMetrics([makePool({ lastDeviationRatio: "1.000000" })], 1713203660);

    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transition_active",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
          breach_started_at: "Mon Apr 15 16:53 UTC",
          breach_ended_at: "Mon Apr 15 17:54 UTC",
          breach_duration: "1h 1m",
        },
      ),
    ).toBe(1);

    updateMetrics([makePool({ lastDeviationRatio: "1.000000" })], 1713203690);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBe(1);
  });

  it("does not emit a recovery transition for a warning breach that never fired", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200000,
    );
    updateMetrics([makePool({ lastDeviationRatio: "1.000000" })], 1713200600);

    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transition_active",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBeUndefined();
  });

  it("does not inherit breach age after FX weekend suppression reopens", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713564000",
        }),
      ],
      1713564000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713564000",
        }),
      ],
      1713740400,
    );
    updateMetrics([makePool({ lastDeviationRatio: "1.000000" })], 1713740700);

    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBeUndefined();
  });

  it("does not emit a restored transition when anchored warning never fired", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "-1",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200300,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200960,
    );

    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "deviation_ratio_unavailable_warning",
          reason: "deviation_ratio_unavailable",
        },
      ),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "deviation_ratio_unavailable_warning",
          to: "warning",
          reason: "deviation_ratio_restored",
        },
      ),
    ).toBeUndefined();
  });

  it("records warning to critical escalation when the critical alert can fire", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713200000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713203661,
    );

    expect(
      await getGaugeValue(register, "mento_pool_deviation_alert_state", {
        ...poolLabels,
        state: "critical",
      }),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "critical",
          reason: "escalated_to_critical",
        },
      ),
    ).toBe(1);
  });

  it("records data restoration without pretending critical already escalated", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "-1",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713203000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713203900,
    );

    expect(
      await getGaugeValue(register, "mento_pool_deviation_alert_state", {
        ...poolLabels,
        state: "warning",
      }),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "deviation_ratio_unavailable_warning",
          to: "warning",
          reason: "deviation_ratio_restored",
        },
      ),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "deviation_ratio_unavailable_warning",
          to: "critical",
          reason: "escalated_to_critical",
        },
      ),
    ).toBeUndefined();

    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713203961,
    );

    expect(
      await getGaugeValue(register, "mento_pool_deviation_alert_state", {
        ...poolLabels,
        state: "critical",
      }),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "critical",
          reason: "escalated_to_critical",
        },
      ),
    ).toBeUndefined();
  });

  it("does not emit critical-tier transitions for a brief critical spike", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713203661,
    );

    expect(
      await getGaugeValue(register, "mento_pool_deviation_alert_state", {
        ...poolLabels,
        state: "warning",
      }),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "critical",
          reason: "escalated_to_critical",
        },
      ),
    ).toBeUndefined();

    updateMetrics([makePool({ lastDeviationRatio: "1.000000" })], 1713203690);

    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "critical",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "ok",
          reason: "recovered",
        },
      ),
    ).toBe(1);
  });

  it("records critical de-escalation to warning during peak-ratio rollout gaps", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713203000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713203900,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713203960,
    );

    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "critical",
          to: "warning",
          reason: "deescalated_to_warning",
        },
      ),
    ).toBe(1);
  });

  it("keeps critical readiness when deviation-ratio data disappears", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713200000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.060000",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713203661,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "-1",
          deviationBreachStartedAt: "1713200000",
          currentOpenBreachPeak: "10600",
          currentOpenBreachEntryThreshold: 10000,
        }),
      ],
      1713203720,
    );

    expect(
      await getGaugeValue(register, "mento_pool_deviation_alert_state", {
        ...poolLabels,
        state: "deviation_ratio_unavailable_critical",
      }),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "critical",
          to: "deviation_ratio_unavailable_warning",
          reason: "deescalated_to_warning",
        },
      ),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "critical",
          to: "deviation_ratio_unavailable_critical",
          reason: "deviation_ratio_unavailable",
        },
      ),
    ).toBe(1);
  });

  it("records deviation-ratio unavailable and restored transitions", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200000,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "-1",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713200960,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713200000",
        }),
      ],
      1713201861,
    );

    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "deviation_ratio_unavailable_warning",
          reason: "deviation_ratio_unavailable",
        },
      ),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "deviation_ratio_unavailable_warning",
          to: "warning",
          reason: "deviation_ratio_restored",
        },
      ),
    ).toBe(1);

    const activeTransitions = await getMetricValues(
      register,
      "mento_pool_deviation_alert_transition_active",
    );
    expect(activeTransitions).toHaveLength(1);
    expect(activeTransitions[0]?.labels).toMatchObject({
      ...poolLabels,
      from: "deviation_ratio_unavailable_warning",
      to: "warning",
      reason: "deviation_ratio_restored",
    });
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transition_active",
        {
          ...poolLabels,
          from: "warning",
          to: "deviation_ratio_unavailable_warning",
          reason: "deviation_ratio_unavailable",
        },
      ),
    ).toBeUndefined();
  });

  it("records FX weekend suppression for FX pairs", async () => {
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713556800",
        }),
      ],
      1713556800,
    );
    updateMetrics(
      [
        makePool({
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713556800",
        }),
      ],
      1713564000,
    );

    expect(
      await getGaugeValue(register, "mento_pool_deviation_alert_state", {
        ...poolLabels,
        state: "fx_paused",
      }),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_alert_transitions_total",
        {
          ...poolLabels,
          from: "warning",
          to: "fx_paused",
          reason: "fx_weekend_suppressed",
        },
      ),
    ).toBe(1);
  });

  it("does not pause USD-pegged pools during the FX weekend window", async () => {
    updateMetrics(
      [
        makePool({
          token1: "0xeb466342c4d449bc9f53a865d5cb90586f405215",
          lastDeviationRatio: "1.020000",
          deviationBreachStartedAt: "1713556800",
        }),
      ],
      1713564000,
    );

    const stateValues = await getMetricValues(
      register,
      "mento_pool_deviation_alert_state",
    );
    expect(stateValues).toHaveLength(1);
    expect(stateValues[0]?.labels).toMatchObject({
      pair: "axlUSDC/USDm",
      state: "warning",
    });
  });

  it("publishes open-breach peak ratio when entry threshold is known", async () => {
    updateMetrics([
      makePool({
        deviationBreachStartedAt: "1713200500",
        currentOpenBreachPeak: "15000",
        currentOpenBreachEntryThreshold: 5000,
      }),
    ]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_open_breach_peak_ratio",
        poolLabels,
      ),
    ).toBe(3);
  });

  it("uses the legacy entry-threshold floor when open-breach entry threshold is absent", async () => {
    updateMetrics([
      makePool({
        deviationBreachStartedAt: "1713200500",
        currentOpenBreachPeak: "15000",
        currentOpenBreachEntryThreshold: 0,
      }),
    ]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_open_breach_peak_ratio",
        poolLabels,
      ),
    ).toBe(1.5);
  });

  it("skips open-breach peak ratio when peak is absent", async () => {
    updateMetrics([
      makePool({
        deviationBreachStartedAt: "1713200500",
        currentOpenBreachPeak: "0",
        currentOpenBreachEntryThreshold: 0,
      }),
    ]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_deviation_open_breach_peak_ratio",
        poolLabels,
      ),
    ).toBeUndefined();
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

  it("computes reserve share for balanced 50/50 pool", async () => {
    updateMetrics([makePool()]);
    // Default fixture is GBPm/USDm on Celo — see fixtures.ts. token0 is
    // USDm (0x765de8…1282a), token1 is GBPm (0xccf663b1…0746); `pair`
    // reorders so USDm is last, but the gauge labels track on-chain
    // token0/token1 order. The reserve-share gauges carry an extra
    // `token_symbol` label (consumed by the deviation-breach Slack alert
    // via `$values.R0.Labels.token_symbol`).
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        ...poolLabels,
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.5);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token1", {
        ...poolLabels,
        token_symbol: "GBPm",
      }),
    ).toBeCloseTo(0.5);
  });

  it("normalizes mismatched decimals before computing reserve share (USDC 6dp / USDm 18dp)", async () => {
    // Both legs equal 1.0 after normalization (1 USDC at 6dp = 10^6;
    // 1 USDm at 18dp = 10^18). Expected share is 50/50. Without decimal
    // normalization, the raw ratio would be ~1e6 / ~(1e6 + 1e18) ≈ 1e-12
    // — `toBeCloseTo(0.5, 4)` would clearly fail. The earlier 17/83
    // fixture passed with or without normalization for small numerators
    // and was a weak guard.
    updateMetrics([
      makePool({
        reserves0: "1000000",
        reserves1: "1000000000000000000",
        token0Decimals: 6,
        token1Decimals: 18,
      }),
    ]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token0",
        poolLabels,
      ),
    ).toBeCloseTo(0.5, 4);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token1",
        poolLabels,
      ),
    ).toBeCloseTo(0.5, 4);
  });

  it("emits 1.0/0.0 for one-sided pool (single reserve zero) — diagnostic signal", async () => {
    // A pool drained of one side IS exactly the imbalance the alert wants
    // to render ("100% USDT / 0% USDm"), so we keep the series.
    updateMetrics([
      makePool({
        reserves0: "1000000000000000000",
        reserves1: "0",
      }),
    ]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token0",
        poolLabels,
      ),
    ).toBe(1);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token1",
        poolLabels,
      ),
    ).toBe(0);
  });

  it("emits 0.0/1.0 for one-sided pool drained on token0 (mirror direction)", async () => {
    // Mirror of the previous test — covers `reserves0 = 0`, `reserves1 > 0`.
    updateMetrics([
      makePool({
        reserves0: "0",
        reserves1: "1000000000000000000",
      }),
    ]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token0",
        poolLabels,
      ),
    ).toBe(0);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token1",
        poolLabels,
      ),
    ).toBe(1);
  });

  it("skips reserve share when both reserves are zero (share undefined)", async () => {
    updateMetrics([
      makePool({
        reserves0: "0",
        reserves1: "0",
      }),
    ]);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token0",
        poolLabels,
      ),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_reserve_share_token1",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  // PR #234 review (Codex / Cursor): the reserve-share annotation queries
  // (data blocks R0 and R1 on deviation-breach rules) are matched
  // per-instance against the firing alert's label fingerprint. If the
  // gauge's pool-fingerprint label subset diverges from
  // `mento_pool_deviation_ratio`'s, Grafana silently returns nil for
  // `$values.R0` / `$values.R1` and the `current_reserves` annotation
  // never renders.
  //
  // The reserve-share gauges intentionally carry one EXTRA label
  // (`token_symbol`) beyond the deviation-ratio gauge's set — consumed
  // via `$values.R0.Labels.token_symbol` in the alert annotation. That's
  // safe because `token_symbol` is 1:1 with `pool_id` (each pool has one
  // token0 and one token1), so it doesn't widen the firing series'
  // cardinality or the per-instance match. This test locks the invariant
  // that the reserve-share gauges' labels are a STRICT SUPERSET of the
  // deviation-ratio gauge's, with `token_symbol` as the only extension.
  it("label-shape parity: reserve-share gauges expose deviation-ratio labels plus token_symbol", async () => {
    updateMetrics([makePool()]);
    const json = await register.getMetricsAsJSON();
    type MetricEntry = {
      name: string;
      values?: Array<{ labels: Record<string, string> }>;
    };
    const labelKeysFor = (name: string): string[] | undefined => {
      const m = json.find((x) => (x as MetricEntry).name === name) as
        | MetricEntry
        | undefined;
      const sample = m?.values?.[0]?.labels;
      return sample ? Object.keys(sample).sort() : undefined;
    };
    const devKeys = labelKeysFor("mento_pool_deviation_ratio");
    const r0Keys = labelKeysFor("mento_pool_reserve_share_token0");
    const r1Keys = labelKeysFor("mento_pool_reserve_share_token1");
    expect(devKeys).toBeDefined();
    // Reserve-share gauges = deviation-ratio labels + `token_symbol`.
    expect(r0Keys).toEqual([...(devKeys ?? []), "token_symbol"].sort());
    expect(r1Keys).toEqual([...(devKeys ?? []), "token_symbol"].sort());
  });

  // ── Value-weighted reserve shares ────────────────────────────────────────
  // The depletion alerts read these, not the raw-count pair. Each case below
  // is a live production pool: the two JPYm pools carry the same JPY/USD feed
  // with OPPOSITE `invertRateFeed` flags because their token0/token1 order
  // differs by chain, so they pin both orientations. Expected values were
  // replayed against indexer state and cross-checked against the pool's
  // on-chain `priceDifference` (both reproduce it to within 1 bps).
  it("value-weights an off-parity pool that reads its feed inverted (Celo JPYm/USDm, token0 = USDm)", async () => {
    updateMetrics([
      makePool({
        id: "42220-0x9861f6d2fe392b934c86ec89d2886ceb772b2b41",
        token0: "0x765de816845861e75a25fca122bb6898b8b1282a",
        token1: "0xc45ecf20f3cd864b32d9794d6f76814ae8892e20",
        reserves0: "24391461103092243011223",
        reserves1: "5751211502393013574884561",
        lastMedianPrice: "6310100000000000000000", // 0.0063101 USD per JPY
        invertRateFeed: true,
        invertRateFeedKnown: true,
      }),
    ]);
    // By token count the pool reads 0.4% / 99.6% — that is the JPY/USD rate,
    // not depletion. This exact reading is what shipped in PR #1940 and would
    // have paged (`< 10%`) on a pool the dashboard shows as healthy.
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.0042, 4);
    // By value the same pool is 40/60 — inside every depletion band.
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.402, 3);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "JPYm",
      }),
    ).toBeCloseTo(0.598, 3);
  });

  it("value-weights the same feed the other way round (Monad JPYm/USDm, token0 = JPYm, not inverted)", async () => {
    updateMetrics([
      makePool({
        id: "143-0x4df3f08977743ad95ab31b8dc203eae885ae9d32",
        chainId: 143,
        token0: "0x22f6a6752800eab67b84748fefc3cc658384af72",
        token1: "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115",
        reserves0: "4574818803667125398741438",
        reserves1: "31017541179518163757928",
        lastMedianPrice: "6309227876692451000000",
        invertRateFeed: false,
        invertRateFeedKnown: true,
      }),
    ]);
    // Same rate, mirrored token order: assuming one orientation for every pool
    // would read this side at ~0.00004 and page. Correct answer is ~48%.
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "JPYm",
      }),
    ).toBeCloseTo(0.482, 3);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.518, 3);
  });

  it("value share equals count share on a parity pair", async () => {
    updateMetrics([
      makePool({
        id: "42220-0x0feba760d93423d127de1b6abecdb60e5253228d",
        token0: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
        token1: "0x765de816845861e75a25fca122bb6898b8b1282a",
        token0Decimals: 6,
        reserves0: "30363272577",
        reserves1: "30807414550474845359006",
        lastMedianPrice: "999319820000000000000000",
        invertRateFeed: false,
        invertRateFeedKnown: true,
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "USDT",
      }),
    ).toBeCloseTo(0.4965, 3);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "USDT",
      }),
    ).toBeCloseTo(0.4964, 3);
  });

  it("value share reports a genuinely one-sided pool as one-sided", async () => {
    // Same Celo JPYm pool, but the USDm leg has actually been drained: 1/1000
    // of the reserves that made it 40/60 above.
    updateMetrics([
      makePool({
        id: "42220-0x9861f6d2fe392b934c86ec89d2886ceb772b2b41",
        token0: "0x765de816845861e75a25fca122bb6898b8b1282a",
        token1: "0xc45ecf20f3cd864b32d9794d6f76814ae8892e20",
        reserves0: "24391461103092243011",
        reserves1: "5751211502393013574884561",
        lastMedianPrice: "6310100000000000000000",
        invertRateFeed: true,
        invertRateFeedKnown: true,
      }),
    ]);
    const share = await getGaugeValue(
      register,
      "mento_pool_reserve_value_share_token0",
      { token_symbol: "USDm" },
    );
    expect(share).toBeLessThan(0.001);
  });

  it("publishes no value share when the rate-feed orientation has not been read", async () => {
    updateMetrics([makePool({ invertRateFeedKnown: false })]);
    // Count shares still publish — only the oracle-frame conversion is gated.
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.5);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeUndefined();
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "GBPm",
      }),
    ).toBeUndefined();
  });

  it("publishes no value share when a pool has never landed a median", async () => {
    // The default fixture is the Celo GBPm/USDm pool, which is NOT in the
    // 1:1 fallback allowlist: an ordinary pool with no median still fails
    // closed.
    updateMetrics([makePool({ lastMedianPrice: "0" })]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeUndefined();
  });

  it("publishes count shares as value shares for the hardcoded 1:1 EURm/EUROP pool", async () => {
    // Polygon EURm/EUROP runs on a MANUAL rate feed pinned to 1:1 (ADR 0042)
    // and has never landed a median, so `reserveValueShares` returns null.
    // At a rate of exactly 1 the count share IS the value share, so the
    // fallback publishes it rather than leaving the pool without depletion
    // coverage (ADR 0067).
    updateMetrics([
      makePool({
        id: "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
        chainId: 137,
        token0: "0x4d502d735b4c574b487ed641ae87ceae884731c7",
        token1: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
        // EUROP is a 6-decimal token on Polygon; EURm is 18. 4 EURm / 6 EUROP.
        reserves0: "4000000000000000000",
        reserves1: "6000000",
        token1Decimals: 6,
        lastMedianPrice: "0",
      }),
    ]);
    const countShare0 = await getGaugeValue(
      register,
      "mento_pool_reserve_share_token0",
      { token_symbol: "EURm" },
    );
    const countShare1 = await getGaugeValue(
      register,
      "mento_pool_reserve_share_token1",
      { token_symbol: "EUROP" },
    );
    expect(countShare0).toBeCloseTo(0.4, 6);
    expect(countShare1).toBeCloseTo(0.6, 6);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "EURm",
      }),
    ).toBe(countShare0);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "EUROP",
      }),
    ).toBe(countShare1);
    // The fallback series must be indistinguishable from a real one to the
    // depletion rules, which aggregate with `min without(token_symbol)`.
    const labelsOf = async (name: string) =>
      (await getMetricValues(register, name))
        .map((v) => Object.keys(v.labels).sort().join(","))
        .sort();
    const countLabels = await labelsOf("mento_pool_reserve_share_token0");
    expect(countLabels).toHaveLength(1);
    expect(await labelsOf("mento_pool_reserve_value_share_token0")).toEqual(
      countLabels,
    );
    expect(await labelsOf("mento_pool_reserve_value_share_token1")).toEqual(
      countLabels,
    );
  });

  it("does not fall back to count shares while an allowlisted pool's token decimals are unread", async () => {
    // The 1:1 argument is about the RATE, not the scale. Before decimal
    // self-healing succeeds the pool carries the schema defaults (18/18), which
    // normalizes the 6-decimal EUROP leg 10^12 times too small — a balanced
    // pool would read ~100%/0% and page. Count shares still publish, so the
    // pool stays visible to `Pool Value Share Missing` rather than going dark.
    updateMetrics([
      makePool({
        id: "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
        chainId: 137,
        token0: "0x4d502d735b4c574b487ed641ae87ceae884731c7",
        token1: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
        reserves0: "4000000000000000000",
        reserves1: "6000000",
        tokenDecimalsKnown: false,
        lastMedianPrice: "0",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "EURm",
      }),
    ).toBeDefined();
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "EURm",
      }),
    ).toBeUndefined();
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "EUROP",
      }),
    ).toBeUndefined();
  });

  it("publishes no value share for any pool whose token decimals are unread", async () => {
    // Not allowlist-specific: unread decimals default to 18/18, and an off-18
    // leg then moves the value share by orders of magnitude.
    updateMetrics([makePool({ tokenDecimalsKnown: false })]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.5);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeUndefined();
  });

  it("does not fall back to count shares when an allowlisted pool's median goes dark", async () => {
    // The fallback must not survive this pair acquiring a real feed. A dark
    // median RETAINS its last non-zero price, so a retained price means a real
    // valuation existed — publishing a 1:1 count share here would replace it
    // with a fabricated one exactly when the oracle went down, reading as
    // healthy while the pool drains. Fail closed like every other pool.
    updateMetrics([
      makePool({
        id: "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
        chainId: 137,
        token0: "0x4d502d735b4c574b487ed641ae87ceae884731c7",
        token1: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
        // EUROP is a 6-decimal token on Polygon; EURm is 18. 4 EURm / 6 EUROP.
        reserves0: "4000000000000000000",
        reserves1: "6000000",
        token1Decimals: 6,
        medianLive: false,
        lastMedianPrice: "500000000000000000000000",
      }),
    ]);
    // Count shares still publish; only the value-share conversion is gated.
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "EURm",
      }),
    ).toBeCloseTo(0.4, 6);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "EURm",
      }),
    ).toBeUndefined();
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "EUROP",
      }),
    ).toBeUndefined();
  });

  it("prefers the real value share over the 1:1 fallback when the allowlisted pool has a live median", async () => {
    // If EUROP ever gets a real feed, the oracle-frame conversion must win.
    // A 0.5 median against 40/60 reserves gives ~25%/75% by value — a number
    // the count-share fallback cannot produce.
    updateMetrics([
      makePool({
        id: "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
        chainId: 137,
        token0: "0x4d502d735b4c574b487ed641ae87ceae884731c7",
        token1: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
        // EUROP is a 6-decimal token on Polygon; EURm is 18. 4 EURm / 6 EUROP.
        reserves0: "4000000000000000000",
        reserves1: "6000000",
        token1Decimals: 6,
        lastMedianPrice: "500000000000000000000000",
        medianLive: true,
        invertRateFeed: false,
        invertRateFeedKnown: true,
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "EURm",
      }),
    ).toBeCloseTo(0.25, 6);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "EUROP",
      }),
    ).toBeCloseTo(0.75, 6);
  });

  it("publishes no value share once a live median goes dark", async () => {
    // A zero-median outage sets `medianLive: false` while `lastMedianPrice`
    // RETAINS the last non-zero value, so a price check alone would keep
    // publishing a share priced off a rate the contract no longer honours.
    updateMetrics([
      makePool({
        medianLive: false,
        lastMedianPrice: "1150000000000000000000000",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.5);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeUndefined();
    expect(
      await getGaugeValue(register, "mento_pool_reserve_value_share_token1", {
        token_symbol: "GBPm",
      }),
    ).toBeUndefined();
  });

  it("value-share gauges carry the same label shape as the count-share gauges", async () => {
    updateMetrics([makePool()]);
    const json = await register.getMetricsAsJSON();
    type MetricEntry = {
      name: string;
      values?: Array<{ labels: Record<string, string> }>;
    };
    const labelKeysFor = (name: string): string[] | undefined => {
      const m = json.find((x) => (x as MetricEntry).name === name) as
        | MetricEntry
        | undefined;
      const sample = m?.values?.[0]?.labels;
      return sample ? Object.keys(sample).sort() : undefined;
    };
    const countKeys = labelKeysFor("mento_pool_reserve_share_token0");
    expect(countKeys).toBeDefined();
    expect(labelKeysFor("mento_pool_reserve_value_share_token0")).toEqual(
      countKeys,
    );
    expect(labelKeysFor("mento_pool_reserve_value_share_token1")).toEqual(
      countKeys,
    );
  });

  it("token_symbol label resolves known token addresses on a real Celo pool (axlUSDC + USDm)", async () => {
    // 0x765de8…1282a is USDm on Celo (42220) per @mento-protocol/contracts.
    // 0xeb466342…5215 is axlUSDC. Confirms the gauge correctly carries the
    // resolved symbols, which the alert annotation consumes via
    // `$values.R0.Labels.token_symbol`.
    updateMetrics([
      makePool({
        id: "42220-0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d",
        token0: "0x765de816845861e75a25fca122bb6898b8b1282a",
        token1: "0xeb466342c4d449bc9f53a865d5cb90586f405215",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "USDm",
      }),
    ).toBeCloseTo(0.5);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token1", {
        token_symbol: "axlUSDC",
      }),
    ).toBeCloseTo(0.5);
  });

  it("falls back to literal token0/token1 when contract address is unknown", async () => {
    // Mirrors the existing `pair` fallback semantics: when a contract
    // address isn't in @mento-protocol/contracts, the alert renders with
    // generic "token0" / "token1" rather than crashing or carrying nil.
    updateMetrics([
      makePool({
        token0: "0xdeadbeef00000000000000000000000000000000",
        token1: "0xfeedface00000000000000000000000000000000",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token0", {
        token_symbol: "token0",
      }),
    ).toBeCloseTo(0.5);
    expect(
      await getGaugeValue(register, "mento_pool_reserve_share_token1", {
        token_symbol: "token1",
      }),
    ).toBeCloseTo(0.5);
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

  it("publishes swap_fee_bps as lpFee + protocolFee", async () => {
    updateMetrics([makePool({ lpFee: 10, protocolFee: 5 })]);
    expect(
      await getGaugeValue(register, "mento_pool_swap_fee_bps", poolLabels),
    ).toBe(15);
  });

  it("skips swap_fee_bps when lpFee sentinel (-1)", async () => {
    updateMetrics([makePool({ lpFee: -1, protocolFee: 5 })]);
    expect(
      await getGaugeValue(register, "mento_pool_swap_fee_bps", poolLabels),
    ).toBeUndefined();
  });

  it("skips swap_fee_bps when protocolFee sentinel (-1)", async () => {
    updateMetrics([makePool({ lpFee: 5, protocolFee: -1 })]);
    expect(
      await getGaugeValue(register, "mento_pool_swap_fee_bps", poolLabels),
    ).toBeUndefined();
  });

  it("publishes swap_fee_bps = 0 for a legitimately zero-fee pool", async () => {
    // A pool with lpFee = 0 AND protocolFee = 0 is a real configuration,
    // NOT a sentinel. Any oracle jump is LP leakage by definition (there's
    // no fee to offset it), so the alert rule uses `>= 0` to keep these
    // pools eligible to fire. Regression test for the Codex/Cursor/Claude
    // reviews on PR #223.
    updateMetrics([makePool({ lpFee: 0, protocolFee: 0 })]);
    expect(
      await getGaugeValue(register, "mento_pool_swap_fee_bps", poolLabels),
    ).toBe(0);
  });

  // Codex flagged a concern that `parseFloat("3.3000")` = IEEE approx of 3.3
  // (slightly below), so `jump * 10 >= fee * 11` would evaluate false at the
  // 10%-over-fee boundary for a 3 bps fee and misroute critical → warning.
  // IEEE-754 round-to-nearest actually rounds `3.3 * 10` back to 33.0
  // exactly (33 is representable and closer than 33 − 2⁻⁴⁶), so both
  // tiers partition correctly. This test locks the round-trip behaviour
  // the terraform alert rules rely on — if a future bridge change swaps
  // the gauge unit or parseFloat path, the boundary regression will trip.
  it.each([
    [3, "3.3000", true], // Codex's specific case — critical boundary
    [3, "3.2999", false], // just below boundary → warning only
    [3, "3.3001", true], // just above boundary → critical
    [7, "7.7000", true], // non-multiple-of-5 fee, integer-bps boundary
    [10, "11.0000", true], // user's stated case: 11 bps on a 10 bps fee
    [10, "10.5000", false], // user's stated warning case
  ])(
    "oracle-jump boundary: fee=%s jump=%s routes to critical=%s",
    (fee, jumpStr, shouldBeCritical) => {
      const jump = parseFloat(jumpStr);
      const critical = jump * 10 >= fee * 11;
      const warning = jump > fee && jump * 10 < fee * 11;
      expect(critical).toBe(shouldBeCritical);
      // Mutual exclusion at every boundary.
      expect(warning && critical).toBe(false);
    },
  );

  it("parses oracle_jump_bps from fixed-point string", async () => {
    updateMetrics([makePool({ lastOracleJumpBps: "10.5000" })]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_jump_bps", poolLabels),
    ).toBe(10.5);
  });

  it("sets oracle_jump_at from BigInt string", async () => {
    updateMetrics([makePool({ lastOracleJumpAt: "1713200500" })]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_jump_at", poolLabels),
    ).toBe(1713200500);
  });

  it("publishes zero oracle_jump_bps before any jump recorded", async () => {
    // Unlike deviationRatio, we DO publish 0 — it's a legitimate "no recent
    // movement" signal, and the alert gates on `time() - oracle_jump_at` to
    // avoid false-firing on these pools anyway.
    updateMetrics([
      makePool({ lastOracleJumpBps: "0.0000", lastOracleJumpAt: "0" }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_jump_bps", poolLabels),
    ).toBe(0);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_jump_at", poolLabels),
    ).toBe(0);
  });

  it("decimal-adjusts oracle median prices from FixidityLib 1e24 scale", async () => {
    updateMetrics([makePool()]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_price", poolLabels),
    ).toBeCloseTo(1.15, 6);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_prev_price", poolLabels),
    ).toBeCloseTo(1.12, 6);
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_prev_price_at",
        poolLabels,
      ),
    ).toBe(1713199580);
  });

  it("skips oracle price gauges on the 0 sentinel (no median yet)", async () => {
    updateMetrics([
      makePool({
        lastMedianPrice: "0",
        prevMedianPrice: "0",
        prevMedianAt: "0",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_price", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(register, "mento_pool_oracle_prev_price", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_prev_price_at",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("skips prev gauges when only one of the (price, at) pair is non-zero", async () => {
    // Migration corner case: the indexer column for `prevMedianAt` was added
    // with default 0, so the first post-migration MedianUpdated will have
    // prevMedianPrice carried from the old row but prevMedianAt = 0.
    // Without pair-gating the bridge would publish a 1970 timestamp.
    updateMetrics([
      makePool({
        prevMedianPrice: "1120000000000000000000000",
        prevMedianAt: "0",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_prev_price", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_prev_price_at",
        poolLabels,
      ),
    ).toBeUndefined();
  });

  it("publishes current oracle price before a second median (prev still 0)", async () => {
    // First-ever-median path: only the prev pair is suppressed; the alert
    // summary still needs `oracle_price` to quote a current value.
    updateMetrics([
      makePool({
        prevMedianPrice: "0",
        prevMedianAt: "0",
      }),
    ]);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_price", poolLabels),
    ).toBeCloseTo(1.15, 6);
    expect(
      await getGaugeValue(register, "mento_pool_oracle_prev_price", poolLabels),
    ).toBeUndefined();
    expect(
      await getGaugeValue(
        register,
        "mento_pool_oracle_prev_price_at",
        poolLabels,
      ),
    ).toBeUndefined();
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
    counters.pollErrors.inc({ kind: "hasura_query" });
    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find(
      (m) => m.name === "mento_pool_bridge_poll_errors_total",
    );
    expect(counter).toBeDefined();
    const value = (
      counter as {
        values: Array<{ labels: Record<string, string>; value: number }>;
      }
    ).values.find((sample) => sample.labels.kind === "hasura_query")?.value;
    expect(value).toBe(1);
  });
});

// Contract-with-terraform — drift between metric labels and the alert
// templates that read them via `$values.X.Labels.Y` is silent: a missing
// label collapses to the empty string and the annotation line drops without
// any metric or log signal. These tests pin the labels the alert templates
// depend on so a future label rename / drop fails CI before reaching prod.
//
// Cross-references:
//   - `alerts/rules/main.tf` (`deviation_*_annotation` locals)
//     reads `$values.B.Labels.reason_message`,
//     `$values.R0.Labels.token_symbol`, `$values.R1.Labels.token_symbol`.
//     `reason_code` stays on the gauge for diagnostics even though Slack no
//     longer renders it.
//   - `alerts/rules/rules-fpmms.tf` (Deviation Breach warning/critical)
//     consumes the locals.
describe("label-shape contract: alert template ↔ metric labels", () => {
  // Use a typed cast: prom-client's Gauge typings hide `labelNames` as
  // private, but the runtime carries the array on every instance.
  function labelNamesOf(g: {
    labelNames?: readonly string[];
  }): readonly string[] {
    return g.labelNames ?? [];
  }

  it("rebalanceBlocked labels include reason_code for diagnostics + reason_message for Slack", () => {
    const labels = labelNamesOf(gauges.rebalanceBlocked);
    expect(labels).toContain("reason_code");
    expect(labels).toContain("reason_message");
  });

  it("reserveShareToken0 / reserveShareToken1 labels include token_symbol (referenced by $values.R0.Labels.token_symbol / $values.R1.Labels.token_symbol)", () => {
    expect(labelNamesOf(gauges.reserveShareToken0)).toContain("token_symbol");
    expect(labelNamesOf(gauges.reserveShareToken1)).toContain("token_symbol");
  });

  it("pollErrors labels include bounded kind (referenced by Metrics Bridge Poll Errors)", () => {
    expect(labelNamesOf(counters.pollErrors)).toEqual(["kind"]);
  });
});

describe("updateMetrics — VirtualPool transition", () => {
  // VP exclusion itself is enforced at the poll boundary by `isFpmmPool`
  // (covered in poller.test.ts). The behavior that lives in `updateMetrics` is
  // deviation-alert-state pruning: once a healed VP is filtered out upstream, a
  // subsequent poll that no longer carries its id must evict the stale state.
  const DEFAULT_NOW_SECONDS = 1713200100;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DEFAULT_NOW_SECONDS * 1000));
    register.resetMetrics();
    resetDeviationAlertStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes deviation alert state when an FPMM heals to a VP and drops out", async () => {
    // Poll 1: an FPMM in an active critical breach registers deviation state.
    const fpmm = makePool({
      wrappedExchangeId: "",
      deviationBreachStartedAt: String(DEFAULT_NOW_SECONDS - 60),
      lastDeviationRatio: "1.10",
      currentOpenBreachPeak: "1.10",
    });
    updateMetrics([fpmm], DEFAULT_NOW_SECONDS);
    expect(
      (
        await getMetricValues(register, "mento_pool_deviation_alert_state")
      ).some((v) => v.labels.pool_id === fpmm.id),
    ).toBe(true);

    // Poll 2: the pool has healed to a VP, so `isFpmmPool` filters it out at the
    // poll boundary and `updateMetrics` receives an empty list — its id is
    // absent from activePoolIds and the stale deviation state is pruned.
    updateMetrics([], DEFAULT_NOW_SECONDS);
    expect(
      (
        await getMetricValues(register, "mento_pool_deviation_alert_state")
      ).some((v) => v.labels.pool_id === fpmm.id),
    ).toBe(false);
  });
});
