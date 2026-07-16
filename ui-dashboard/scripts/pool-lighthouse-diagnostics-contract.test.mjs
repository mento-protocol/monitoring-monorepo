import { describe, expect, it } from "vitest";
import { assertFixtureDiagnosticsContract } from "./pool-lighthouse/fixture-diagnostics-contract.mjs";

const EXPECTED_RUNS = 3;
const MINIMUM_DELAY_MS = 1700;

function fixtureDiagnostics() {
  return {
    runs: Array.from({ length: EXPECTED_RUNS }, (_, index) => ({
      run: index + 1,
      graphql: {
        maxDurationMs: 2200 + index,
        completionRelativeToLcp: "after-lcp",
      },
    })),
  };
}

describe("pool Lighthouse fixture diagnostics contract", () => {
  it("accepts exactly three runs with delayed GraphQL completion after LCP", () => {
    const diagnostics = fixtureDiagnostics();

    expect(
      assertFixtureDiagnosticsContract(
        diagnostics,
        EXPECTED_RUNS,
        MINIMUM_DELAY_MS,
      ),
    ).toBe(diagnostics);
  });

  it("rejects too few runs", () => {
    const diagnostics = fixtureDiagnostics();
    diagnostics.runs.pop();

    expect(() =>
      assertFixtureDiagnosticsContract(
        diagnostics,
        EXPECTED_RUNS,
        MINIMUM_DELAY_MS,
      ),
    ).toThrow("Fixture diagnostics must contain exactly 3 runs, found 2");
  });

  it("rejects a GraphQL delay at or below the required minimum", () => {
    const diagnostics = fixtureDiagnostics();
    diagnostics.runs[1].graphql.maxDurationMs = MINIMUM_DELAY_MS;

    expect(() =>
      assertFixtureDiagnosticsContract(
        diagnostics,
        EXPECTED_RUNS,
        MINIMUM_DELAY_MS,
      ),
    ).toThrow(
      "Fixture diagnostics run 2 must record GraphQL maxDurationMs > 1700 ms, got 1700",
    );
  });

  it("rejects a missing GraphQL delay", () => {
    const diagnostics = fixtureDiagnostics();
    delete diagnostics.runs[1].graphql.maxDurationMs;

    expect(() =>
      assertFixtureDiagnosticsContract(
        diagnostics,
        EXPECTED_RUNS,
        MINIMUM_DELAY_MS,
      ),
    ).toThrow(
      "Fixture diagnostics run 2 must record GraphQL maxDurationMs > 1700 ms, got missing",
    );
  });

  it("rejects GraphQL completion before LCP", () => {
    const diagnostics = fixtureDiagnostics();
    diagnostics.runs[1].graphql.completionRelativeToLcp = "before-lcp";

    expect(() =>
      assertFixtureDiagnosticsContract(
        diagnostics,
        EXPECTED_RUNS,
        MINIMUM_DELAY_MS,
      ),
    ).toThrow(
      "Fixture diagnostics run 2 must record GraphQL completion after LCP, got before-lcp",
    );
  });
});
