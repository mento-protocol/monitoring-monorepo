import assert from "node:assert/strict";
import {
  isVirtualPool,
  needsOracleReporterCountRefresh,
} from "../src/helpers.js";

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

describe("needsOracleReporterCountRefresh", () => {
  it("refreshes unknown negative reporter counts", () => {
    assert.equal(
      needsOracleReporterCountRefresh({
        source: "fpmm_factory",
        oracleNumReporters: -1,
      }),
      true,
    );
  });

  it("refreshes legacy zero reporter counts on VirtualPools", () => {
    assert.equal(
      needsOracleReporterCountRefresh({
        source: "virtual_pool_factory",
        oracleNumReporters: 0,
      }),
      true,
    );
  });

  it("does not refresh known zero reporter counts on FPMM pools", () => {
    assert.equal(
      needsOracleReporterCountRefresh({
        source: "fpmm_factory",
        oracleNumReporters: 0,
      }),
      false,
    );
  });

  it("does not refresh positive reporter counts", () => {
    assert.equal(
      needsOracleReporterCountRefresh({
        source: "virtual_pool_factory",
        oracleNumReporters: 2,
      }),
      false,
    );
  });
});
