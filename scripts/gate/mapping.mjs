#!/usr/bin/env node
/**
 * The gate's mapping layer: changed paths + repo facts in, command plan out.
 *
 * One Node process per gate run. It walks `ROUTING_GROUPS`, applies the four
 * whole-set post-passes, and writes the plan in the exact TSV shape
 * `write_command_plan` already emits, plus two further sections for the
 * surfaces and checklists the gate prints.
 *
 * NOT YET WIRED INTO THE GATE. D5b lands this inert and proves it against the
 * live bash routing with the parity harness first; the gate is flipped to read
 * from it only once that parity is zero with a proven mutation control. Until
 * then the bash `case` arms are still the routing that runs, and this module
 * changes nothing about a gate run.
 *
 * FAIL CLOSED. Any unknown verb, guard, dispatch subject or dynamic source
 * throws, and this exits non-zero with the reason. The one outcome that must
 * never happen is a smaller plan produced quietly — a gate that runs fewer
 * checks and still prints "All mapped commands passed."
 *
 * Output format, one record per line:
 *
 *   surface\t<name>
 *   checklist\t<path>\t<reason>
 *   <bucket>\t<command>\t<reason>
 *
 * with buckets in preflight → codegen → post-codegen → quality order.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ROUTING_PLAN } from "./routing-table/index.mjs";
import { Plan, BUCKETS } from "./mapping/plan.mjs";
import { routeChangedPaths } from "./mapping/route.mjs";
import {
  addTrunkCheckCommand,
  applyScopedTestCommands,
  compactTurboQualityCommands,
  sortCodegenCommands,
} from "./mapping/post-passes.mjs";
import * as verbs from "./mapping/verbs.mjs";

/** Importer directory → the bundle a scoped lockfile change routes. */
const LOCKFILE_IMPORTER_BUNDLES = {
  aegis: (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/aegis");
    verbs.addAegisQualityCommands(plan, reason);
  },
  "ui-dashboard": (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/ui-dashboard");
    verbs.addDashboardQualityCommands(plan, reason);
    // Dependency resolution can regress bundle size, and the workspace route
    // ran size-limit for lockfile edits, so the scoped route must too.
    verbs.addUiSizeLimit(plan, reason);
  },
  "indexer-envio": (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/indexer-envio");
    // A changed Envio resolution can break testnet/bridge codegen even when
    // mainnet passes; keep the workspace route's coverage.
    verbs.addAllIndexerCodegen(plan, reason);
    verbs.addPackageQualityCommands(
      plan,
      "@mento-protocol/indexer-envio",
      reason,
    );
  },
  "metrics-bridge": (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/metrics-bridge");
    verbs.addPackageQualityCommands(
      plan,
      "@mento-protocol/metrics-bridge",
      reason,
    );
  },
  "integration-probes": (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/integration-probes");
    verbs.addPackageQualityCommands(
      plan,
      "@mento-protocol/integration-probes",
      reason,
    );
  },
  "shared-config": (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/config");
    verbs.addPackageQualityCommands(plan, "@mento-protocol/config", reason);
  },
  "governance-watchdog": (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/governance-watchdog");
    verbs.addPackageQualityCommands(
      plan,
      "@mento-protocol/governance-watchdog",
      reason,
    );
  },
  "alerts/infra/onchain-event-handler": (plan, reason) => {
    plan.markLockfileScopedPackage(
      "@mento-protocol/alerts-onchain-event-handler",
    );
    verbs.addPackageQualityCommands(
      plan,
      "@mento-protocol/alerts-onchain-event-handler",
      reason,
    );
  },
  "alerts/infra/oncall-announcer": (plan, reason) => {
    plan.markLockfileScopedPackage("@mento-protocol/alerts-oncall-announcer");
    verbs.addAlertsOncallQualityCommands(plan, reason);
  },
};

/** `[[ -f <path> ]]`: a regular file, following symlinks. */
const isRegularFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Workspace-manifest-class paths whose presence disqualifies lockfile scoping. */
const MANIFEST_CLASS = [
  /^package\.json$/,
  /\/package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^patches\//,
  /^\.npmrc$/,
  /\/\.npmrc$/,
  /^pnpmfile\.cjs$/,
  /^\.pnpmfile\.cjs$/,
  /^\.node-version$/,
];

/**
 * Route a `pnpm-lock.yaml` change: scoped when the lockfile is the only
 * manifest-class change AND every changed importer maps to a bundle, otherwise
 * the full workspace suite. Every ambiguity fails toward full.
 */
function makeLockfileRouter(changedPaths, scriptSourceDir) {
  return (plan, facts) => {
    plan.addSurface("workspace");
    plan.addPreflight(
      "pnpm install --frozen-lockfile",
      "workspace dependency/config changed",
    );
    plan.addCommand(
      "node scripts/alerts/check-peg-registry-integrity.mjs",
      "root lockfile changed (peg registry authority dependency)",
    );

    const classifier = join(scriptSourceDir, "gate", "lockfile-scope.mjs");
    // `[[ ! -f "$lockfile_scope_path" ]]` — a directory by that name is not a
    // classifier the gate could run either.
    if (!isRegularFile(classifier)) {
      // Fail-toward-full is right for an ambiguous lockfile and WRONG for a
      // classifier the gate cannot find: that failure is invisible, and every
      // lockfile change would silently widen while the run read as slow.
      const error = new Error(
        `lockfile scope classifier could not be loaded from ${classifier}`,
      );
      error.exitCode = 2;
      throw error;
    }

    const importers = scopedImporters(facts, classifier);
    const lockfileOnly =
      changedPaths.includes("pnpm-lock.yaml") &&
      !changedPaths.some((path) => MANIFEST_CLASS.some((r) => r.test(path)));

    if (
      lockfileOnly &&
      importers !== null &&
      importers.every((importer) => importer in LOCKFILE_IMPORTER_BUNDLES)
    ) {
      plan.addCommand("pnpm skew:check", "lockfile change scoped to importers");
      plan.addCommand(
        "pnpm lockfile:lint",
        "lockfile change scoped to importers",
      );
      for (const importer of importers) {
        LOCKFILE_IMPORTER_BUNDLES[importer](
          plan,
          `lockfile importer ${importer} changed`,
        );
      }
      return;
    }

    verbs.addWorkspaceQualityCommands(
      plan,
      "workspace dependency/config changed",
    );
    verbs.addAdrReminder(
      plan,
      "workspace membership/policy changed — ADR reminder (a new package likely needs an ADR)",
      facts,
    );
  };
}

/** Changed importer keys, or null when the change is not scopable. */
function scopedImporters(facts, classifier) {
  const base = gitShow(facts, `${facts.baseRef}:pnpm-lock.yaml`);
  if (base === null) return null;
  const head =
    facts.headRef === "HEAD" && facts.pathIsFile("pnpm-lock.yaml")
      ? readFileSync(join(facts.repoRoot, "pnpm-lock.yaml"))
      : gitShow(facts, `${facts.headRef}:pnpm-lock.yaml`);
  if (head === null) return null;

  const dir = mkdtempSync(join(tmpdir(), "gate-lockfile-"));
  try {
    const basePath = join(dir, "base");
    const headPath = join(dir, "head");
    writeFileSync(basePath, base);
    writeFileSync(headPath, head);
    const result = execFileSync("node", [classifier, basePath, headPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.split("\n").filter((line) => line !== "");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gitShow(facts, spec) {
  try {
    return execFileSync("git", ["-C", facts.repoRoot, "show", spec], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Whether any changed path is routing-sensitive, per the documentation
 * navigation evaluation's own classifier.
 *
 * The gate resolves this helper from `$script_source_dir` and exits 3 when it
 * cannot, because a classifier the gate cannot find fails invisibly — the
 * `--check-fixtures` command simply stops being scheduled. Same rule here.
 */
export async function routingSensitivePathsChanged(
  changedPaths,
  scriptSourceDir,
) {
  const classifier = join(
    scriptSourceDir,
    "docs",
    "docs-navigation-eval-helpers.mjs",
  );
  let isRoutingSensitivePath;
  try {
    ({ isRoutingSensitivePath } = await import(pathToFileURL(classifier).href));
  } catch (error) {
    const failure = new Error(
      `routing classifier could not be loaded from ${classifier}: ${error.message}`,
    );
    failure.exitCode = 3;
    throw failure;
  }
  if (typeof isRoutingSensitivePath !== "function") {
    const failure = new Error(
      `${classifier} does not export isRoutingSensitivePath`,
    );
    failure.exitCode = 3;
    throw failure;
  }
  return changedPaths.some((path) => isRoutingSensitivePath(path) === true);
}

/** Build the plan. Exported so tests and the parity harness can call it directly. */
export function buildPlan({ changedPaths, facts, routingSensitive = false }) {
  const plan = new Plan();
  const context = {
    plan,
    routeLockfileChange: makeLockfileRouter(
      changedPaths,
      facts.scriptSourceDir,
    ),
  };

  routeChangedPaths(ROUTING_PLAN, changedPaths, facts, context);

  // Post-loop sweeps, before the four post-passes.
  if (facts.isRealTree) {
    plan.addCommand(
      "pnpm tf:test",
      "non-empty change set validates production infrastructure contract",
    );
  }
  if (routingSensitive) {
    plan.addCommand(
      "pnpm docs:navigation-eval -- --check-fixtures",
      "routing-sensitive source changed",
    );
  }

  addTrunkCheckCommand(plan, changedPaths, facts);
  sortCodegenCommands(plan);
  compactTurboQualityCommands(plan);
  applyScopedTestCommands(plan, changedPaths, facts);
  return plan;
}

/** The plan as the TSV record stream the gate reads back. */
export function formatPlan(plan) {
  const lines = [];
  for (const surface of plan.surfaces) lines.push(`surface\t${surface}`);
  for (const entry of plan.checklists) {
    lines.push(`checklist\t${entry.checklist}\t${entry.reason}`);
  }
  for (const bucket of BUCKETS) {
    for (const entry of plan.buckets.get(bucket)) {
      lines.push(`${bucket}\t${entry.command}\t${entry.reason}`);
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
