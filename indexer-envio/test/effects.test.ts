import assert from "node:assert/strict";
import { decodeInvertRateFeedEffectResult } from "../src/rpc/effects.js";

describe("decodeInvertRateFeedEffectResult", () => {
  it("decodes the cached integer sentinel to nullable boolean semantics", () => {
    assert.equal(decodeInvertRateFeedEffectResult(-1), null);
    assert.equal(decodeInvertRateFeedEffectResult(0), false);
    assert.equal(decodeInvertRateFeedEffectResult(1), true);
  });

  it("throws on unexpected cached values", () => {
    assert.throws(
      () => decodeInvertRateFeedEffectResult(2),
      /Unexpected encoded value 2/,
    );
  });
});
