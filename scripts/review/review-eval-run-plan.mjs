// Plan construction and input identity for the review-skill evaluation.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  gridFixtures,
  PIPELINE_DRAWS,
  scorableTotals,
} from "./review-eval-fixtures.mjs";
import { freshness } from "./review-eval-ledger.mjs";
import {
  cellReuseDecision,
  LEGACY_SPLIT_CACHE_PLAN,
  legacySplitCachePlanMatches,
} from "./review-eval-run-cell.mjs";
import { scorerDigest } from "./review-eval-score.mjs";

export const PLAN_SCHEMA_VERSION = 1;
export const DEFAULT_LEDGER_PATH = "docs/evals/review-skill-ledger.jsonl";
export const DEFAULT_CALIBRATION_PATH =
  "docs/evals/review-skill-judge-calibration.json";
// The committed calibration set, resolved from this module rather than from a
// caller's root, so `comparabilityKey` binds it even when no root is at hand.
// It is content-addressed, so a copy of the same bytes gives the same key.
const DEFAULT_CALIBRATION_FILE = fileURLToPath(
  new URL(`../../${DEFAULT_CALIBRATION_PATH}`, import.meta.url),
);
// The orchestrator that spends the quota, resolved from this module the way the
// calibration set is: `--score` and `--plan` both read the spec worktree they
// were pointed at, and the digest must name every source that worktree carries.
export const ORCHESTRATOR_FILE = fileURLToPath(
  new URL("./run-eval.sh", import.meta.url),
);
// The two node modules are in the list for the same reason the shell is: the
// cell writer decides what a paid cell records, and the stream module decides
// which assistant messages of a session it records at all. Both are copied into
// the orchestrator's sealed source snapshot and loaded from there, so binding
// them here is what stops a parser edit between two cells of one run from
// leaving every cell fingerprint unchanged.
export const ORCHESTRATOR_FILES = Object.freeze([
  ORCHESTRATOR_FILE,
  fileURLToPath(new URL("./run-eval-source-snapshot.sh", import.meta.url)),
  fileURLToPath(new URL("./run-eval-lifecycle.sh", import.meta.url)),
  fileURLToPath(new URL("./run-eval-runtime.sh", import.meta.url)),
  fileURLToPath(new URL("./review-eval-cell-writer.mjs", import.meta.url)),
  fileURLToPath(new URL("./review-eval-stream.mjs", import.meta.url)),
]);
export const DEFAULT_RUNS_DIR = "docs/evals/review-skill-runs";
export const DEFAULT_SKILL_DIR = "~/.claude/skills/review";
export const PLAN_KINDS = ["full", "canary", "auto"];

// Anchored on bench2: the Claude leg of `sol@high -> opus@high` cost $11.05
// for three PRs. The estimate is a budget warning, never a recorded number.
const USD_PER_CLAUDE_CELL = 3.68;

export function expandHome(target, home = process.env.HOME ?? "") {
  const value = String(target ?? "");
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The exact explicit baseline a plan authorizes scoring against. */
export function baselinePlanIdentity(row) {
  if (!row) return null;
  return {
    executed_at: row.executed_at,
    contract_digest: row.contract_digest,
    comparability_key: row.comparability_key,
    detail_dir: row.detail_dir,
    row_digest: sha256(JSON.stringify(row)),
  };
}

function walkFiles(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === ".git" || entry.name === ".DS_Store") continue;
    const full = path.join(dir, entry.name);
    // A symlink is neither a file nor a directory to `readdirSync`, so it would
    // be walked past silently: nothing under it reaches the digest, while
    // `run-eval.sh` snapshots the skill with `cp -R`, which stages the link
    // itself. The contestant would then read target bytes no digest keys, and an
    // edit to that target during a two-hour run would change the treatment after
    // the snapshot was checked against the plan. Refuse it here, before the run
    // spends anything, rather than measure content the row cannot freeze.
    if (entry.isSymbolicLink()) {
      throw new Error(
        `skill file ${path.relative(base, full)} is a symlink; the digest cannot freeze what it points at, so the staged skill would carry unkeyed bytes. Replace it with a regular file.`,
      );
    }
    if (entry.isDirectory()) walkFiles(full, base, found);
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

/**
 * Digest over a skill directory: `SKILL.md` plus every bundled reference. This
 * is the treatment under test, so it is hashed by content and not by ref name.
 * A symlink anywhere under it refuses the digest: see `walkFiles`.
 */
export function skillDigest(dir) {
  const root = expandHome(dir);
  const hash = createHash("sha256");
  const updateFramed = (bytes) => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(value.length));
    hash.update(length);
    hash.update(value);
  };
  for (const relative of walkFiles(root).sort()) {
    updateFramed(relative);
    updateFramed(readFileSync(path.join(root, relative)));
  }
  return hash.digest("hex");
}

/** Digest of one file, or a zero digest when the file is absent. */
export function fileDigest(file) {
  const resolved = expandHome(file);
  if (!existsSync(resolved)) return "0".repeat(64);
  return sha256(readFileSync(resolved));
}

/** Length-framed digest over every source that shapes an orchestrated run. */
export function orchestratorSourceDigest({ files = ORCHESTRATOR_FILES } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("orchestrator source files must be a non-empty array");
  }
  const hash = createHash("sha256");
  const updateFramed = (bytes) => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(value.length));
    hash.update(length);
    hash.update(value);
  };
  updateFramed("review-skill-eval/orchestrator/v2");
  for (const file of files) {
    const resolved = expandHome(file);
    if (!existsSync(resolved)) {
      throw new Error(`orchestrator source ${resolved} is missing`);
    }
    updateFramed(path.basename(resolved));
    updateFramed(readFileSync(resolved));
  }
  return hash.digest("hex");
}

/**
 * The key every later comparison is refused across. It binds the frozen
 * contract, the two frozen run prompts, the whole scoring pipeline with its
 * judge prompts, the frozen calibration set, the contestant orchestrator, and
 * the judge model. Change any one of them and the score stops being paired.
 *
 * `run-eval.sh` is in the key because it is the execution pipeline the recorded
 * transcript comes out of: it fixes the contestant's allowed tools, its turn
 * limit, how the skill is staged into the fixture, how far the finder report is
 * truncated, and the environment a cell runs in. Editing any of that changes
 * what the number measures exactly as editing a prompt does, and without the
 * digest two such runs would stay paired under one key.
 *
 * The two CLI versions are deliberately NOT in the key. They are recorded on
 * every row, they are part of the cell fingerprint, so one resumed run never
 * mixes runtimes, and `comparable()` prints the drift beside the verdict when a
 * pair straddles an upgrade. But `claude` and `codex` ship far more often than
 * this suite runs: keyed here, an upgrade would start a fresh lineage, every
 * later run would resolve no baseline, and the flip rules that make a regression
 * visible would never fire again. A pairing across a CLI upgrade, labelled as
 * one, is weaker evidence than a pairing under one runtime; no pairing at all is
 * not evidence. What the key must bind is what this repository controls — the
 * prompts, the scorer, the calibration set, the orchestrator and the judge
 * model — and a runtime change big enough to move the score shows up as a flip
 * against the anchor with the version drift named next to it.
 */
export function comparabilityKey({
  contract,
  contractDigest,
  matcherDigest = scorerDigest(),
  calibrationDigest = fileDigest(DEFAULT_CALIBRATION_FILE),
  orchestratorDigest = orchestratorSourceDigest(),
}) {
  const parts = [
    "review-skill-eval/v1",
    contractDigest,
    contract.prompts.request.sha256,
    contract.prompts.handoff.sha256,
    matcherDigest,
    calibrationDigest,
    orchestratorDigest,
    contract.judge.model,
  ];
  return sha256(parts.join("\n"));
}

function cliVersion(binary, env) {
  const override = env[`REVIEW_EVAL_${binary.toUpperCase()}_CLI`];
  if (override) return override;
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const text = String(result.stdout || "").trim();
  return result.status === 0 && text ? text.split("\n")[0] : "unknown";
}

/**
 * Digest over the finder command a pipeline cell actually executes. The
 * contract pins that argument vector, and `run-eval.sh` spawns it element for
 * element, so this is the finder half of the row's provenance.
 *
 * It replaced a digest of `~/.claude/bin/codex-review.sh`. That wrapper is an
 * operator convenience no cell ever runs: recording it claimed a drift control
 * the harness did not have, because a wrapper regression could not reach a
 * measured number while an edited `argv` moved every pipeline cell unrecorded.
 */
export function finderArgvDigest(contract) {
  const argv = contract?.sut?.finder?.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("contract sut.finder.argv must be a non-empty array");
  }
  return sha256(JSON.stringify(argv.map(String)));
}

/**
 * The environment stamped into the ledger row. Every value is either read from
 * disk or overridable by an environment variable, so a test never shells out.
 */
export function collectInputs({
  contract,
  skillRef = null,
  env = process.env,
} = {}) {
  const skillDir = expandHome(
    skillRef ?? env.REVIEW_EVAL_SKILL_DIR ?? DEFAULT_SKILL_DIR,
  );
  return {
    skill_digest: skillDigest(skillDir),
    skill_ref: skillRef ? path.resolve(skillDir) : "installed",
    finder_argv_digest: finderArgvDigest(contract),
    // The bytes of every source that ran the matrix. It is recorded beside the
    // finder argv for the same reason: both decide what a cell executed.
    orchestrator_digest: orchestratorSourceDigest(),
    claude_cli: cliVersion("claude", env),
    codex_cli: cliVersion("codex", env),
    host: env.REVIEW_EVAL_HOST ?? hostname(),
    ...(skillRef ? { dirty: true } : {}),
  };
}

/** Pick `full` or `canary` from the ledger, for the launchd `--kind auto`. */
export function resolveKind({ kind, rows, contract, contractDigest, now }) {
  if (kind !== "auto") return kind;
  const age = freshness({ rows, contract, now, contractDigest });
  return age.daysSinceFull > contract.cadence_days.full ? "full" : "canary";
}

/**
 * The run matrix. `full` is the comparable score of record; `canary` is a
 * floor test on the replay condition alone, which spends no codex quota and
 * carries no finder-sampling variance.
 */
export function planCells({ contract, kind }) {
  const cells = [];
  const push = (fixture, condition, draw, extra) =>
    cells.push({
      cell_id: `pr-${fixture.pr}-${condition}-draw${draw}`,
      pr: fixture.pr,
      condition,
      draw,
      ...extra,
    });
  const verifier = contract.sut.verifier;
  const finder = contract.sut.finder;
  const finderLabel = `${finder.model}@${finder.effort}`;

  if (kind === "canary") {
    for (const fixture of gridFixtures(contract)) {
      push(fixture, "replay", 1, {
        model: verifier.model,
        effort: verifier.effort,
        finder: finderLabel,
        finder_report: fixture.finder_reports[0].file,
        prompt: "handoff",
      });
    }
    return cells;
  }

  for (const fixture of contract.fixtures) {
    for (let draw = 1; draw <= PIPELINE_DRAWS; draw += 1) {
      push(fixture, "pipeline", draw, {
        model: verifier.model,
        effort: verifier.effort,
        finder: finderLabel,
        finder_argv: [...finder.argv],
        prompt: "handoff",
      });
    }
  }
  for (const fixture of gridFixtures(contract)) {
    fixture.finder_reports.forEach((report, index) => {
      push(fixture, "replay", index + 1, {
        model: verifier.model,
        effort: verifier.effort,
        finder: finderLabel,
        finder_report: report.file,
        prompt: "handoff",
      });
    });
  }
  for (const fixture of contract.fixtures) {
    push(fixture, "control", 1, {
      model: contract.sut.control.model,
      effort: contract.sut.control.effort,
      prompt: "request",
    });
  }
  return cells;
}

// How many executions of one date, key, kind and skill the runs directory may
// hold before the plan refuses to name another. Reaching it means a script is
// re-running the same matrix in a loop, which is a bug worth stopping on.
const MAX_RUNS_PER_NAME = 50;

function reusableCellResultCount({ cellsDir, cells, plan }) {
  try {
    if (!lstatSync(cellsDir).isDirectory()) return 0;
    return cells.filter((cell) => {
      const resultPath = path.join(cellsDir, cell.cell_id, "result.json");
      try {
        return (
          lstatSync(resultPath).isFile() &&
          cellReuseDecision({ plan, resultPath }).reuse
        );
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Find the one pre-split cache whose raw cells the recorded split preserves.
 * The first plan runs in the clean spec worktree and does not scan. The second
 * plan writes to the real checkout, so its conventional out directory names
 * the physical runs directory that can hold the ignored cell cache.
 */
function resolveLegacySplitCache({
  runsDir,
  outDir,
  detailDir,
  contractDigest,
  calibrationDigest,
  kind,
  inputs,
  cells,
}) {
  if (
    runsDir !== DEFAULT_RUNS_DIR ||
    !outDir ||
    path.basename(path.resolve(outDir)) !== path.posix.basename(detailDir) ||
    existsSync(path.join(path.resolve(outDir), "cells"))
  ) {
    return null;
  }
  const physicalRunsDir = path.dirname(path.resolve(outDir));
  if (
    path.basename(physicalRunsDir) !== path.posix.basename(DEFAULT_RUNS_DIR)
  ) {
    return null;
  }
  let entries;
  try {
    entries = readdirSync(physicalRunsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const prefix = LEGACY_SPLIT_CACHE_PLAN.comparabilityKey.slice(0, 8);
  const skill = String(inputs.skill_digest).slice(0, 8);
  const namePattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}-${prefix}-${kind}-${skill}(?:-(?:[2-9]|[1-4]\\d|50))?$`,
  );
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !namePattern.test(entry.name)) continue;
    const relative = path.posix.join(runsDir, entry.name);
    const physical = path.join(physicalRunsDir, entry.name);
    let cachedPlan;
    try {
      const planPath = path.join(physical, "plan.json");
      if (!lstatSync(planPath).isFile()) continue;
      cachedPlan = JSON.parse(readFileSync(planPath, "utf8"));
    } catch {
      continue;
    }
    if (
      !legacySplitCachePlanMatches({
        plan: cachedPlan,
        detailDir: relative,
        contractDigest,
        calibrationDigest,
        kind,
        inputs,
        cells,
      })
    ) {
      continue;
    }
    const results = reusableCellResultCount({
      cellsDir: path.join(physical, "cells"),
      cells,
      plan: { kind, contract_digest: contractDigest, inputs },
    });
    const plannedAt =
      typeof cachedPlan.planned_at === "string" ? cachedPlan.planned_at : "";
    if (
      results > 0 &&
      (!best ||
        results > best.results ||
        (results === best.results && plannedAt > best.plannedAt) ||
        (results === best.results &&
          plannedAt === best.plannedAt &&
          relative > best.relative))
    ) {
      best = { relative, results, plannedAt };
    }
  }
  return best?.relative ?? null;
}

/**
 * The detail directory this execution owns, and the one it may resume from.
 *
 * The base name — date, comparability key, kind, skill digest — is the resume
 * cache: an execution killed before it recorded anything is retried by running
 * the same command, and it must land on its own cells rather than re-spend the
 * matrix. But that directory is also the evidence a ledger row points at, so
 * once a row records it the next execution must not write there: it would
 * overwrite the plan, the scored results, the row and the report the earlier row
 * still claims, and reuse that row's publication branch name. So the name is
 * taken as soon as a row records it, and this execution takes the next one and
 * names the directory it superseded, whose paid cells the orchestrator seeds
 * from — every one of them is re-checked against this run's fingerprint.
 */
export function resolveDetailDir({ runsDir, base, ledgerRows = [] }) {
  const taken = new Set(
    (ledgerRows ?? []).map((row) => String(row?.detail_dir ?? "")),
  );
  let previous = null;
  for (let attempt = 1; attempt <= MAX_RUNS_PER_NAME; attempt += 1) {
    const candidate = path.posix.join(
      runsDir,
      attempt === 1 ? base : `${base}-${attempt}`,
    );
    if (!taken.has(candidate)) {
      return { detailDir: candidate, resumeFrom: previous };
    }
    previous = candidate;
  }
  throw new Error(
    `the ledger already records ${MAX_RUNS_PER_NAME} runs named ${path.posix.join(runsDir, base)}; refusing to plan another`,
  );
}

/**
 * Build the plan and write `plan.json`. The plan is the only thing the money
 * spending orchestrator reads, so it carries every digest the ledger row needs.
 */
export function buildPlan({
  contract,
  contractDigest,
  kind,
  repoRoot,
  outDir = null,
  skillRef = null,
  runsDir = DEFAULT_RUNS_DIR,
  ledgerRows = [],
  baselineRow = null,
  now = new Date(),
  env = process.env,
  write = true,
}) {
  if (!["full", "canary"].includes(kind)) {
    throw new Error(`plan kind must be full or canary, not ${kind}`);
  }
  // The key binds the committed calibration set by content. Recording that
  // digest in the plan is what lets `--score --calibration PATH` be refused
  // when it names a different set: the agreement that gates the verdict would
  // otherwise come from pairs the key never saw.
  //
  // It is resolved under `repoRoot`, which is what `--score` reads. Hashing
  // this module's own checkout instead would key the plan to one calibration
  // set and score it with another whenever `--root` names a different tree —
  // exactly what the orchestrator does with its spec worktree.
  const calibrationDigest = fileDigest(
    path.resolve(repoRoot, DEFAULT_CALIBRATION_PATH),
  );
  const key = comparabilityKey({ contract, contractDigest, calibrationDigest });
  const date = now.toISOString().slice(0, 10);
  const inputs = collectInputs({ contract, skillRef, env });
  // The skill under test and the kind are part of the directory name because
  // the directory is also the resume cache: two runs of the same contract with
  // different skills must never land on each other's cells.
  const resolvedDetail = resolveDetailDir({
    runsDir,
    base: `${date}-${key.slice(0, 8)}-${kind}-${String(inputs.skill_digest).slice(0, 8)}`,
    ledgerRows,
  });
  const { detailDir } = resolvedDetail;
  const planDir = outDir
    ? path.resolve(outDir)
    : path.resolve(repoRoot, detailDir);
  const cells = planCells({ contract, kind });
  const resumeFrom =
    resolvedDetail.resumeFrom ??
    resolveLegacySplitCache({
      runsDir,
      outDir,
      detailDir,
      contractDigest,
      calibrationDigest,
      kind,
      inputs,
      cells,
    });
  const claudeCells = cells.length;
  const warnings = [];
  for (const binary of ["claude_cli", "codex_cli"]) {
    if (inputs[binary] === "unknown") {
      warnings.push(
        `${binary} is unknown; the orchestrator must refuse to run`,
      );
    }
  }
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    suite_id: contract.suite_id,
    kind,
    planned_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    contract_digest: contractDigest,
    matcher_digest: scorerDigest(),
    calibration_digest: calibrationDigest,
    comparability_key: key,
    judge: { ...contract.judge },
    detail_dir: detailDir,
    baseline_selection: baselineRow === null ? "automatic" : "explicit",
    baseline: baselinePlanIdentity(baselineRow),
    // The directory of the previous execution under this name, whose cells this
    // one may seed from, or null when this is the first. Never the directory
    // this run writes to: a recorded row's evidence is not overwritten.
    resume_from: resumeFrom,
    plan_dir: planDir,
    inputs,
    totals: scorableTotals(contract),
    estimate: {
      cells: claudeCells,
      claude_usd: Number((claudeCells * USD_PER_CLAUDE_CELL).toFixed(2)),
    },
    warnings,
    cells,
  };
  if (write) {
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      path.join(planDir, "plan.json"),
      `${JSON.stringify(plan, null, 2)}\n`,
    );
  }
  return plan;
}
