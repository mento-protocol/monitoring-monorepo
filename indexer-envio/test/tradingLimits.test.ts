import { strict as assert } from "assert";
import {
  buildTradingLimitEntity,
  computeLimitPressures,
  resetTradingLimitState,
} from "../src/tradingLimits.js";

const INTERNAL_UNIT = 10n ** 15n;

describe("TradingLimitsV2 state derivation", () => {
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
});
