// Check a campaign's inputs before any paid work: the stored plan against a
// rebuild of itself, and every writable root against the repository.

import path from "node:path";

import { canonicalPath } from "./review-eval-fixtures.mjs";
import { sourceCheckouts } from "./review-eval-run-execution.mjs";
import {
  buildExperimentPlan,
  stableValue,
} from "./review-eval-experiment-contract.mjs";
import {
  cliVersionDrift,
  isObject,
} from "./review-eval-experiment-versions.mjs";

/** Experiment artifacts and fixtures never land inside a source checkout. */
export function assertOutsideRepository(target, repoRoot, label) {
  const resolved = canonicalPath(path.resolve(target));
  const protectedRoots = new Set(
    sourceCheckouts({ env: {}, roots: [repoRoot] }).map((root) =>
      canonicalPath(path.resolve(root)),
    ),
  );
  for (const repository of protectedRoots) {
    const relative = path.relative(repository, resolved);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    ) {
      throw new Error(`${label} ${resolved} must be outside ${repository}`);
    }
  }
  return resolved;
}

const MAX_PLAN_DIFFERENCES = 8;

/** Name the paths where a stored plan and its rebuild disagree. */
function planDifferences(actual, expected, path = "", out = []) {
  if (out.length >= MAX_PLAN_DIFFERENCES) return out;
  if (JSON.stringify(actual) === JSON.stringify(expected)) return out;
  if (isObject(actual) && isObject(expected)) {
    for (const key of new Set([
      ...Object.keys(actual),
      ...Object.keys(expected),
    ])) {
      planDifferences(
        actual[key],
        expected[key],
        path ? `${path}.${key}` : key,
        out,
      );
    }
    return out;
  }
  if (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length
  ) {
    for (const [index, item] of actual.entries()) {
      planDifferences(item, expected[index], `${path}[${index}]`, out);
    }
    return out;
  }
  out.push(path || "plan");
  return out;
}

/**
 * Rebuild the plan from its own recorded inputs, including the draw count and
 * the CLI versions it was planned under, so a stored plan stays internally
 * consistent forever. A live probe passed as `cliVersions` is reported as
 * drift, not as a problem.
 */
export function validateExperimentPlan({
  plan,
  contract,
  contractDigest = plan?.contract_digest,
  cliVersions = null,
}) {
  const problems = [];
  let drift = null;
  try {
    if (!isObject(plan)) throw new Error("plan must be an object");
    const rebuilt = buildExperimentPlan({
      contract,
      contractDigest,
      plannedAt: plan.planned_at,
      incumbent: plan.incumbent,
      candidate: plan.candidate,
      cliVersions: plan?.inputs?.cli_versions,
      includeLivePaired: plan.stages?.["live-paired"]?.enabled === true,
      draws: plan.draws,
    });
    const differences = planDifferences(
      stableValue(plan),
      stableValue(rebuilt),
    );
    if (differences.length > 0) {
      problems.push(
        "plan differs from the complete deterministic campaign plan at " +
          differences.join(", "),
      );
    } else if (JSON.stringify(plan) !== JSON.stringify(rebuilt)) {
      problems.push("plan key order differs from the deterministic plan");
    }
    drift = cliVersionDrift({
      planned: rebuilt.inputs.cli_versions,
      live: cliVersions,
    });
  } catch (error) {
    problems.push(error.message);
  }
  return { ok: problems.length === 0, problems, drift };
}
