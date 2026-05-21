import { describe, expect, it } from "vitest";
import { cdpSymbolSlug, formatSignedWei, formatTokenAmount } from "./format";

describe("CDP format helpers", () => {
  it("treats only the -1 sentinel as unknown token amount", () => {
    expect(formatTokenAmount("-1", "GBPm")).toBe("—");
    expect(formatTokenAmount("-1000000000000000000", "GBPm")).toBe(
      "-1.00 GBPm",
    );
  });

  it("formatTokenAmount returns — for null/undefined", () => {
    expect(formatTokenAmount(null, "BOLD")).toBe("—");
    expect(formatTokenAmount(undefined, "BOLD")).toBe("—");
  });

  it("cdpSymbolSlug lowercases the symbol", () => {
    expect(cdpSymbolSlug("GBPm")).toBe("gbpm");
    expect(cdpSymbolSlug("BOLD")).toBe("bold");
  });
});

describe("formatSignedWei", () => {
  it("does NOT treat -1 as an unknown sentinel — renders the literal amount", () => {
    // Regression guard for the formatTokenAmount sentinel collision: a -1 wei
    // collChange/debtChange is a legitimate signed value, not "unknown".
    expect(formatSignedWei("-1", "BOLD")).toBe("-0.00 BOLD");
  });

  it("renders positive values with no sign prefix", () => {
    expect(formatSignedWei("1000000000000000000", "BOLD")).toBe("1.00 BOLD");
  });

  it("renders negative values with a leading minus", () => {
    expect(formatSignedWei("-1000000000000000000", "BOLD")).toBe("-1.00 BOLD");
  });

  it("renders zero as 0", () => {
    expect(formatSignedWei("0", "BOLD")).toBe("0 BOLD");
  });

  it("returns — only for null/undefined", () => {
    expect(formatSignedWei(null, "BOLD")).toBe("—");
    expect(formatSignedWei(undefined, "BOLD")).toBe("—");
  });
});
