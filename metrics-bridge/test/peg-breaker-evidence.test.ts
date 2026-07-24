import { describe, expect, it } from "vitest";
import { resolvePegBreakerEvidence } from "../src/peg/breaker-evidence.js";
import {
  PEG_BREAKER_CONFIG_LIMIT,
  type PegBreakerConfigRow,
} from "../src/peg/graphql.js";

function config(
  overrides: Partial<PegBreakerConfigRow> = {},
): PegBreakerConfigRow {
  return {
    id: "feed-breaker",
    enabled: true,
    rateChangeThreshold: "0",
    referenceValue: "1000000000000000000000000",
    lastMedianRate: "999000000000000000000000",
    lastUpdatedAt: "1800000000",
    status: "OK",
    tradingMode: 0,
    lastStatusUpdatedAt: "1799999990",
    breaker: {
      id: "breaker",
      address: "0x1111111111111111111111111111111111111111",
      kind: "VALUE_DELTA",
      defaultRateChangeThreshold: "50000000000000000000000",
      removed: false,
    },
    ...overrides,
  };
}

describe("peg breaker evidence", () => {
  it("uses the positive per-feed threshold or bounded inherited default without precision loss", () => {
    expect(resolvePegBreakerEvidence([config()]).breaker).toMatchObject({
      enabled: true,
      effectiveRateChangeThreshold: "50000000000000000000000",
      referenceValue: "1000000000000000000000000",
    });
    expect(
      resolvePegBreakerEvidence([
        config({ rateChangeThreshold: "25000000000000000000000" }),
      ]).breaker?.effectiveRateChangeThreshold,
    ).toBe("25000000000000000000000");
  });

  it("prefers one enabled breaker over disabled rows", () => {
    const result = resolvePegBreakerEvidence([
      config({
        id: "disabled",
        enabled: false,
        status: "OK",
      }),
      config({
        id: "enabled-tripped",
        enabled: true,
        status: "TRIPPED",
      }),
    ]);

    expect(result).toEqual({
      breaker: expect.objectContaining({
        id: "enabled-tripped",
        enabled: true,
        status: "TRIPPED",
      }),
      error: null,
    });
  });

  it("keeps a sole disabled breaker distinct from absent evidence", () => {
    expect(resolvePegBreakerEvidence([])).toEqual({
      breaker: null,
      error: null,
    });
    expect(resolvePegBreakerEvidence([config({ enabled: false })])).toEqual({
      breaker: expect.objectContaining({ enabled: false }),
      error: null,
    });
  });

  it("keeps ambiguous and saturated breaker evidence unavailable", () => {
    expect(resolvePegBreakerEvidence([])).toEqual({
      breaker: null,
      error: null,
    });
    expect(
      resolvePegBreakerEvidence([config(), config({ id: "other" })]).error
        ?.message,
    ).toMatch(/ambiguous/);
    expect(
      resolvePegBreakerEvidence([
        config({ id: "disabled-one", enabled: false }),
        config({ id: "disabled-two", enabled: false }),
      ]).error?.message,
    ).toMatch(/ambiguous/);
    expect(
      resolvePegBreakerEvidence(
        Array.from({ length: PEG_BREAKER_CONFIG_LIMIT }, (_, index) =>
          config({ id: `breaker-${index}` }),
        ),
      ).error?.message,
    ).toMatch(/bound/);
  });
});
