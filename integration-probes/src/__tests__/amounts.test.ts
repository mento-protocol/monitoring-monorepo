import { describe, expect, it } from "vitest";
import { decimalAmountToRaw } from "../amounts.js";

describe("decimalAmountToRaw", () => {
  it("converts whole-token stable amounts", () => {
    expect(decimalAmountToRaw("1", 18)).toBe("1000000000000000000");
    expect(decimalAmountToRaw("1", 6)).toBe("1000000");
  });

  it("converts fractional amounts and rejects over-precision", () => {
    expect(decimalAmountToRaw("1.25", 6)).toBe("1250000");
    expect(() => decimalAmountToRaw("1.0000001", 6)).toThrow(
      /more fractional digits/,
    );
  });
});
