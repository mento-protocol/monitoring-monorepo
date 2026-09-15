/**
 * Behavioral coverage for scripts/repo-health/mutation-harness-canary.mjs.
 *
 * The failure paths are the ones that matter. When Stryker exits non-zero, and
 * when it exits zero on a report that proves nothing — no mutants, or a
 * survivor — the runner must print `MUTATION HARNESS BROKEN` with the
 * installed versions and exit non-zero, so a broken harness never reads as
 * weak tests. The tests stub `stryker` on PATH, so they need no Stryker
 * install and no run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const RUNNER = fileURLToPath(
  new URL("./mutation-harness-canary.mjs", import.meta.url),
);

const REPORT_FILE = path.join("reports", "mutation", "harness-canary.json");

const workspace = mkdtempSync(path.join(tmpdir(), "mutation-canary-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

let fixtureCounter = 0;

/** A Stryker JSON report listing one mutant per given status. */
function reportWith(statuses) {
  return JSON.stringify({
    schemaVersion: "1.0",
    files: {
      "test/harness-canary/subject.ts": {
        language: "typescript",
        source: "export const canary = 1;\n",
        mutants: statuses.map((status, index) => ({
          id: String(index),
          mutatorName: "ArithmeticOperator",
          status,
        })),
      },
    },
  });
}

/**
 * A package root with a `stryker` stub on PATH. `versions` maps a dependency
 * name to the version its stubbed node_modules manifest reports; omit one to
 * leave it uninstalled. `mutantStatuses` is the report the stub writes; omit
 * it to have the stub write no report at all.
 */
function newFixture({ name, exitCode, versions, mutantStatuses }) {
  fixtureCounter += 1;
  const base = path.join(workspace, `fixture-${fixtureCounter}`);
  const packageRoot = path.join(base, name);
  const binDir = path.join(base, "bin");
  const argvLog = path.join(base, "stryker-argv.txt");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  for (const [dependency, version] of Object.entries(versions)) {
    const manifestDir = path.join(packageRoot, "node_modules", dependency);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      path.join(manifestDir, "package.json"),
      `${JSON.stringify({ name: dependency, version })}\n`,
    );
  }

  const stubLines = ["#!/bin/sh", `echo "$@" > "${argvLog}"`];
  if (mutantStatuses) {
    const source = path.join(base, "report.json");
    writeFileSync(source, `${reportWith(mutantStatuses)}\n`);
    stubLines.push(
      `mkdir -p "${path.dirname(REPORT_FILE)}"`,
      `cp "${source}" "${REPORT_FILE}"`,
    );
  }
  stubLines.push(`exit ${exitCode}`, "");

  const stub = path.join(binDir, "stryker");
  writeFileSync(stub, stubLines.join("\n"));
  chmodSync(stub, 0o755);

  return { packageRoot, binDir, argvLog };
}

/** Leave a report from an earlier run in place before the runner starts. */
function seedStaleReport(fixture, statuses) {
  const stale = path.join(fixture.packageRoot, REPORT_FILE);
  mkdirSync(path.dirname(stale), { recursive: true });
  writeFileSync(stale, `${reportWith(statuses)}\n`);
}

function runRunner(fixture) {
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: fixture.packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("passes and counts the mutants when every one is detected", () => {
  const fixture = newFixture({
    name: "metrics-bridge",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
    mutantStatuses: ["Killed", "Killed", "Timeout"],
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /Mutation harness canary passed for metrics-bridge: 3 mutants, all detected\./,
  );
  assert.doesNotMatch(result.stderr, /MUTATION HARNESS BROKEN/);
});

test("runs the canary config, not the real one", () => {
  const fixture = newFixture({
    name: "ui-dashboard",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
    mutantStatuses: ["Killed"],
  });

  runRunner(fixture);

  assert.equal(readArgv(fixture.argvLog), "run stryker.canary.config.mjs");
});

test("reports a broken harness with the installed versions", () => {
  const fixture = newFixture({
    name: "indexer-envio",
    exitCode: 1,
    versions: {
      vitest: "5.0.0",
      "@stryker-mutator/vitest-runner": "9.6.1",
      "@stryker-mutator/core": "9.6.1",
    },
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /MUTATION HARNESS BROKEN/);
  assert.match(result.stderr, /package: indexer-envio/);
  assert.match(result.stderr, /reason: Stryker exited non-zero\./);
  assert.match(result.stderr, /vitest: 5\.0\.0/);
  assert.match(result.stderr, /@stryker-mutator\/vitest-runner: 9\.6\.1/);
  assert.match(result.stderr, /@stryker-mutator\/core: 9\.6\.1/);
  assert.match(result.stderr, /docs\/mutation-testing\.md/);
});

test("propagates Stryker's exit code", () => {
  const fixture = newFixture({
    name: "indexer-envio",
    exitCode: 3,
    versions: { vitest: "4.1.11" },
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 3);
});

test("fails a zero-exit run that generated no mutants", () => {
  const fixture = newFixture({
    name: "indexer-envio",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
    mutantStatuses: [],
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /MUTATION HARNESS BROKEN/);
  assert.match(result.stderr, /generated no mutants/);
});

test("fails a zero-exit run that left a mutant undetected", () => {
  const fixture = newFixture({
    name: "ui-dashboard",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
    mutantStatuses: ["Killed", "Survived", "NoCoverage"],
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /left 2 of 3 canary mutants undetected/);
});

test("fails when Stryker writes no report", () => {
  const fixture = newFixture({
    name: "metrics-bridge",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /wrote no readable report/);
});

test("never reads a report left by an earlier run", () => {
  const fixture = newFixture({
    name: "metrics-bridge",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
  });
  seedStaleReport(fixture, ["Killed", "Killed"]);

  const result = runRunner(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /wrote no readable report/);
});

test("names an uninstalled dependency instead of throwing", () => {
  const fixture = newFixture({
    name: "metrics-bridge",
    exitCode: 1,
    versions: {},
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /vitest: not installed/);
  assert.match(result.stderr, /@stryker-mutator\/vitest-runner: not installed/);
});

/** The arguments the stub received, trimmed of its trailing newline. */
function readArgv(argvLog) {
  return readFileSync(argvLog, "utf8").trim();
}
