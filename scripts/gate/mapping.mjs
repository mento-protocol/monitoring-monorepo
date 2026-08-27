#!/usr/bin/env node
/**
 * The gate's mapping layer: changed paths + repo facts in, command plan out.
 *
 * One Node process per gate run. It walks `ROUTING_GROUPS`, applies the five
 * whole-set post-passes, and writes the plan in the exact TSV shape
 * `write_command_plan` already emits, plus two further sections for the
 * surfaces and checklists the gate prints.
 *
 * THIS IS THE ROUTING THAT RUNS, and the only routing there is. D5b part 2
 * flipped the gate to build its plan from this module's output behind an
 * in-gate byte comparison against the bash `case` arms; D5c retired the arms,
 * that comparison and the parity harness together once the soak was clean
 * (ADR 0069, issue 2020).
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ROUTING_PLAN } from "./routing-table/index.mjs";
import { Facts } from "./mapping/facts.mjs";
import { Plan, BUCKETS } from "./mapping/plan.mjs";
import { routeChangedPaths } from "./mapping/route.mjs";
import {
  addTrunkCheckCommand,
  addWorkspaceConfigBuild,
  applyScopedTestCommands,
  compactTurboQualityCommands,
  narrowCodeHealthDepsCommand,
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
    verbs.addPegRegistryIntegrityCheck(
      plan,
      "root lockfile changed (peg registry authority dependency)",
      facts,
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
  let sensitive = false;
  for (const path of changedPaths) {
    const verdict = isRoutingSensitivePath(path);
    // The gate accepts only `true` or `false` from this classifier and exits 2
    // on anything else. Reading a non-boolean as falsey here would drop
    // `--check-fixtures` from the plan, which is the smaller-plan direction.
    if (typeof verdict !== "boolean") {
      const failure = new Error(
        `${classifier} returned a non-boolean for ${JSON.stringify(path)}`,
      );
      failure.exitCode = 2;
      throw failure;
    }
    if (verdict) sensitive = true;
  }
  return sensitive;
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

  // Post-loop sweeps, before the five post-passes.
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
  addWorkspaceConfigBuild(plan);
  compactTurboQualityCommands(plan);
  applyScopedTestCommands(plan, changedPaths, facts);
  // Last: it reads the finished quality bucket, and it is the only pass that
  // removes a command, so nothing after it can reintroduce one.
  narrowCodeHealthDepsCommand(plan, changedPaths);
  return plan;
}

/**
 * The plan as the TSV record stream the gate reads back.
 *
 * ORDER IS THE CONTRACT, in both directions: the gate prints surfaces,
 * checklists and each bucket in exactly this sequence, and `write_command_plan`
 * hashes the bucket records in exactly this sequence. A reordering here is a
 * different stamp and a different stdout for two Node consumers that parse it.
 *
 * The `flag` records carry the two run-scoped booleans the routing sets that
 * are not commands. `package_script_risk_changed` gates the gate's refusal to
 * run at all, so the swap has to carry it across the seam or that refusal
 * quietly stops happening.
 */
export function formatPlan(plan) {
  const lines = [];
  lines.push(
    `flag\tpackage_script_risk_changed\t${plan.packageScriptRiskChanged === true}`,
  );
  lines.push(
    `flag\tsaw_workspace_escalation\t${plan.sawWorkspaceEscalation === true}`,
  );
  for (const surface of plan.surfaces) lines.push(`surface\t${surface}`);
  for (const entry of plan.checklists) {
    lines.push(`checklist\t${entry.checklist}\t${entry.reason}`);
  }
  for (const bucket of BUCKETS) {
    for (const entry of plan.buckets.get(bucket)) {
      lines.push(`${bucket}\t${entry.command}\t${entry.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The command-line entry point the gate calls, once per run.
 *
 * Every failure path here is a REFUSAL with a non-zero exit and a reason on
 * stderr. The gate turns any non-zero exit into a refusal of the whole run,
 * because the alternative — a mapper that fails and lets the run continue on
 * whatever it managed to emit — is the smaller plan this rewrite exists to
 * prevent.
 */
async function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) return null;
    const value = argv[index + 1];
    if (value === undefined) {
      throw Object.assign(new Error(`${name} requires a value`), {
        exitCode: 2,
      });
    }
    return value;
  };

  const required = (name) => {
    const value = option(name);
    if (value === null) {
      throw Object.assign(new Error(`${name} is required`), { exitCode: 2 });
    }
    return value;
  };

  const repoRoot = required("--repo-root");
  const changedPathsFile = required("--changed-paths-file");
  const scriptSourceDir = required("--script-source-dir");
  const facts = new Facts({
    repoRoot,
    baseRef: required("--base"),
    headRef: required("--head"),
    changedPathsFile,
    isRealTree: argv.includes("--real-tree"),
    fullLocalTests: argv.includes("--full-local-tests"),
    scriptSourceDir,
  });

  // The gate's already-normalized set: `sed '/^$/d' | sort -u` has run, and
  // that ordering is routing, because `add_command` keeps the FIRST reason it
  // is given. Re-deriving it here would be guessing at the collation the
  // gate's `sort` used.
  const changedPaths = readFileSync(changedPathsFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "");
  if (changedPaths.length === 0) {
    throw Object.assign(
      new Error(`${changedPathsFile} holds no changed paths`),
      { exitCode: 2 },
    );
  }

  const routingSensitive = await routingSensitivePathsChanged(
    changedPaths,
    scriptSourceDir,
  );
  process.stdout.write(
    formatPlan(buildPlan({ changedPaths, facts, routingSensitive })),
  );
  return 0;
}

/**
 * Whether this module was RUN rather than imported.
 *
 * Not a string comparison against `process.argv[1]`. Node resolves the main
 * entry to its realpath before building `import.meta.url`, and leaves
 * `process.argv[1]` as the path it was handed — so the naive comparison is
 * false for every invocation that reaches this file through a symlink. Measured:
 * the gate's own suite builds `scripts/` mirrors out of symlinks, macOS `/tmp`
 * is a symlink to `/private/tmp`, and a checkout under a symlinked home is
 * ordinary. In all of those `main()` never ran, the mapper exited 0 having
 * written nothing, and the gate refused every run with "produced an empty plan"
 * — fail-closed, but pointing at the engine instead of at the path.
 */
function invokedAsScript() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const here = fileURLToPath(import.meta.url);
  if (entry === here) return true;
  try {
    return realpathSync(entry) === realpathSync(here);
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // writeSync, not console.error: `process.exit` drops whatever is still
    // queued on an async stderr, and the gate runs this under a pipe.
    writeSync(2, `agent quality gate mapper: ${message}\n`);
    process.exit(typeof error?.exitCode === "number" ? error.exitCode : 1);
  }
}
