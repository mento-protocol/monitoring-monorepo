import { describe, expect, it } from "vitest";
import { mergeDeprecatedVirtualPools } from "../vp-deprecation";

describe("mergeDeprecatedVirtualPools", () => {
  it("merges minimum reports without marking the pool deprecated", () => {
    const [pool] = mergeDeprecatedVirtualPools(
      [{ id: "42220-0xpool", source: "virtual_pool_factory" }],
      [
        {
          wrappedByPoolId: "42220-0xpool",
          isDeprecated: false,
          minimumReports: "2",
        },
      ],
      [],
    );

    expect(pool).toMatchObject({
      id: "42220-0xpool",
      wrappedExchangeMinimumReports: "2",
    });
    expect(pool).not.toHaveProperty("wrappedExchangeDeprecated");
  });

  it("keeps lifecycle deprecation independent from exchange minimum reports", () => {
    const [pool] = mergeDeprecatedVirtualPools(
      [{ id: "42220-0xpool", source: "virtual_pool_factory" }],
      [],
      [{ poolId: "42220-0xpool" }],
    );

    expect(pool).toMatchObject({
      id: "42220-0xpool",
      wrappedExchangeDeprecated: true,
    });
    expect(pool).not.toHaveProperty("wrappedExchangeMinimumReports");
  });
});
