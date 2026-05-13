import { strict as assert } from "assert";
import {
  buildTradingLimitEntity,
  buildTradingLimitEntityFromRpc,
  computeLimitStatus,
  computeLimitPressures,
  resetTradingLimitState,
  tradingLimitId,
  tradingLimitStateFromEntity,
} from "../src/tradingLimits.js";

const INTERNAL_UNIT = 10n ** 15n;

describe("TradingLimitsV2 state derivation", () => {
  it("builds stable per-pool token IDs", () => {
    assert.equal(
      tradingLimitId(
        "42220-0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ),
      "42220-0x0000000000000000000000000000000000000001-0x0000000000000000000000000000000000000002",
    );
  });

  it("extracts persisted netflow state from a TradingLimit row", () => {
    assert.deepEqual(
      tradingLimitStateFromEntity({
        lastUpdated0: 123n,
        lastUpdated1: 456n,
        netflow0: -10n,
        netflow1: 20n,
      }),
      {
        lastUpdated0: 123n,
        lastUpdated1: 456n,
        netflow0: -10n,
        netflow1: 20n,
      },
    );
  });

  it("computes pressure and status for large 15-decimal limits", () => {
    const limit = 10_000_000n * INTERNAL_UNIT;
    const netflow = 8_500_000n * INTERNAL_UNIT;

    const { p0 } = computeLimitPressures(netflow, 0n, limit, 0n);
    assert.equal(p0, 0.85);

    const row = buildTradingLimitEntity({
      id: "pool-token",
      chainId: 42220,
      poolId: "42220-0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      config: { limit0: limit, limit1: 0n },
      state: {
        lastUpdated0: 100_000n,
        lastUpdated1: 0n,
        netflow0: netflow,
        netflow1: 0n,
      },
      blockNumber: 123n,
      blockTimestamp: 100_000n,
    });
    assert.equal(row.limitPressure0, "0.8500");
    assert.equal(row.limitStatus, "WARN");
  });

  it("computes absolute pressure for negative netflow and disabled windows", () => {
    const limit = 100n * INTERNAL_UNIT;
    const { p0, p1 } = computeLimitPressures(
      -25n * INTERNAL_UNIT,
      -10n * INTERNAL_UNIT,
      limit,
      0n,
    );

    assert.equal(p0, 0.25);
    assert.equal(p1, 0);
  });

  it("classifies pressure status from the worst side", () => {
    assert.equal(computeLimitStatus(0.1, 0.2), "OK");
    assert.equal(computeLimitStatus(0.79, 0.8), "WARN");
    assert.equal(computeLimitStatus(0.1, 1), "CRITICAL");
  });

  it("classifies exactly 80% pressure as WARN", () => {
    const limit = 10n * INTERNAL_UNIT;
    const netflow = 8n * INTERNAL_UNIT;

    const row = buildTradingLimitEntity({
      id: "pool-token",
      chainId: 42220,
      poolId: "42220-0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      config: { limit0: limit, limit1: 0n },
      state: {
        lastUpdated0: 100_000n,
        lastUpdated1: 0n,
        netflow0: netflow,
        netflow1: 0n,
      },
      blockNumber: 123n,
      blockTimestamp: 100_000n,
    });

    assert.equal(row.limitPressure0, "0.8000");
    assert.equal(row.limitStatus, "WARN");
  });

  it("classifies at-limit netflow as CRITICAL", () => {
    const limit = 10n * INTERNAL_UNIT;
    const row = buildTradingLimitEntity({
      id: "pool-token",
      chainId: 42220,
      poolId: "42220-0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      config: { limit0: limit, limit1: limit * 2n },
      state: {
        lastUpdated0: 100_000n,
        lastUpdated1: 100_000n,
        netflow0: limit,
        netflow1: 0n,
      },
      blockNumber: 123n,
      blockTimestamp: 100_000n,
    });

    assert.equal(row.limitPressure0, "1.0000");
    assert.equal(row.limitStatus, "CRITICAL");
  });

  it("classifies negative at-limit netflow as CRITICAL", () => {
    const limit = 10n * INTERNAL_UNIT;
    const row = buildTradingLimitEntity({
      id: "pool-token",
      chainId: 42220,
      poolId: "42220-0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      config: { limit0: limit, limit1: limit },
      state: {
        lastUpdated0: 100_000n,
        lastUpdated1: 100_000n,
        netflow0: 0n,
        netflow1: -limit,
      },
      blockNumber: 123n,
      blockTimestamp: 100_000n,
    });

    assert.equal(row.limitPressure1, "1.0000");
    assert.equal(row.limitStatus, "CRITICAL");
  });

  it("classifies negative warning pressure as WARN", () => {
    const limit = 10n * INTERNAL_UNIT;
    const row = buildTradingLimitEntity({
      id: "pool-token",
      chainId: 42220,
      poolId: "42220-0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      config: { limit0: limit, limit1: limit },
      state: {
        lastUpdated0: 100_000n,
        lastUpdated1: 100_000n,
        netflow0: 0n,
        netflow1: -8n * INTERNAL_UNIT,
      },
      blockNumber: 123n,
      blockTimestamp: 100_000n,
    });

    assert.equal(row.limitPressure1, "0.8000");
    assert.equal(row.limitStatus, "WARN");
  });

  it("keeps disabled limits out of warning and critical status", () => {
    const row = buildTradingLimitEntity({
      id: "pool-token",
      chainId: 42220,
      poolId: "42220-0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      config: { limit0: 0n, limit1: 0n },
      state: {
        lastUpdated0: 100_000n,
        lastUpdated1: 100_000n,
        netflow0: 999n * INTERNAL_UNIT,
        netflow1: -999n * INTERNAL_UNIT,
      },
      blockNumber: 123n,
      blockTimestamp: 100_000n,
    });

    assert.equal(row.limitPressure0, "0.0000");
    assert.equal(row.limitPressure1, "0.0000");
    assert.equal(row.limitStatus, "OK");
  });

  it("reset preserves enabled-window netflow and clears disabled-window netflow", () => {
    const next = resetTradingLimitState(
      {
        lastUpdated0: 123n,
        lastUpdated1: 456n,
        netflow0: 10n,
        netflow1: -20n,
      },
      { limit0: 1n, limit1: 0n },
    );

    assert.deepEqual(next, {
      lastUpdated0: 0n,
      lastUpdated1: 0n,
      netflow0: 10n,
      netflow1: 0n,
    });
  });

  it("reset starts from zero state when no persisted row exists", () => {
    assert.deepEqual(
      resetTradingLimitState(undefined, { limit0: 1n, limit1: 1n }),
      {
        lastUpdated0: 0n,
        lastUpdated1: 0n,
        netflow0: 0n,
        netflow1: 0n,
      },
    );
  });

  it("reset clears disabled token0 and preserves enabled token1", () => {
    assert.deepEqual(
      resetTradingLimitState(
        {
          lastUpdated0: 123n,
          lastUpdated1: 456n,
          netflow0: 10n,
          netflow1: -20n,
        },
        { limit0: 0n, limit1: 1n },
      ),
      {
        lastUpdated0: 0n,
        lastUpdated1: 0n,
        netflow0: 0n,
        netflow1: -20n,
      },
    );
  });

  it("builds an entity from the RPC shape", () => {
    const row = buildTradingLimitEntityFromRpc({
      id: "pool-token",
      chainId: 42220,
      poolId: "42220-0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      data: {
        config: { limit0: 10n * INTERNAL_UNIT, limit1: 0n, decimals: 15 },
        state: {
          lastUpdated0: 1n,
          lastUpdated1: 2n,
          netflow0: 5n * INTERNAL_UNIT,
          netflow1: 0n,
        },
      },
      blockNumber: 123n,
      blockTimestamp: 100_000n,
    });

    assert.equal(row.id, "pool-token");
    assert.equal(row.limitPressure0, "0.5000");
    assert.equal(row.limitStatus, "OK");
    assert.equal(row.updatedAtBlock, 123n);
  });
});
