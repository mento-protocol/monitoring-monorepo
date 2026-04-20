import { describe, it, expect } from "vitest";
import { wormholescanUrl } from "../urls";

describe("wormholescanUrl", () => {
  it("builds the canonical Wormholescan tx-trace URL for a digest", () => {
    expect(
      wormholescanUrl(
        "0xabc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
      ),
    ).toBe(
      "https://wormholescan.io/#/tx/0xabc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
    );
  });
});
