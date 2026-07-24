import { describe, expect, it } from "vitest";
import { formatScaled, titleCase } from "../peg-monitoring-evidence-primitives";

describe("peg monitoring evidence primitives", () => {
  it("uses ES2017-compatible title casing", () => {
    expect(titleCase("one_sided_bid")).toBe("one sided bid");
    expect(titleCase(null)).toBe("Unknown");
  });

  it("scales arbitrary decimal strings without numeric precision loss", () => {
    expect(formatScaled("123456789012345678901234567890", 8)).toBe(
      "1234567890123456789012.3456789",
    );
    expect(formatScaled("000123456789012345678900", 8)).toBe(
      "1234567890123.456789",
    );
    expect(formatScaled("1000000000000000000000000", 24)).toBe("1");
    expect(formatScaled(null, 24)).toBe("—");
  });

  it("keeps negative fractions, removes negative zero, and truncates to eight visible fractional digits", () => {
    expect(formatScaled("-123456789012345678", 8)).toBe("-1234567890.12345678");
    expect(formatScaled("1234567890123456789", 10)).toBe("123456789.01234567");
    expect(formatScaled("-10000000", 8)).toBe("-0.1");
    expect(formatScaled("-1", 8)).toBe("-0.00000001");
    // Values below the eight-digit display resolution are intentionally shown
    // as zero rather than claiming precision the UI does not render.
    expect(formatScaled("-1", 24)).toBe("0");
  });
});
