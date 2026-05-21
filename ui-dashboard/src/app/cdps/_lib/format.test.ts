import { describe, expect, it } from "vitest";
import {
  formatTokenAmount,
  cdpSymbolSlug,
  formatAggregateAmount,
} from "./format";

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

  it("formatAggregateAmount prefixes >= only when truncated", () => {
    const val = BigInt("1000000000000000000"); // 1 token
    expect(formatAggregateAmount(val, "BOLD", false)).toMatch(/^1\.00 BOLD$/);
    expect(formatAggregateAmount(val, "BOLD", true)).toMatch(/^≥ 1\.00 BOLD$/);
  });

  it("formatAggregateAmount returns — for -1 sentinel regardless of truncated", () => {
    expect(formatAggregateAmount(BigInt(-1), "BOLD", false)).toBe("—");
    expect(formatAggregateAmount(BigInt(-1), "BOLD", true)).toBe("—");
  });
});
