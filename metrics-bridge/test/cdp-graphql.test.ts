import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "graphql-request";

// Same mock shape as graphql.test.ts: `vi.hoisted` lifts the spy so the
// hoisted `vi.mock` factory can reference it, and `ClientError` stays real so
// the SUT's `instanceof` check in isUnknownFieldError still works.
const { requestSpy } = vi.hoisted(() => ({ requestSpy: vi.fn() }));
vi.mock("graphql-request", async () => {
  const actual =
    await vi.importActual<typeof import("graphql-request")>("graphql-request");
  class MockGraphQLClient {
    request = requestSpy;
  }
  return {
    ...actual,
    GraphQLClient: MockGraphQLClient,
  };
});

import { fetchCdps } from "../src/cdp-graphql.js";

const GBPM_TM = "0xb38aef2bf4e34b997330d626ebcd7629de3885c9";
const JPYM_TM = "0xd2e65af47d927d5e84f384ae6bac4f97c3da65df";

function instance(troveManager: string) {
  return {
    id: `42220-${troveManager}`,
    collateralId: `42220-${troveManager}`,
    chainId: 42220,
    systemDebt: "1",
    spDeposits: "1",
    spHeadroom: "1",
    isShutDown: false,
    liqCountCum: 0,
    redemptionCountCum: 0,
    rebalanceRedemptionCountCum: 0,
    shortfallSubsidyCum: "0",
  };
}

function collateral(troveManager: string, symbol: string) {
  return {
    id: `42220-${troveManager}`,
    symbol,
    chainId: 42220,
    troveManager,
    debtToken: "0x0000000000000000000000000000000000000001",
    systemParamsLoaded: true,
  };
}

function missingEntityError(): ClientError {
  // Shape Hasura returns before it has tracked the CDP entities — matches the
  // SUT's `/field ... not found/` degradation guard.
  return new ClientError(
    {
      data: undefined,
      errors: [
        { message: "field 'LiquityInstance' not found in type: 'query_root'" },
      ],
      status: 200,
      headers: new Headers(),
    },
    { query: "..." },
  );
}

describe("fetchCdps", () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("joins each instance to its collateral by collateralId", async () => {
    requestSpy.mockResolvedValue({
      LiquityInstance: [instance(GBPM_TM), instance(JPYM_TM)],
      LiquityCollateral: [
        collateral(GBPM_TM, "GBPm"),
        collateral(JPYM_TM, "JPYm"),
      ],
    });
    const cdps = await fetchCdps();
    expect(cdps.map((c) => c.collateral.symbol).sort()).toEqual([
      "GBPm",
      "JPYm",
    ]);
    expect(cdps[0].instance.collateralId).toBe(cdps[0].collateral.id);
  });

  it("skips an instance with no matching collateral row (mid-bootstrap)", async () => {
    requestSpy.mockResolvedValue({
      LiquityInstance: [instance(GBPM_TM), instance(JPYM_TM)],
      LiquityCollateral: [collateral(GBPM_TM, "GBPm")], // JPYm collateral absent
    });
    const cdps = await fetchCdps();
    expect(cdps).toHaveLength(1);
    expect(cdps[0].collateral.symbol).toBe("GBPm");
  });

  it("degrades to [] (warn once) when the CDP entities aren't tracked yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    requestSpy.mockRejectedValue(missingEntityError());
    expect(await fetchCdps()).toEqual([]);
    expect(await fetchCdps()).toEqual([]);
    // Warned at most once across repeated misses (module-level latch).
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("re-throws a non-schema error (network/timeout) so the poll loop records it", async () => {
    requestSpy.mockRejectedValue(new Error("network down"));
    await expect(fetchCdps()).rejects.toThrow("network down");
  });
});
