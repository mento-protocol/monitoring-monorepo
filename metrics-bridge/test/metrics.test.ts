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
  // (data blocks R0 and R1 on `Deviation Breach Critical`) are matched
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

// Contract-with-terraform — drift between metric labels and the alert
// templates that read them via `$values.X.Labels.Y` is silent: a missing
// label collapses to the empty string and the annotation line drops without
// any metric or log signal. These tests pin the labels the alert templates
// depend on so a future label rename / drop fails CI before reaching prod.
//
// Cross-references:
//   - `terraform/alerts/main.tf` (`deviation_critical_*_annotation` locals)
//     reads `$values.B.Labels.{reason_code,reason_message}`,
//     `$values.R0.Labels.token_symbol`, `$values.R1.Labels.token_symbol`.
//   - `terraform/alerts/rules-fpmms.tf` (Deviation Breach Critical,
//     magnitude-gated and anchored) consumes the locals.
describe("label-shape contract: alert template ↔ metric labels", () => {
  // Use a typed cast: prom-client's Gauge typings hide `labelNames` as
  // private, but the runtime carries the array on every instance.
  function labelNamesOf(g: {
    labelNames?: readonly string[];
  }): readonly string[] {
    return g.labelNames ?? [];
  }

  it("rebalanceBlocked labels include reason_code + reason_message (referenced by $values.B.Labels.* in main.tf)", () => {
    const labels = labelNamesOf(gauges.rebalanceBlocked);
    expect(labels).toContain("reason_code");
    expect(labels).toContain("reason_message");
  });

  it("reserveShareToken0 / reserveShareToken1 labels include token_symbol (referenced by $values.R0.Labels.token_symbol / $values.R1.Labels.token_symbol)", () => {
    expect(labelNamesOf(gauges.reserveShareToken0)).toContain("token_symbol");
    expect(labelNamesOf(gauges.reserveShareToken1)).toContain("token_symbol");
  });
});
