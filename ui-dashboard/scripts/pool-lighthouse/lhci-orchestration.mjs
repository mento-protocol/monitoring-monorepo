import { existsSync } from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  assert,
  CANONICAL_POOL_PATH,
  diagnosticsScript,
  EXPECTED_RUNS,
  FIXTURE_GRAPHQL_DELAY_FLOOR_MS,
  lighthouseConfig,
  log,
  repoRoot,
  TARGET_QUERY,
} from "./contract.mjs";
import { assertFixtureDiagnosticsFile } from "./fixture-diagnostics-contract.mjs";
import { runCommand } from "./subprocess.mjs";

function lhciExecutable() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@lhci/cli/package.json");
  const packageJson = require(packagePath);
  return resolve(dirname(packagePath), packageJson.bin.lhci);
}

async function copyLhciArtifacts(lhciDir, reportsDir, outputDir) {
  if (existsSync(lhciDir)) {
    await cp(lhciDir, join(outputDir, "lhr"), {
      recursive: true,
      force: true,
    });
  }
  if (existsSync(reportsDir)) {
    await cp(reportsDir, join(outputDir, "reports"), {
      recursive: true,
      force: true,
    });
  }
}

async function assertFixtureLcpContract(lhciDir, targetUrl) {
  const assertionsPath = join(lhciDir, "assertion-results.json");
  assert(
    existsSync(assertionsPath),
    "LHCI did not produce assertion-results.json for the fixture audit",
  );
  let assertions;
  try {
    assertions = JSON.parse(await readFile(assertionsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse fixture assertion results: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    Array.isArray(assertions),
    "Fixture assertion-results.json must contain an array",
  );
  const targetHref = new URL(targetUrl).href;
  const lcpAssertions = assertions.filter(
    (result) =>
      result?.auditId === "largest-contentful-paint" &&
      result?.url === targetHref,
  );
  assert(
    lcpAssertions.length === 1,
    `Expected exactly one fixture LCP assertion for ${targetHref}, found ${lcpAssertions.length}`,
  );
  const [lcp] = lcpAssertions;
  assert(lcp.level === "error", "Fixture LCP assertion must be blocking");
  assert(
    lcp.name === "maxNumericValue" &&
      lcp.operator === "<=" &&
      lcp.expected === 1700,
    `Fixture LCP assertion must enforce <= 1700 ms, got ${lcp.operator ?? "unknown"} ${lcp.expected ?? "unknown"}`,
  );
  assert(
    Array.isArray(lcp.values) &&
      lcp.values.length === EXPECTED_RUNS &&
      lcp.values.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ),
    `Fixture LCP assertion must aggregate ${EXPECTED_RUNS} numeric runs`,
  );
  assert(
    lcp.passed === true,
    `Fixture median LCP ${lcp.actual ?? "unknown"} ms exceeded the 1700 ms ceiling`,
  );
  log(
    `Blocking fixture LCP assertion ran across ${lcp.values.length} values; median ${lcp.actual}ms`,
  );
}

export async function runLighthouse({
  targetUrl,
  outputDir,
  executablePath,
  tempRoot,
}) {
  const reportsDir = join(tempRoot, "reports");
  const lhciDir = join(tempRoot, ".lighthouseci");
  await mkdir(reportsDir, { recursive: true });
  let lhciCode = 1;
  let assertCode = 1;
  let assertionError = null;
  try {
    lhciCode = await runCommand(
      process.execPath,
      [
        lhciExecutable(),
        "autorun",
        `--config=${lighthouseConfig}`,
        `--collect.url=${targetUrl}`,
        `--collect.numberOfRuns=${EXPECTED_RUNS}`,
        "--upload.target=filesystem",
        `--upload.outputDir=${reportsDir}`,
      ],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          CHROME_PATH: executablePath,
          CI: "true",
        },
        allowFailure: true,
      },
    );
    assertCode = await runCommand(
      process.execPath,
      [
        lhciExecutable(),
        "assert",
        `--config=${lighthouseConfig}`,
        "--includePassedAssertions=true",
      ],
      {
        cwd: tempRoot,
        env: { ...process.env, CI: "true" },
        allowFailure: true,
      },
    );
    try {
      await assertFixtureLcpContract(lhciDir, targetUrl);
    } catch (error) {
      assertionError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await copyLhciArtifacts(lhciDir, reportsDir, outputDir);
  }

  assert(
    existsSync(join(outputDir, "lhr")),
    "LHCI did not produce a .lighthouseci report directory",
  );
  const diagnosticsJson = join(outputDir, "fixture-diagnostics.json");
  const diagnosticsMarkdown = join(outputDir, "fixture-diagnostics.md");
  const diagnosticsCode = await runCommand(
    process.execPath,
    [
      diagnosticsScript,
      "--dir",
      join(outputDir, "lhr"),
      "--path",
      `${CANONICAL_POOL_PATH}?${TARGET_QUERY}`,
      "--expected-runs",
      String(EXPECTED_RUNS),
      "--output-json",
      diagnosticsJson,
      "--output-markdown",
      diagnosticsMarkdown,
    ],
    { cwd: repoRoot, env: process.env, allowFailure: true },
  );
  let diagnosticsContractError = null;
  if (diagnosticsCode === 0) {
    try {
      await assertFixtureDiagnosticsFile(
        diagnosticsJson,
        EXPECTED_RUNS,
        FIXTURE_GRAPHQL_DELAY_FLOOR_MS,
      );
      log(
        `Fixture diagnostics prove exactly ${EXPECTED_RUNS} Lighthouse run(s) each kept delayed GraphQL completion >${FIXTURE_GRAPHQL_DELAY_FLOOR_MS}ms and after LCP`,
      );
    } catch (error) {
      diagnosticsContractError =
        error instanceof Error ? error.message : String(error);
    }
  }
  const failures = [];
  if (lhciCode !== 0) failures.push(`LHCI autorun exited ${lhciCode}`);
  if (assertCode !== 0) {
    failures.push(`LHCI fixture assert exited ${assertCode}`);
  }
  if (assertionError !== null) failures.push(assertionError);
  if (diagnosticsCode !== 0) {
    failures.push(`fixture diagnostics exited ${diagnosticsCode}`);
  }
  if (diagnosticsContractError !== null) {
    failures.push(diagnosticsContractError);
  }
  assert(failures.length === 0, failures.join("; "));
}
