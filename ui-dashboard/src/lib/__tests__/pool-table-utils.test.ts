import { describe, expect, it } from "vitest";
import { combinedTooltip } from "../pool-table-utils";
import type { Network } from "../networks";
import type { Pool } from "../types";

const network = { chainId: 42220 } as Network;

const pool = {
  id: "42220:0xpool",
  source: "fpmm_factory",
} as Pool;

const staleVirtualPool = {
  ...pool,
  source: "virtual_pool_factory",
  token0: "0xccf663b1ff11028f0b19058d0f7b674004a40746",
  token1: "0x765de816845861e75a25fca122bb6898b8b1282a",
  vpOracleTimestamp: "400",
  vpOracleFreshnessCheckedAt: 1000,
  oracleFreshnessWindow: "300",
  vpTokenDecimalsKnown: true,
  medianLive: true,
  vpOracleNumReporters: 2,
  wrappedExchangeMinimumReports: "1",
} as Pool;

describe("combinedTooltip", () => {
  it("does not describe unresolved FPMM health as a VirtualPool", () => {
    expect(combinedTooltip("N/A", "OK", pool, network, null)).toBe(
      "Health status pending live browser time",
    );
  });

  it("waits for live browser time before explaining stale VirtualPool freshness", () => {
    expect(combinedTooltip("N/A", "OK", staleVirtualPool, network, null)).toBe(
      "VirtualPool oracle freshness pending live browser time",
    );
  });

  it("keeps the VirtualPool explanation for resolved N/A health", () => {
    expect(
      combinedTooltip(
        "N/A",
        "OK",
        { ...staleVirtualPool, vpOracleTimestamp: "1000" },
        network,
        1000,
      ),
    ).toBe("VirtualPool — oracle health not tracked");
  });

  it("keeps the VirtualPool explanation when health is inapplicable", () => {
    expect(
      combinedTooltip(
        "N/A",
        "OK",
        {
          ...staleVirtualPool,
          wrappedExchangeDeprecated: true,
          hasHealthData: false,
        },
        network,
        null,
      ),
    ).toBe("VirtualPool — oracle health not tracked");
  });

  it("explains missing FPMM health data before pending browser time", () => {
    expect(
      combinedTooltip(
        "N/A",
        "OK",
        { ...pool, hasHealthData: false },
        network,
        null,
      ),
    ).toBe("Health data not yet available");
  });
});
