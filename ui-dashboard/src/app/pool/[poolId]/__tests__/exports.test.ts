import { describe, expect, it } from "vitest";

// Characterization test for the upcoming pool-page extraction refactor.
//
// `__tests__/ols.test.ts` and other consumers import these symbols directly
// from `../page`. After the refactor moves them into `_components/` and
// `_lib/`, `page.tsx` MUST keep re-exporting them so external import paths
// stay stable. This test fails loudly if any of these symbols disappears
// from the page module's public surface.

import * as PageModule from "../page";

describe("pool/[poolId]/page public exports (refactor stability pin)", () => {
  it.each([
    ["decodePoolId", "function"],
    ["parseTabLimit", "function"],
    ["getDebtTokenSideLabel", "function"],
    ["selectActiveOlsPool", "function"],
    ["OlsStatusPanel", "function"],
    ["OlsLiquidityTable", "function"],
    ["computeRewardThresholds", "function"],
    ["renderRewardCell", "function"],
    ["toDisplayPrecision", "function"],
  ] as const)("re-exports %s as a %s", (name, kind) => {
    const value = (PageModule as Record<string, unknown>)[name];
    expect(
      value,
      `Expected page.tsx to export ${name}; the refactor must re-export it.`,
    ).toBeDefined();
    // Components and helpers are both functions in JS terms.
    expect(typeof value).toBe(kind);
  });

  it("re-exports default PoolDetailPage component", () => {
    expect(PageModule.default).toBeDefined();
    expect(typeof PageModule.default).toBe("function");
  });
});
