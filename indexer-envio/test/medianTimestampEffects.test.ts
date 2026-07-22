import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  MEDIAN_TIMESTAMP_RATE_LIMITS,
  medianTimestampEffectForChain,
} from "../src/rpc/effects.js";

describe("medianTimestamp effect rate limits", () => {
  it("keeps provider-specific limiter state on distinct effect objects", () => {
    const polygon = medianTimestampEffectForChain(137);
    const celo = medianTimestampEffectForChain(42220);
    const monad = medianTimestampEffectForChain(143);
    const fallback = medianTimestampEffectForChain(1);

    assert.equal(medianTimestampEffectForChain(80002), polygon);
    assert.equal(medianTimestampEffectForChain(11142220), celo);
    assert.equal(medianTimestampEffectForChain(10143), monad);
    assert.notEqual(polygon, celo);
    assert.notEqual(polygon, monad);
    assert.notEqual(celo, monad);
    assert.notEqual(fallback, polygon);
    assert.notEqual(fallback, celo);
    assert.notEqual(fallback, monad);
  });

  it("protects Polygon without throttling Celo below its proven rate", () => {
    assert.deepEqual(MEDIAN_TIMESTAMP_RATE_LIMITS, {
      polygon: { calls: 40, per: "second" },
      celo: { calls: 200, per: "second" },
      monad: { calls: 40, per: "second" },
      default: { calls: 40, per: "second" },
    });
  });
});
