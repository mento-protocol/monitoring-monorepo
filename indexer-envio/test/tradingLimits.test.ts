import { strict as assert } from "assert";
import {
  applyTradingLimitSwap,
  resetTradingLimitState,
  scaleTradingLimitValue,
} from "../src/tradingLimits.js";

const INTERNAL_UNIT = 10n ** 15n;
const TOKEN_18_UNIT = 10n ** 18n;

describe("TradingLimitsV2 state derivation", () => {
  it("scales token amounts into TradingLimitsV2 internal precision", () => {
    assert.equal(
      scaleTradingLimitValue(123_456_789n, 6),
      123_456_789_000_000_000n,
    );
    assert.equal(
      scaleTradingLimitValue(100n * TOKEN_18_UNIT, 18),
      100n * INTERNAL_UNIT,
    );
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

  it("applies swap delta after subtracting fees from amountIn", () => {
    const next = applyTradingLimitSwap(
      {
        lastUpdated0: 0n,
        lastUpdated1: 0n,
        netflow0: 0n,
        netflow1: 0n,
      },
      {
        limit0: 1_000n * INTERNAL_UNIT,
        limit1: 10_000n * INTERNAL_UNIT,
        decimals: 18,
      },
      {
        amountIn: 100n * TOKEN_18_UNIT,
        amountOut: 20n * TOKEN_18_UNIT,
        totalFeeBps: 50,
        blockTimestamp: 100_000n,
      },
    );

    const expectedDelta = 79_500_000_000_000_000n;
    assert.deepEqual(next, {
      lastUpdated0: 100_000n,
      lastUpdated1: 100_000n,
      netflow0: expectedDelta,
      netflow1: expectedDelta,
    });
  });

  it("accumulates within both active windows", () => {
    const next = applyTradingLimitSwap(
      {
        lastUpdated0: 100_000n,
        lastUpdated1: 100_000n,
        netflow0: 79_500_000_000_000_000n,
        netflow1: 79_500_000_000_000_000n,
      },
      {
        limit0: 1_000n * INTERNAL_UNIT,
        limit1: 10_000n * INTERNAL_UNIT,
        decimals: 18,
      },
      {
        amountIn: 0n,
        amountOut: 10n * TOKEN_18_UNIT,
        totalFeeBps: 0,
        blockTimestamp: 100_100n,
      },
    );

    assert.deepEqual(next, {
      lastUpdated0: 100_000n,
      lastUpdated1: 100_000n,
      netflow0: 69_500_000_000_000_000n,
      netflow1: 69_500_000_000_000_000n,
    });
  });

  it("resets only the elapsed five-minute window", () => {
    const next = applyTradingLimitSwap(
      {
        lastUpdated0: 100_000n,
        lastUpdated1: 100_000n,
        netflow0: 50n * INTERNAL_UNIT,
        netflow1: 50n * INTERNAL_UNIT,
      },
      {
        limit0: 1_000n * INTERNAL_UNIT,
        limit1: 10_000n * INTERNAL_UNIT,
        decimals: 18,
      },
      {
        amountIn: 10n * TOKEN_18_UNIT,
        amountOut: 0n,
        totalFeeBps: 0,
        blockTimestamp: 100_301n,
      },
    );

    assert.deepEqual(next, {
      lastUpdated0: 100_301n,
      lastUpdated1: 100_000n,
      netflow0: 10n * INTERNAL_UNIT,
      netflow1: 60n * INTERNAL_UNIT,
    });
  });

  it("leaves state unchanged when both limits are disabled", () => {
    const state = {
      lastUpdated0: 100_000n,
      lastUpdated1: 100_000n,
      netflow0: 50n * INTERNAL_UNIT,
      netflow1: -50n * INTERNAL_UNIT,
    };
    const next = applyTradingLimitSwap(
      state,
      { limit0: 0n, limit1: 0n, decimals: 18 },
      {
        amountIn: 10n * TOKEN_18_UNIT,
        amountOut: 0n,
        totalFeeBps: 0,
        blockTimestamp: 200_000n,
      },
    );

    assert.deepEqual(next, state);
  });
});
