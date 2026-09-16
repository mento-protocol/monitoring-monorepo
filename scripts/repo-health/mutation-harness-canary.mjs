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
 * Stryker's exit code alone is not enough. A run that generates no valid
 * mutants scores NaN, and `NaN < break` is false, so Stryker exits 0. This
 * runner therefore reads the canary's JSON report and requires at least one
 * mutant with every mutant killed.
 *
 * Run it from a package root, before that package's real mutation run.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

const packageRoot = process.cwd();
const packageName = path.basename(packageRoot);
// `stryker.canary.config.mjs` writes this. The real run writes
// `reports/mutation/mutation.json`, so the two never collide.
const reportFile = path.join("reports", "mutation", "harness-canary.json");
const reportPath = path.join(packageRoot, reportFile);

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

/**
 * Print the diagnostic and exit. `status` carries Stryker's own exit code when
 * it has one.
 */
function reportBroken(reason, status) {
  console.error(
    [
      "",
      "MUTATION HARNESS BROKEN",
      `package: ${packageName}`,
      `reason: ${reason}`,
      `vitest: ${installedVersion("vitest")}`,
      `@stryker-mutator/vitest-runner: ${installedVersion("@stryker-mutator/vitest-runner")}`,
      `@stryker-mutator/core: ${installedVersion("@stryker-mutator/core")}`,
      "",
      "Every canary mutant is killed by its own test, so the canary fails only",
      "when Stryker stops generating or activating mutants — most often a",
      "vitest major the installed Stryker vitest runner does not support. Fix",
      "the runner or the vitest version. Never lower a break floor to clear",
      "this.",
      "See docs/mutation-testing.md.",
      "",
    ].join("\n"),
  );
  process.exit(status);
}

/** Every mutant the canary report recorded. */
function reportedMutants() {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return Object.values(report.files ?? {}).flatMap(
    (file) => file.mutants ?? [],
  );
}

// A stale report from an earlier run must never stand in for this one.
rmSync(reportPath, { force: true });

const result = spawnSync("stryker", ["run", "stryker.canary.config.mjs"], {
  cwd: packageRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  reportBroken("Stryker exited non-zero.", result.status ?? 1);
}

let mutants = [];
try {
  mutants = reportedMutants();
} catch {
  reportBroken(`Stryker wrote no readable report at ${reportFile}.`, 1);
}

if (mutants.length === 0) {
  reportBroken(
    "Stryker generated no mutants, so it scored NaN and cleared the break threshold.",
    1,
  );
}

// Killed is the only passing status. The fixture is one addition and one
// ternary, so no mutant can legitimately hang: a Timeout means the runner
// failed, not that the direct test killed the mutant.
const unkilled = mutants.filter((mutant) => mutant.status !== "Killed");

if (unkilled.length > 0) {
  const statuses = [...new Set(unkilled.map((mutant) => mutant.status))]
    .sort()
    .join(", ");
  reportBroken(
    `Stryker left ${unkilled.length} of ${mutants.length} canary mutants unkilled (${statuses}).`,
    1,
  );
}

console.log(
  `Mutation harness canary passed for ${packageName}: ${mutants.length} mutants, all killed.`,
);
process.exit(0);
