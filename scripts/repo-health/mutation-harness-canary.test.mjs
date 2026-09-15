/**
 * Behavioral coverage for scripts/repo-health/mutation-harness-canary.mjs.
 *
 * The failure path is the one that matters: when Stryker exits non-zero the
 * runner must print `MUTATION HARNESS BROKEN` with the installed versions and
 * propagate the exit code, so a broken harness never reads as weak tests. The
 * tests stub `stryker` on PATH, so they need no Stryker install and no run.
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

const workspace = mkdtempSync(path.join(tmpdir(), "mutation-canary-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

let fixtureCounter = 0;

/**
 * A package root with a `stryker` stub on PATH. `versions` maps a dependency
 * name to the version its stubbed node_modules manifest reports; omit one to
 * leave it uninstalled.
 */
function newFixture({ name, exitCode, versions }) {
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

  const stub = path.join(binDir, "stryker");
  writeFileSync(
    stub,
    ["#!/bin/sh", `echo "$@" > "${argvLog}"`, `exit ${exitCode}`, ""].join(
      "\n",
    ),
  );
  chmodSync(stub, 0o755);

  return { packageRoot, binDir, argvLog };
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

test("passes and names the package when Stryker exits zero", () => {
  const fixture = newFixture({
    name: "metrics-bridge",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
  });

  const result = runRunner(fixture);

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /Mutation harness canary passed for metrics-bridge\./,
  );
  assert.doesNotMatch(result.stderr, /MUTATION HARNESS BROKEN/);
});

test("runs the canary config, not the real one", () => {
  const fixture = newFixture({
    name: "ui-dashboard",
    exitCode: 0,
    versions: { vitest: "4.1.11" },
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
