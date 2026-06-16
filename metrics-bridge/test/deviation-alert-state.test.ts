import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeDeviationAlertState,
  resetDeviationAlertStateForTests,
  USD_PEGGED_SYMBOLS,
} from "../src/deviation-alert-state.js";
import { makePool } from "./fixtures.js";

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function sortSymbols(symbols: Iterable<string>): string[] {
  return [...symbols].sort((a, b) => a.localeCompare(b));
}

function extractTsStringSet(source: string, name: string): string[] {
  const match = new RegExp(
    `const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`,
  ).exec(source);
  if (!match) throw new Error(`Could not find ${name} set`);
  return sortSymbols(
    [...match[1].matchAll(/"([^"]+)"/g)].map((m) => JSON.parse(m[0]) as string),
  );
}

function extractTerraformUsdPeggedSymbols(source: string): string[] {
  const match = /usd_pegged_symbols_regex_part\s*=\s*"\(([^"]+)\)"/.exec(
    source,
  );
  if (!match) throw new Error("Could not find usd_pegged_symbols_regex_part");
  return sortSymbols(match[1].split("|"));
}

describe("USD_PEGGED_SYMBOLS drift protection", () => {
  it("matches dashboard token math and Terraform FX-weekend suppression", () => {
    const dashboardSymbols = extractTsStringSet(
      repoFile("ui-dashboard/src/lib/tokens.ts"),
      "USD_PEGGED_SYMBOLS",
    );
    const terraformSymbols = extractTerraformUsdPeggedSymbols(
      repoFile("alerts/rules/main.tf"),
    );

    expect(sortSymbols(USD_PEGGED_SYMBOLS)).toEqual(dashboardSymbols);
    expect(terraformSymbols).toEqual(dashboardSymbols);
  });
});

describe("deviation alert transition rehydration", () => {
  afterEach(() => {
    resetDeviationAlertStateForTests();
  });

  it("uses persisted breach start after restart so recovery context is not suppressed", () => {
    const warning = observeDeviationAlertState(
      makePool({
        deviationBreachStartedAt: "1713200000",
        lastDeviationRatio: "1.02",
      }),
      "GBPm/USDm",
      1713202000,
    );

    expect(warning.state).toBe("warning");
    expect(warning.newTransitions).toHaveLength(0);

    const recovered = observeDeviationAlertState(
      makePool(),
      "GBPm/USDm",
      1713202030,
    );

    expect(recovered.newTransitions).toHaveLength(1);
    expect(recovered.newTransitions[0]).toMatchObject({
      reason: "recovered",
      breachStartedAt: 1713200000,
    });
  });

  it("does not backdate data-gap dwell from breach age after restart", () => {
    const unavailable = observeDeviationAlertState(
      makePool({
        deviationBreachStartedAt: "1713200000",
        lastDeviationRatio: "-1",
      }),
      "GBPm/USDm",
      1713202000,
    );

    expect(unavailable.state).toBe("deviation_ratio_unavailable_warning");
    expect(unavailable.newTransitions).toHaveLength(0);

    const restored = observeDeviationAlertState(
      makePool({
        deviationBreachStartedAt: "1713200000",
        lastDeviationRatio: "1.02",
      }),
      "GBPm/USDm",
      1713202030,
    );

    expect(restored.state).toBe("warning");
    expect(restored.newTransitions).toHaveLength(0);
  });
});
