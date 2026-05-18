import { describe, expect, it } from "vitest";
import { formatTokenAmount } from "./format";

describe("CDP format helpers", () => {
  it("treats only the -1 sentinel as unknown token amount", () => {
    expect(formatTokenAmount("-1", "GBPm")).toBe("—");
    expect(formatTokenAmount("-1000000000000000000", "GBPm")).toBe(
      "-1.00 GBPm",
    );
  });
});
