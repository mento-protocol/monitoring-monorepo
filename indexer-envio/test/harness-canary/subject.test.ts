/**
 * Direct test for the mutation-testing harness canary fixture. It asserts on
 * every value a mutant can change, so `stryker.canary.config.mjs` must score
 * 100%.
 */

import { describe, it, expect } from "vitest";
import { canaryLabel, canarySum } from "./subject.js";

describe("mutation harness canary", () => {
  it("adds its two arguments", () => {
    expect(canarySum(2, 3)).toBe(5);
  });

  it("labels the active branch", () => {
    expect(canaryLabel(true)).toBe("on");
  });

  it("labels the inactive branch", () => {
    expect(canaryLabel(false)).toBe("off");
  });
});
