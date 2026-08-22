#!/usr/bin/env node
/**
 * Differential parity: the Node mapping engine against the LIVE bash gate.
 *
 * A development tool for the D5b swap, deleted once the swap lands.
 *
 * DEVIATION FROM THE DESIGN, DELIBERATE. The design has this compare a gate
 * pinned in a separate worktree against a swapped gate. That shape exists
 * because it assumed the swap had already happened. Landing the engine INERT
 * first makes a simpler and stronger comparison available: the bash arms are
 * still the routing that runs, so the live gate IS the oracle, on the same tree
 * and the same commit, with no pinned worktree to keep in step. Every
 * difference is attributable to the engine rather than to a checkout skew.
 *
 * The observable is the gate's dry-run stdout — the routing contract two Node
 * consumers already parse and 1,229 suite assertions already assert on.
 *
 * ZERO differences is the pass condition, and a green run is not believed until
 * `--mutate` has been shown to red it.
 *
 * Usage:
 *   node scripts/gate/routing-parity.mjs --corpus tracked --limit 200
 *   node scripts/gate/routing-parity.mjs --mutate      # prove it can fail
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Facts } from "./mapping/facts.mjs";
import { buildPlan, routingSensitivePathsChanged } from "./mapping.mjs";
import { BUCKETS } from "./mapping/plan.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The gate's own dry-run stdout, reduced to the three observable sections.
 *
 * The header carries the base, the head and the Turbo cache directory, none of
 * which is routing; the changed-path echo is the input. Surfaces and checklists
 * are sets and are sorted; the command list keeps its order, because order is
 * an invariant the plan and the stamp both depend on.
 */
/**
 * Blank the changed-paths file each side happened to use.
 *
 * The ADR reminder embeds it, and the two sides legitimately differ: the gate
 * writes its own randomized scratch file, the harness writes one of its own.
 * `write_command_plan` already performs exactly this substitution before the
 * freshness stamp hashes the plan, for the same reason — the execution path is
 * not part of the routing. Anything else that differs is a real difference.
 */
const NORMALIZE_PATHS_FILE = /--changed-paths-file \S+/g;
const normalize = (line) =>
  line.replace(
    NORMALIZE_PATHS_FILE,
    "--changed-paths-file __CHANGED_PATHS_FILE__",
  );

function parseGateStdout(text) {
  const surfaces = [];
  const checklists = [];
  const commands = [];
  // The gate's own normalized changed-path set, in ITS order. The gate applies
  // `sed '/^$/d' | sort -u` to the input file, and that ordering is routing:
  // `add_command` keeps the first reason it is given, so iterating the set in a
  // different order produces the same commands with different reasons. Feeding
  // the engine what the gate printed removes the question entirely — including
  // the collation the gate's `sort` happened to use, which is locale-dependent
  // and therefore not something this harness should try to reproduce.
  const changedPaths = [];
  let section = null;
  for (const line of text.split("\n")) {
    if (line === "Detected surfaces:") {
      section = "surface";
      continue;
    }
    if (line === "Required checklist review:") {
      section = "checklist";
      continue;
    }
    if (line === "Mapped safe local commands:") {
      section = "command";
      continue;
    }
    if (line === "Changed paths:") {
      section = "changed";
      continue;
    }
    if (line === "") {
      section = null;
      continue;
    }
    if (section === null || !line.startsWith("- ")) continue;
    const body = line.slice(2);
    if (section === "surface") surfaces.push(body);
    else if (section === "checklist") checklists.push(body);
    else if (section === "command") commands.push(normalize(body));
    else if (section === "changed") changedPaths.push(body);
  }
  return {
    surfaces: surfaces.sort(),
    checklists: checklists.sort(),
    commands,
    changedPaths,
  };
}

/** The engine's plan in the same shape, so the two can be compared directly. */
function planToObservable(plan) {
  const commands = [];
  for (const bucket of BUCKETS) {
    for (const entry of plan.buckets.get(bucket)) {
      commands.push(normalize(`${entry.command} (${entry.reason})`));
    }
  }
  return {
    surfaces: [...plan.surfaces].sort(),
    checklists: plan.checklists
      .map((entry) => `${entry.checklist} (${entry.reason})`)
      .sort(),
    commands,
  };
}

function runGate(changedPaths, dir) {
  const pathsFile = join(dir, "paths");
  writeFileSync(pathsFile, `${changedPaths.join("\n")}\n`);
  const stdout = execFileSync(
    "bash",
    [
      join(REPO, "scripts/agent-quality-gate.sh"),
      "--changed-paths-file",
      pathsFile,
      "--base",
      "HEAD",
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, AGENT_QUALITY_GATE_LOCK: "0" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return { stdout, pathsFile };
}

async function runEngine(changedPaths, pathsFile) {
  const scriptSourceDir = join(REPO, "scripts");
  const facts = new Facts({
    repoRoot: REPO,
    baseRef: "HEAD",
    headRef: "HEAD",
    changedPathsFile: pathsFile,
    isRealTree: true,
    scriptSourceDir,
  });
  const routingSensitive = await routingSensitivePathsChanged(
    changedPaths,
    scriptSourceDir,
  );
  return planToObservable(buildPlan({ changedPaths, facts, routingSensitive }));
}

/** One line per difference, naming the path set and what moved. */
function diff(label, gate, engine) {
  const problems = [];
  for (const field of ["surfaces", "checklists"]) {
    const missing = gate[field].filter((x) => !engine[field].includes(x));
    const extra = engine[field].filter((x) => !gate[field].includes(x));
    for (const item of missing)
      problems.push(`${label}: engine MISSING ${field} ${item}`);
    for (const item of extra)
      problems.push(`${label}: engine EXTRA ${field} ${item}`);
  }
  const n = Math.max(gate.commands.length, engine.commands.length);
  for (let i = 0; i < n; i += 1) {
    if (gate.commands[i] !== engine.commands[i]) {
      problems.push(
        `${label}: command[${i}]\n    gate:   ${gate.commands[i] ?? "(none)"}\n    engine: ${engine.commands[i] ?? "(none)"}`,
      );
      break;
    }
  }
  return problems;
}

function corpusTracked(limit) {
  const listed = execFileSync("git", ["-C", REPO, "ls-files"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const all = listed.split("\n").filter((p) => p !== "");
  if (limit === null || limit >= all.length) return all;
  // Deterministic spread rather than a random sample, so a re-run compares the
  // same paths and a difference is reproducible.
  const step = all.length / limit;
  return Array.from({ length: limit }, (_, i) => all[Math.floor(i * step)]);
}

/**
 * Pass 2 — multi-path sets.
 *
 * Four behaviours are set-dependent and a single-path corpus cannot see any of
 * them: the Trunk full-vs-targeted decision, the codegen sort (which only has
 * something to sort when several variants are scheduled), Turbo compaction
 * (which needs two packages sharing a task), and scoped tests (which have a
 * 15-path threshold and four disqualifiers). Pass 1 proving zero differences
 * says almost nothing about these, so this is where the post-passes are
 * actually tested.
 */
function corpusMultiPath(tracked) {
  const sets = [];
  const pick = (source, count, seed) => {
    // Deterministic, so a difference is reproducible on a re-run.
    const chosen = [];
    let cursor = seed;
    for (let i = 0; i < count; i += 1) {
      cursor = (cursor * 1103515245 + 12345) % 2147483648;
      chosen.push(source[cursor % source.length]);
    }
    return [...new Set(chosen)];
  };

  for (const k of [2, 3, 5, 15, 16]) {
    for (let seed = 1; seed <= 6; seed += 1) {
      sets.push({
        label: `random-k${k}-s${seed}`,
        paths: pick(tracked, k, seed * 7919),
      });
    }
  }

  // Straddle each scoped-test disqualifier: the same base set with and without
  // the one path that turns scoping off.
  const base = [
    "ui-dashboard/src/lib/utils.ts",
    "indexer-envio/src/EventHandlers.ts",
  ];
  const straddles = {
    "shared-config": "shared-config/src/index.ts",
    "test-infra-hermetic": "ui-dashboard/vitest.hermetic-setup.ts",
    "test-infra-config": "ui-dashboard/vitest.config.ts",
    "schema-stub": "scripts/envio-schema-stubs.graphql",
    "workspace-escalation": "package.json",
    "lockfile-scoped": "pnpm-lock.yaml",
    "non-source-in-package": "ui-dashboard/src/lib/types.json",
    "test-file-in-package": "ui-dashboard/src/lib/utils.test.ts",
  };
  sets.push({ label: "straddle-base", paths: base });
  for (const [name, extra] of Object.entries(straddles)) {
    sets.push({ label: `straddle-${name}`, paths: [...base, extra] });
  }

  // The 15/16 threshold, exactly.
  const dashboardFiles = tracked
    .filter((p) => p.startsWith("ui-dashboard/src/") && p.endsWith(".ts"))
    .slice(0, 16);
  if (dashboardFiles.length === 16) {
    sets.push({ label: "threshold-15", paths: dashboardFiles.slice(0, 15) });
    sets.push({ label: "threshold-16", paths: dashboardFiles });
  }

  // Turbo compaction needs two packages sharing a task.
  sets.push({
    label: "turbo-compaction",
    paths: [
      "ui-dashboard/src/lib/utils.ts",
      "metrics-bridge/src/index.ts",
      "integration-probes/src/index.ts",
    ],
  });
  // Several codegen variants at once, so the sort has something to order.
  sets.push({
    label: "codegen-sort",
    paths: [
      "indexer-envio/config.yaml",
      "indexer-envio/config.testnet.yaml",
      "ui-dashboard/src/lib/utils.ts",
    ],
  });
  return sets;
}

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const limit = option("--limit", null);
const mutate = argv.includes("--mutate");

const paths = corpusTracked(limit === null ? null : Number(limit));
const dir = mkdtempSync(join(tmpdir(), "routing-parity-"));
let differences = 0;
let compared = 0;

const pass2 = argv.includes("--pass2");
const work = pass2
  ? corpusMultiPath(corpusTracked(null))
  : paths.map((path) => ({ label: path, paths: [path] }));

try {
  for (const { label, paths: set } of work) {
    if (set.length === 0) continue;
    const { stdout, pathsFile } = runGate(set, dir);
    const gate = parseGateStdout(stdout);
    // The gate's normalized set, not the harness's raw one.
    const engine = await runEngine(gate.changedPaths, pathsFile);
    if (mutate) engine.commands.shift();
    const problems = diff(label, gate, engine);
    compared += 1;
    if (problems.length > 0) {
      differences += 1;
      if (differences <= 15) console.log(problems.join("\n"));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ncompared ${compared} single-path sets; ${differences} differed`);
if (mutate) {
  console.log(
    differences > 0
      ? "MUTATION CONTROL FIRED: the harness can tell the two apart."
      : "MUTATION CONTROL DID NOT FIRE — this harness proves nothing.",
  );
  process.exit(differences > 0 ? 0 : 1);
}
process.exit(differences === 0 ? 0 : 1);
