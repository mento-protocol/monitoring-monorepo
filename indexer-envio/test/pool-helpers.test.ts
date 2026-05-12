import assert from "node:assert/strict";
import { isVirtualPool } from "../src/helpers.js";

describe("isVirtualPool", () => {
  it("treats an empty wrappedExchangeId sentinel as non-virtual", () => {
    assert.equal(
      isVirtualPool({ source: "fpmm_swap", wrappedExchangeId: "" }),
      false,
    );
  });

  it("recognizes wrapped pools by populated wrappedExchangeId", () => {
    assert.equal(
      isVirtualPool({ source: "fpmm_swap", wrappedExchangeId: "0xabc" }),
      true,
    );
  });
});
