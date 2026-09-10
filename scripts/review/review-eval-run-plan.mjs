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
import {
  detailDirBase,
  finderArgvDigest,
  finderDetailSegment,
  resolveFinderPlan,
} from "./review-eval-finder-override.mjs";
import { freshness } from "./review-eval-ledger.mjs";
import {
  DEFAULT_RUNS_DIR,
  resolveDetailDir,
  resolveLegacySplitCache,
} from "./review-eval-run-detail.mjs";
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
  fileURLToPath(new URL("./run-eval-matrix.sh", import.meta.url)),
  fileURLToPath(new URL("./review-eval-cell-writer.mjs", import.meta.url)),
  fileURLToPath(new URL("./review-eval-stream.mjs", import.meta.url)),
]);
export { finderArgvDigest };
// Re-exported: `review-eval.mjs` and the tests import both from here.
export { DEFAULT_RUNS_DIR, resolveDetailDir };
export const DEFAULT_SKILL_DIR = "~/.claude/skills/review";
// `finder` is the probe lane: a plan kind, never a ledger kind.
export const PLAN_KINDS = ["full", "canary", "finder", "auto"];

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

/** Pick `full` or `canary` for `--kind auto`. It never answers `finder`. */
export function resolveKind({ kind, rows, contract, contractDigest, now }) {
  if (kind !== "auto") return kind;
  const age = freshness({ rows, contract, now, contractDigest });
  return age.daysSinceFull > contract.cadence_days.full ? "full" : "canary";
}

/**
 * The run matrix. `full` is the comparable score of record; `canary` is a
 * floor test on the replay condition alone, which spends no codex quota and
 * carries no finder-sampling variance.
 *
 * A `full` run is `PIPELINE_DRAWS` live draw(s) of every fixture, one replay of
 * every frozen finder report the grid carries, and one control cell per grid
 * fixture — 27 cells against the 2026-09 contract. It is a freshness floor and
 * a baseline anchor, so it buys breadth of PRs rather than repeat draws, and
 * the comparison that ranks two skills lives in the experiment lane
 * (`docs/adr/0086-review-eval-lane-any-grid-multi-draw.md`).
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

  // The probe lane stops after this loop: the pipeline condition alone, one
  // draw per fixture. One draw cannot separate a finder from sampling variance,
  // which is why a probe rejects a finder and never promotes one.
  const draws = kind === "finder" ? 1 : PIPELINE_DRAWS;
  for (const fixture of contract.fixtures) {
    for (let draw = 1; draw <= draws; draw += 1) {
      push(fixture, "pipeline", draw, {
        model: verifier.model,
        effort: verifier.effort,
        finder: finderLabel,
        finder_argv: [...finder.argv],
        prompt: "handoff",
      });
    }
  }
  if (kind === "finder") return cells;
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
  for (const fixture of gridFixtures(contract)) {
    push(fixture, "control", 1, {
      model: contract.sut.control.model,
      effort: contract.sut.control.effort,
      prompt: "request",
    });
  }
  return cells;
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
  finder = null,
  runsDir = DEFAULT_RUNS_DIR,
  ledgerRows = [],
  baselineRow = null,
  now = new Date(),
  env = process.env,
  write = true,
}) {
  if (!["full", "canary", "finder"].includes(kind)) {
    throw new Error(`plan kind must be full, canary or finder, not ${kind}`);
  }
  // The substitution shapes the cells and the finder digest, never the key.
  const { contract: planContract, override } = resolveFinderPlan({
    contract,
    kind,
    finder,
    baselineRow,
  });
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
  const inputs = collectInputs({ contract: planContract, skillRef, env });
  if (override) inputs.finder_override = override;
  const resolvedDetail = resolveDetailDir({
    runsDir,
    base: detailDirBase({ date, key, kind, inputs }),
    ledgerRows,
  });
  const { detailDir } = resolvedDetail;
  const planDir = outDir
    ? path.resolve(outDir)
    : path.resolve(repoRoot, detailDir);
  const cells = planCells({ contract: planContract, kind });
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
