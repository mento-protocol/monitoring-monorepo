import assert from "node:assert/strict";
import type { EffectCaller } from "envio";
import { describe, it } from "vitest";
import {
  selfHealInvertRateFeed,
  selfHealRebalanceThresholds,
  selfHealTokenDecimals,
} from "../src/pool/self-heal.ts";
import { makePool } from "./helpers/makePool.ts";

function throwingEffect(): EffectCaller {
  return (async () => {
    throw new Error("effect should not be called");
  }) as EffectCaller;
}

describe("pool self-heal helpers", () => {
  it("selfHealInvertRateFeed is a no-op once the field is known", async () => {
    const pool = makePool({ invertRateFeedKnown: true, invertRateFeed: false });

    const healed = await selfHealInvertRateFeed(
      { effect: throwingEffect() },
      pool,
    );

    assert.equal(healed, pool);
  });

  it("selfHealInvertRateFeed preserves the pool on transient unknown sentinel", async () => {
    const pool = makePool({
      id: "42220-0x00000000000000000000000000000000000000aa",
      invertRateFeedKnown: false,
      invertRateFeed: false,
    });
    const effect = (async () => -1) as EffectCaller;

    const healed = await selfHealInvertRateFeed({ effect }, pool);

    assert.equal(healed, pool);
  });

  it("selfHealInvertRateFeed applies a decoded true value", async () => {
    const pool = makePool({
      id: "42220-0x00000000000000000000000000000000000000ab",
      invertRateFeedKnown: false,
      invertRateFeed: false,
    });
    const effect = (async () => 1) as EffectCaller;

    const healed = await selfHealInvertRateFeed({ effect }, pool);

    assert.notEqual(healed, pool);
    assert.equal(healed.invertRateFeed, true);
    assert.equal(healed.invertRateFeedKnown, true);
  });

  it("selfHealTokenDecimals waits for token addresses before calling RPC", async () => {
    const pool = makePool({
      tokenDecimalsKnown: false,
      token0: undefined,
      token1: undefined,
    });

    const healed = await selfHealTokenDecimals(
      { effect: throwingEffect() },
      pool,
    );

    assert.equal(healed, pool);
  });

  it("selfHealTokenDecimals leaves the pool unchanged on a partial decimals miss", async () => {
    const pool = makePool({
      id: "42220-0x00000000000000000000000000000000000000ac",
      tokenDecimalsKnown: false,
      token0Decimals: 18,
      token1Decimals: 18,
    });
    const effect = (async (_effect, input: { fn: string }) =>
      input.fn === "decimals0" ? 10n ** 6n : null) as EffectCaller;

    const healed = await selfHealTokenDecimals({ effect }, pool);

    assert.equal(healed, pool);
  });

  it("selfHealTokenDecimals repairs both decimals only when both reads succeed", async () => {
    const pool = makePool({
      id: "42220-0x00000000000000000000000000000000000000ad",
      tokenDecimalsKnown: false,
      token0Decimals: 18,
      token1Decimals: 18,
    });
    const effect = (async (_effect, input: { fn: string }) =>
      input.fn === "decimals0" ? 10n ** 6n : 10n ** 18n) as EffectCaller;

    const healed = await selfHealTokenDecimals({ effect }, pool);

    assert.notEqual(healed, pool);
    assert.equal(healed.token0Decimals, 6);
    assert.equal(healed.token1Decimals, 18);
    assert.equal(healed.tokenDecimalsKnown, true);
  });

  it("selfHealRebalanceThresholds preserves stale fields on RPC failure", async () => {
    const pool = makePool({
      id: "42220-0x00000000000000000000000000000000000000ae",
      rebalanceThreshold: 5000,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 0,
      rebalanceThresholdsKnown: false,
    });
    const effect = (async () => null) as EffectCaller;

    const healed = await selfHealRebalanceThresholds(
      { effect },
      pool,
      60_700_000n,
    );

    assert.equal(healed, pool);
  });

  it("selfHealRebalanceThresholds repairs split fields and broadest legacy threshold", async () => {
    const pool = makePool({
      id: "42220-0x00000000000000000000000000000000000000af",
      rebalanceThreshold: 5000,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 0,
      rebalanceThresholdsKnown: false,
    });
    const effect = (async () => ({ above: 300, below: 700 })) as EffectCaller;

    const healed = await selfHealRebalanceThresholds(
      { effect },
      pool,
      60_700_000n,
    );

    assert.notEqual(healed, pool);
    assert.equal(healed.rebalanceThresholdAbove, 300);
    assert.equal(healed.rebalanceThresholdBelow, 700);
    assert.equal(healed.rebalanceThresholdsKnown, true);
    assert.equal(healed.rebalanceThreshold, 700);
  });
});
