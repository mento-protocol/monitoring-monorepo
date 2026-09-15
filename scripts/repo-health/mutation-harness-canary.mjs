#!/usr/bin/env node
/**
 * Run the mutation-testing harness canary for the package in the current
 * working directory.
 *
 * The canary mutates a fixture whose every mutant its own direct test kills,
 * so the score is 100% whenever Stryker still activates mutants. A score below
 * 100% means the harness is broken, not that the package's tests are weak.
 * That distinction is the whole point: in #2449 vitest 5 with
 * `@stryker-mutator/vitest-runner` 9.6.1 reported every mutant as survived
 * while every test passed, and each package's real run read as a test-strength
 * collapse.
 *
 * Run it from a package root, before that package's real mutation run.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageRoot = process.cwd();
const packageName = path.basename(packageRoot);

function installedVersion(dependency) {
  try {
    const manifest = path.join(
      packageRoot,
      "node_modules",
      dependency,
      "package.json",
    );
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return "not installed";
  }
}

const result = spawnSync("stryker", ["run", "stryker.canary.config.mjs"], {
  cwd: packageRoot,
  stdio: "inherit",
});

if (result.status === 0) {
  console.log(`Mutation harness canary passed for ${packageName}.`);
  process.exit(0);
}

console.error(
  [
    "",
    "MUTATION HARNESS BROKEN",
    `package: ${packageName}`,
    `vitest: ${installedVersion("vitest")}`,
    `@stryker-mutator/vitest-runner: ${installedVersion("@stryker-mutator/vitest-runner")}`,
    `@stryker-mutator/core: ${installedVersion("@stryker-mutator/core")}`,
    "",
    "Every canary mutant is killed by its own test, so Stryker scored below",
    "100% because it stopped activating mutants — most often a vitest major",
    "the installed Stryker vitest runner does not support. Fix the runner or",
    "the vitest version. Never lower a break floor to clear this.",
    "See docs/mutation-testing.md.",
    "",
  ].join("\n"),
);

process.exit(result.status ?? 1);
