import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool, TradingLimit } from "@/lib/types";
import { LimitStatusValue } from "@/components/pool-header/limit-status-value";

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: null,
  token1: null,
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1",
};

function limit(overrides: Partial<TradingLimit> = {}): TradingLimit {
  return {
    id: "limit-1",
    poolId: BASE_POOL.id,
    token: "0xtoken",
    limit0: "1000000000000000000000",
    limit1: "2000000000000000000000",
    decimals: 18,
    netflow0: "500000000000000000000",
    netflow1: "250000000000000000000",
    lastUpdated0: "1",
    lastUpdated1: "1",
    limitPressure0: "0.5",
    limitPressure1: "0.125",
    limitStatus: "OK",
    updatedAtBlock: "1",
    updatedAtTimestamp: "1",
    ...overrides,
  };
}

describe("LimitStatusValue", () => {
  it("renders the highest-pressure L0/L1 windows and capped progress text", () => {
    const html = renderToStaticMarkup(
      <LimitStatusValue
        pool={BASE_POOL}
        tradingLimits={[
          limit(),
          limit({
            id: "limit-2",
            limit0: "1000000000000000000000",
            netflow0: "1500000000000000000000",
            limitPressure0: "1.5",
          }),
        ]}
      />,
    );

    expect(html).toContain("1.5M/1M");
    expect(html).toContain("250K/2M");
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-valuetext="150% (over limit)"');
  });

  it("renders explicit degraded and neutral states", () => {
    expect(
      renderToStaticMarkup(
        <LimitStatusValue pool={BASE_POOL} tradingLimits={[]} hasError />,
      ),
    ).toContain("Query failed");

    expect(
      renderToStaticMarkup(
        <LimitStatusValue
          pool={{ ...BASE_POOL, source: "virtual_pool" }}
          tradingLimits={[limit()]}
        />,
      ),
    ).toContain("—");

    expect(
      renderToStaticMarkup(
        <LimitStatusValue pool={BASE_POOL} tradingLimits={[]} />,
      ),
    ).toContain("—");
  });
});
