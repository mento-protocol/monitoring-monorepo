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
  }
  return { surfaces: surfaces.sort(), checklists: checklists.sort(), commands };
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

try {
  for (const path of paths) {
    const set = [path];
    const { stdout, pathsFile } = runGate(set, dir);
    const gate = parseGateStdout(stdout);
    const engine = await runEngine(set, pathsFile);
    if (mutate) engine.commands.shift();
    const problems = diff(path, gate, engine);
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
