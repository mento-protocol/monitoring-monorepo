import { readFile } from "node:fs/promises";

export function assertFixtureDiagnosticsContract(
  diagnostics,
  expectedRuns,
  minimumGraphqlDelayMs,
) {
  if (!Number.isInteger(expectedRuns) || expectedRuns <= 0) {
    throw new Error("expectedRuns must be a positive integer");
  }
  if (
    typeof minimumGraphqlDelayMs !== "number" ||
    !Number.isFinite(minimumGraphqlDelayMs) ||
    minimumGraphqlDelayMs < 0
  ) {
    throw new Error("minimumGraphqlDelayMs must be a non-negative number");
  }
  const runs = diagnostics?.runs;
  if (!Array.isArray(runs)) {
    throw new Error("Fixture diagnostics must contain a runs array");
  }
  if (runs.length !== expectedRuns) {
    throw new Error(
      `Fixture diagnostics must contain exactly ${expectedRuns} runs, found ${runs.length}`,
    );
  }

  for (const [index, run] of runs.entries()) {
    const runLabel = run?.run ?? index + 1;
    const maxDurationMs = run?.graphql?.maxDurationMs;
    if (
      typeof maxDurationMs !== "number" ||
      !Number.isFinite(maxDurationMs) ||
      maxDurationMs <= minimumGraphqlDelayMs
    ) {
      throw new Error(
        `Fixture diagnostics run ${runLabel} must record GraphQL maxDurationMs > ${minimumGraphqlDelayMs} ms, got ${maxDurationMs ?? "missing"}`,
      );
    }
    const completion = run?.graphql?.completionRelativeToLcp;
    if (completion !== "after-lcp") {
      throw new Error(
        `Fixture diagnostics run ${runLabel} must record GraphQL completion after LCP, got ${completion ?? "missing"}`,
      );
    }
  }
  return diagnostics;
}

export async function assertFixtureDiagnosticsFile(
  diagnosticsPath,
  expectedRuns,
  minimumGraphqlDelayMs,
) {
  let diagnostics;
  try {
    diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read fixture diagnostics: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertFixtureDiagnosticsContract(
    diagnostics,
    expectedRuns,
    minimumGraphqlDelayMs,
  );
}
