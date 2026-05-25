import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USD_PEGGED_SYMBOLS } from "../src/deviation-alert-state.js";

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
