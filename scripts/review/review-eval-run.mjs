#!/usr/bin/env node

// Planning, scoring, and validation for the review-skill evaluation. The CLI
// in `review-eval.mjs` parses arguments and prints; every decision lives here
// so the tests can exercise it without spawning a process.
//
// Only `scorePlan` reaches a model, and only through the `exec` function it is
// given. Nothing in this module calls `claude` or `codex` on its own.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultRunGit,
  fixtureForPr,
  forbiddenShasForFixture,
  gridFixtures,
  PIPELINE_DRAWS,
  scorableTotals,
} from "./review-eval-fixtures.mjs";
import { baselinePreflightProblems, freshness } from "./review-eval-ledger.mjs";
import {
  buildVsBaseline,
  conditionScope,
  resolveBaseline,
} from "./review-eval-result-shape.mjs";
import { baselineEligibility, verdict } from "./review-eval-report.mjs";
import {
  aggregateDraws,
  classifyNovel,
  extractClaims,
  matchClaims,
  runCalibration,
  scorerDigest,
} from "./review-eval-score.mjs";

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
// were pointed at, and the digest must name the script that worktree carries.
export const ORCHESTRATOR_FILE = fileURLToPath(
  new URL("./run-eval.sh", import.meta.url),
);
export const DEFAULT_RUNS_DIR = "docs/evals/review-skill-runs";
export const DEFAULT_SKILL_DIR = "~/.claude/skills/review";
export const PLAN_KINDS = ["full", "canary", "auto"];

// Anchored on bench2: the Claude leg of `sol@high -> opus@high` cost $11.05
// for three PRs. The estimate is a budget warning, never a recorded number.
const USD_PER_CLAUDE_CELL = 3.68;
const CLAUDE_MAX_TURNS = 80;
const CLAUDE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "Agent",
  "TodoWrite",
];
const EXEC_TIMEOUT_MS = 3_600_000;
const EXEC_MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
const MIN_VERBATIM_TITLE_WORDS = 6;

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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
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
  orchestratorDigest = fileDigest(ORCHESTRATOR_FILE),
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
    // The bytes of the script that ran the matrix. It is recorded beside the
    // finder argv for the same reason: both decide what a cell executed.
    orchestrator_digest: fileDigest(ORCHESTRATOR_FILE),
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
  const { detailDir, resumeFrom } = resolveDetailDir({
    runsDir,
    base: `${date}-${key.slice(0, 8)}-${kind}-${String(inputs.skill_digest).slice(0, 8)}`,
    ledgerRows,
  });
  const planDir = outDir
    ? path.resolve(outDir)
    : path.resolve(repoRoot, detailDir);
  const cells = planCells({ contract, kind });
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

/**
 * Heuristic answer-key detection. The contestant runs with real network and
 * real credentials on purpose, so this is defense in depth, not proof: naming
 * the PR or one of its reviewers is a hard signal, while a verbatim truth
 * title is only advisory because a correct review may word a defect the way
 * the reviewer did.
 */
export function reviewerLogins(truth) {
  return [
    ...new Set(
      [
        ...(truth?.reviewers ?? []),
        ...(truth?.findings ?? []).map((finding) => finding.author),
      ].filter(Boolean),
    ),
  ];
}

/**
 * Logins that the fixture's own tree already contains at its first head. A
 * review that quotes the line it is criticizing is doing what the prompt asks;
 * flagging `coderabbitai[bot]` because the source names it caps a correct run
 * at AMBER forever, so those logins are excluded from the login signal.
 */
export function loginsInFixtureTree({
  fixturePath,
  logins,
  runGit = defaultRunGit,
}) {
  const present = new Set();
  if (!fixturePath || !existsSync(fixturePath)) return present;
  for (const login of logins ?? []) {
    const result = runGit({
      args: [
        "grep",
        "--fixed-strings",
        "--files-with-matches",
        "-I",
        "-e",
        login,
      ],
      cwd: fixturePath,
    });
    if (result.status === 0) present.add(login);
  }
  return present;
}

export function leakSignals({
  transcript,
  truth,
  pr,
  excludeLogins = [],
  forbiddenShas = [],
}) {
  const text = String(transcript ?? "");
  const hard = [];
  const advisory = [];
  if (new RegExp(`(?:#|pull/|pulls/|PR )${pr}(?!\\d)`).test(text)) {
    hard.push(`transcript names PR ${pr}`);
  }
  const excluded = new Set(excludeLogins);
  for (const login of reviewerLogins(truth)) {
    if (excluded.has(login)) continue;
    if (text.includes(login)) hard.push(`transcript names reviewer ${login}`);
  }
  // The withheld commits are the answer key. `git` is neutralized per cell, but
  // that is a speed bump, so naming one of those commits is scored as a leak.
  const hexRuns = text.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  for (const sha of forbiddenShas ?? []) {
    if (hexRuns.some((token) => String(sha).startsWith(token))) {
      hard.push(
        `transcript names the withheld commit ${String(sha).slice(0, 12)}`,
      );
    }
  }
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  for (const finding of truth.findings ?? []) {
    const title = String(finding.title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (title.split(" ").filter(Boolean).length < MIN_VERBATIM_TITLE_WORDS) {
      continue;
    }
    if (normalized.includes(title)) {
      advisory.push(`transcript repeats truth title ${finding.id} verbatim`);
    }
  }
  return { suspected: hard.length > 0, hard, advisory };
}

/**
 * What a cached cell must have been produced under. The detail directory alone
 * is not enough: an aborted run leaves cells behind, and the next run may carry
 * an edited skill or an edited contract into the same directory.
 *
 * The recorded runtime is part of it. An interrupted run resumed after a CLI
 * upgrade would otherwise reuse cells produced by the previous binaries while
 * the new row stamps the current versions, which puts two runtimes in one row
 * under one provenance. `finder_argv_digest` is the command the pipeline
 * condition spawns, and `orchestrator_digest` is the script that spawns it with
 * its tools, turn limit and skill staging, so both move a recorded number the
 * same way. `skill_ref` and `dirty` preserve whether the execution measured the
 * installed skill or an explicit candidate. That status controls freshness and
 * automatic baseline eligibility, so the scored evidence must retain it.
 */
export function cellFingerprint({ plan }) {
  return {
    skill_digest: plan?.inputs?.skill_digest ?? null,
    skill_ref: plan?.inputs?.skill_ref ?? null,
    dirty: plan?.inputs?.dirty === true,
    kind: plan?.kind ?? null,
    contract_digest: plan?.contract_digest ?? null,
    claude_cli: plan?.inputs?.claude_cli ?? null,
    codex_cli: plan?.inputs?.codex_cli ?? null,
    finder_argv_digest: plan?.inputs?.finder_argv_digest ?? null,
    orchestrator_digest: plan?.inputs?.orchestrator_digest ?? null,
  };
}

/**
 * Whether the orchestrator may reuse a cell it finds on disk. An unfingerprinted
 * or mismatched cell is refused, which costs one re-run and never scores the
 * previous skill's output under this run's digest.
 */
export function cellReuseDecision({ plan, resultPath, result = null }) {
  const expected = cellFingerprint({ plan });
  let stored = result;
  if (!stored) {
    if (!existsSync(resultPath)) {
      return { reuse: false, reason: `no cell result at ${resultPath}` };
    }
    try {
      stored = readJson(resultPath);
    } catch (error) {
      return { reuse: false, reason: error.message };
    }
  }
  const found = stored?.fingerprint;
  if (!found || typeof found !== "object") {
    return { reuse: false, reason: "the cached cell carries no fingerprint" };
  }
  const unexpected = Object.keys(found).filter(
    (field) => !Object.hasOwn(expected, field),
  );
  if (unexpected.length > 0) {
    return {
      reuse: false,
      reason: `the cached cell fingerprint carries unexpected ${unexpected.join(", ")}`,
    };
  }
  const differing = Object.keys(expected).filter(
    (field) => found[field] !== expected[field],
  );
  if (differing.length > 0) {
    return {
      reuse: false,
      reason: `the cached cell was produced under a different ${differing.join(", ")}`,
    };
  }
  return { reuse: true, reason: "the cached cell matches this run" };
}

function cellResultPath(planDir, cell) {
  return path.join(planDir, "cells", cell.cell_id, "result.json");
}

function readCellResult(planDir, cell) {
  const file = cellResultPath(planDir, cell);
  if (!existsSync(file)) return null;
  const result = readJson(file);
  return result?.ok === true && typeof result.output === "string"
    ? result
    : null;
}

// The GitHub credentials a judge must never inherit. `run-eval.sh` scrubs the
// same four for a contestant cell; the scoring pass runs the novel judge with
// `Bash` inside the fixture, so it needs the same treatment.
export const SCRUBBED_ENV_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GH_ENTERPRISE_TOKEN",
];

// The path-bearing variables a judge must never inherit. `run-eval.sh` scrubs
// the same family per cell: pnpm exports `INIT_CWD`, `PNPM_SCRIPT_SRC_DIR`,
// `npm_config_local_prefix` and more into every script it runs, each naming the
// checkout the frozen answer key lives in, and the family is open-ended, so it
// is matched by name pattern rather than enumerated. `OLDPWD` and `PWD` hand
// over a directory the same way: `claude` is not a shell, so it carries the
// inherited value rather than re-deriving it from the `cwd` it was spawned in.
const SOURCE_PATH_ENV_PATTERN = /^(?:npm_|PNPM_)/;
const SOURCE_PATH_ENV_VARS = ["INIT_CWD", "NODE_PATH", "OLDPWD", "PWD"];

// This module's own checkout. Under the documented `pnpm review:eval:run` the
// scoring pass reads its harness out of the spec worktree, and that worktree
// carries `docs/evals/review-skill-truth/` — so the tree this file was loaded
// from is the first path a judge must not be handed.
const MODULE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function realOrSelf(target) {
  const resolved = path.resolve(String(target));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The checkouts a scoring subprocess must not be given a path into: this
 * module's own tree, plus whatever the pnpm variables named before they were
 * dropped. A caller that knows another root — `--root` naming a third checkout
 * — passes it as `roots`.
 */
export function sourceCheckouts({ env = process.env, roots = [] } = {}) {
  return [
    ...new Set(
      [
        MODULE_ROOT,
        env.INIT_CWD,
        env.npm_config_local_prefix,
        env.PNPM_SCRIPT_SRC_DIR,
        ...roots,
      ]
        .filter(Boolean)
        .map(realOrSelf),
    ),
  ];
}

/**
 * `PATH` minus every entry that resolves inside one of those checkouts.
 *
 * It is the last path-bearing variable, and it survives the scrub above because
 * a judge still needs node and git: under `pnpm review:eval:run` pnpm prepends
 * `<checkout>/node_modules/.bin`, which hands a `Bash`-enabled judge the
 * checkout root the variable scrub just took away. Entries are compared
 * canonically as well as literally, because a symlinked `node_modules/.bin`
 * passes a string comparison and still lands in the repository.
 */
export function scrubPath(value, checkouts = sourceCheckouts()) {
  return String(value ?? "")
    .split(path.delimiter)
    .filter((entry) => {
      if (!entry) return false;
      const real = realOrSelf(entry);
      return !checkouts.some(
        (root) =>
          real === root ||
          real.startsWith(`${root}${path.sep}`) ||
          entry === root ||
          entry.startsWith(`${root}${path.sep}`),
      );
    })
    .join(path.delimiter);
}

let scrubbedGhConfigDir = null;

/** An empty `gh` config directory, created once per process. */
function emptyGhConfigDir() {
  if (!scrubbedGhConfigDir) {
    scrubbedGhConfigDir = mkdtempSync(path.join(tmpdir(), "review-eval-gh-"));
  }
  return scrubbedGhConfigDir;
}

/**
 * The environment a scoring subprocess runs under. It mirrors the per-cell
 * `CELL_ENV` in `run-eval.sh`: no GitHub token, an empty `gh` config
 * directory, and a git with no credential helper, no prompt, no askpass and
 * no protocol but `file`. The model API stays reachable, so this is defense in
 * depth against prompt-injected fixture content, not containment.
 *
 * The same shell's source-path treatment applies here too, and for the same
 * reason: `classifyNovel` gives its judge `Bash` inside the fixture, so a
 * prompt-injected claim that follows an inherited `INIT_CWD` or a
 * `node_modules/.bin` entry on `PATH` reaches `docs/evals/review-skill-truth/`
 * and contaminates `novel_real` and `wrong_claims` — and unlike contestant
 * output, a judge's reading of the key passes through no `leakSignals()`.
 */
export function scrubbedEnv({
  env = process.env,
  ghConfigDir = emptyGhConfigDir(),
  roots = [],
} = {}) {
  const scrubbed = { ...env };
  for (const name of SCRUBBED_ENV_VARS) delete scrubbed[name];
  const checkouts = sourceCheckouts({ env, roots });
  for (const name of Object.keys(scrubbed)) {
    if (
      SOURCE_PATH_ENV_PATTERN.test(name) ||
      SOURCE_PATH_ENV_VARS.includes(name)
    ) {
      delete scrubbed[name];
    }
  }
  return {
    ...scrubbed,
    PATH: scrubPath(env.PATH, checkouts),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_ALLOW_PROTOCOL: "file",
    GH_CONFIG_DIR: ghConfigDir,
  };
}

/**
 * The default model call for `--score`: one non-interactive Claude session.
 *
 * It spawns asynchronously on purpose. `runCalibration` replays forty frozen
 * pairs through four workers, and a synchronous spawn blocks the event loop,
 * so every one of those calls would queue behind the last one and the
 * configured concurrency would buy nothing.
 */
export function claudeArgv({
  prompt,
  model,
  effort,
  allowedTools = CLAUDE_TOOLS,
  maxTurns = CLAUDE_MAX_TURNS,
}) {
  return [
    "-p",
    prompt,
    "--model",
    model,
    "--effort",
    effort,
    "--setting-sources",
    "",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    // `--allowed-tools` is a required variadic option. Emitting it with an
    // empty list makes the CLI swallow the following `--max-turns 1` as two
    // tool names, so every blind judge and calibration replay would run
    // unbounded. Omit the flag when there are no tools to allow.
    ...(allowedTools.length > 0 ? ["--allowed-tools", ...allowedTools] : []),
    "--max-turns",
    String(maxTurns),
  ];
}

export function claudeExec({
  prompt,
  model,
  effort,
  cwd = process.cwd(),
  allowedTools = CLAUDE_TOOLS,
  maxTurns = CLAUDE_MAX_TURNS,
  env = scrubbedEnv(),
}) {
  const args = claudeArgv({ prompt, model, effort, allowedTools, maxTurns });
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    // The same wall clock `spawnSync` enforced, and the same output ceiling: a
    // judge that never returns must fail its cell, not hold the run open.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`claude did not finish within ${EXEC_TIMEOUT_MS} ms`));
    }, EXEC_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > EXEC_MAX_OUTPUT_CHARS) {
        child.kill("SIGKILL");
        finish(
          new Error(`claude wrote more than ${EXEC_MAX_OUTPUT_CHARS} chars`),
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      finish(new Error(`claude could not be started: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      finish(
        new Error(`claude exited ${code ?? signal}: ${stderr.slice(-400)}`),
      );
    });
  });
}

/**
 * Return one fixture to the commit the contract pins, before a judge looks.
 *
 * The cells ran with `Write`, `Edit` and `Bash`, and the novel judge itself
 * runs with `Bash` inside the same checkout, so without this the judge would
 * verify a claim against the previous model's edits instead of against the
 * PR head. A fixture that cannot be reset is a scoring failure, not a number:
 * the cells stay cached, so the run resumes and re-scores.
 *
 * The reset names the pinned head rather than trusting the one `HEAD` carries
 * now, for the same reason the shell's per-cell reset does. `HEAD` is the one
 * thing a contestant can move: the last cell for a PR can commit its own edits
 * — or a commit the diff under review prompt-injected — or simply check out the
 * fixture's `base` branch, and an argument-free `git reset --hard` then makes
 * that tree the fixture. The pre-judge login snapshot and the novelty judge
 * would both run against it, so every scored claim for the PR comes from the
 * wrong tree. `HEAD` is read back afterwards so a reset that did not land fails
 * scoring instead of quietly scoring the contestant's commit.
 */
export function resetFixture({
  fixturePath,
  head,
  cellId,
  runGit = defaultRunGit,
}) {
  if (!fixturePath || !existsSync(fixturePath)) return false;
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) {
    throw new Error(
      `fixture ${fixturePath} cannot be reset before scoring ${cellId}: no pinned head`,
    );
  }
  for (const args of [
    ["checkout", "--quiet", "--force", "--detach", head],
    ["reset", "--hard", "--quiet", head],
    ["clean", "-xdffq"],
  ]) {
    const result = runGit({ args, cwd: fixturePath });
    if (result.status !== 0) {
      throw new Error(
        `fixture ${fixturePath} could not be reset before scoring ${cellId}: git ${args[0]} exited ${result.status}`,
      );
    }
  }
  const landed = runGit({
    args: ["rev-parse", "--verify", "--quiet", "HEAD"],
    cwd: fixturePath,
  });
  if (landed.status !== 0 || landed.stdout.trim() !== head) {
    throw new Error(
      `fixture ${fixturePath} is at ${landed.stdout.trim() || "an unreadable HEAD"} after the reset before scoring ${cellId}, not the pinned ${head}`,
    );
  }
  return true;
}

async function scoreOneCell({
  cell,
  cellResult,
  fingerprint,
  contract,
  repoRoot,
  truth,
  exec: baseExec,
  runGit = defaultRunGit,
}) {
  // What this cell's own judge calls cost. The run total is recorded on the row
  // as `scoring_usd`, and without a per-cell trace it was the one number
  // `--validate` had to believe. Metering here as well as at the run level
  // makes it a sum of evidence on disk; both tallies see every call.
  const cellCost = { usd: 0 };
  const exec = meterExec(baseExec, cellCost);
  const fixture = fixtureForPr(contract, cell.pr);
  const transcript = cellResult.output;
  // The judge model is the one the comparability key records. Reading a
  // default here would let a judge retirement move the key while scoring kept
  // calling the retired model.
  const model = contract.judge.model;
  const fixturePath = cellResult.fixture_path ?? "";
  resetFixture({
    fixturePath,
    head: fixture.first_head,
    cellId: cell.cell_id,
    runGit,
  });
  // Snapshot the logins the fixture already carries while the tree is still the
  // one `resetFixture` just restored. The exclusion list exists so a reviewer
  // login that is genuine fixture content is not read as a leak, and the novel
  // judge below runs with `Bash` inside this same checkout: computed after it,
  // a login that fixture text prompt-injected the judge into writing into a
  // tracked file would be excluded, and a transcript naming the reviewer would
  // evade the hard leak signal.
  const excludeLogins = [
    ...loginsInFixtureTree({
      fixturePath,
      logins: reviewerLogins(truth),
      runGit,
    }),
  ];
  const claims = await extractClaims({ transcript, exec, model });
  const matched = await matchClaims({
    claims,
    truthFindings: truth.findings,
    scorableIds: fixture.scorable_ids,
    transcript,
    exec,
    model,
  });
  const novel = await classifyNovel({
    claims,
    matchedIds: matched.matchedIds,
    truthFindings: truth.findings,
    fixturePath,
    exec,
    model,
  });
  const leak = leakSignals({
    transcript,
    truth,
    pr: cell.pr,
    excludeLogins,
    forbiddenShas: forbiddenShasForFixture({ fixture, repoRoot, truth }),
  });
  return {
    cell_id: cell.cell_id,
    fingerprint,
    pr: cell.pr,
    condition: cell.condition,
    draw: cell.draw,
    model: cell.model,
    effort: cell.effort,
    finder: cell.finder ?? null,
    claims,
    matched_ids: matched.matchedIds,
    judge_reasoning: matched.judgeReasoning,
    novel,
    leak,
    seconds: Number(cellResult.seconds ?? 0),
    usd: Number(cellResult.cost_usd ?? 0),
    scoring_usd: cellCost.usd,
  };
}

function foldCondition({ contract, cells, condition, scored }) {
  const own = cells.filter((cell) => cell.condition === condition);
  if (own.length === 0) return null;
  const scope = conditionScope({ contract, cells, condition });
  // A PR that never ran draw 2 must not be scored a zero for draw 2: each draw
  // covers only the defects of the PRs whose cell for that draw completed, so a
  // missing cell shrinks `opportunities` instead of inflating the misses.
  const drawNumbers = [...new Set(own.map((cell) => cell.draw))].sort(
    (a, b) => a - b,
  );
  const draws = drawNumbers
    .map((draw) => {
      const completed = own.filter(
        (cell) => cell.draw === draw && scored.has(cell.cell_id),
      );
      return {
        matchedIds: completed.flatMap(
          (cell) => scored.get(cell.cell_id)?.matched_ids ?? [],
        ),
        scorableIds: completed.flatMap(
          (cell) => fixtureForPr(contract, cell.pr).scorable_ids,
        ),
      };
    })
    .filter((draw) => draw.scorableIds.length > 0);
  if (draws.length === 0) return null;
  const aggregate = aggregateDraws({
    scorableIds: scope.scorableIds,
    p1Ids: scope.p1Ids,
    draws,
  });
  const mine = own.map((cell) => scored.get(cell.cell_id)).filter(Boolean);
  // "The condition found nothing on this PR" is a statement about the PR, not
  // about one draw. A PR counts only when every draw that completed for it
  // emitted no parseable claim; one empty draw beside a productive one is
  // sampling variance, and counting it would red a run that found defects.
  const claimsByPr = new Map();
  for (const cell of own) {
    const record = scored.get(cell.cell_id);
    if (!record) continue;
    claimsByPr.set(
      cell.pr,
      (claimsByPr.get(cell.pr) ?? 0) + (record.claims ?? []).length,
    );
  }
  const zeroFindingPrs = new Set(
    [...claimsByPr.entries()]
      .filter(([, claims]) => claims === 0)
      .map(([pr]) => pr),
  );
  const sample = own[0];
  return {
    model: sample.model,
    effort: sample.effort,
    ...(sample.finder ? { finder: sample.finder } : {}),
    draws: aggregate.draws,
    recall: aggregate.recall,
    p1: aggregate.p1,
    novel_real: mine.reduce((sum, item) => sum + item.novel.novelReal, 0),
    wrong_claims: mine.reduce((sum, item) => sum + item.novel.novelWrong, 0),
    usd: Number(mine.reduce((sum, item) => sum + item.usd, 0).toFixed(2)),
    seconds: Number(
      mine.reduce((sum, item) => sum + item.seconds, 0).toFixed(1),
    ),
    ...(zeroFindingPrs.size ? { zero_finding_prs: zeroFindingPrs.size } : {}),
    per_defect: aggregate.per_defect,
  };
}

/** The dollars one Claude CLI envelope reports, or 0 when it carries none. */
function envelopeCost(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim().startsWith("{")) return 0;
  try {
    const usd = JSON.parse(text.trim())?.total_cost_usd;
    return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : 0;
  } catch {
    return 0;
  }
}

/**
 * Wrap an `exec` so every judge call adds its envelope cost to `tally`.
 *
 * A condition's `usd` is what the contestant cell spent. Extraction, matching,
 * novelty judging and the forty calibration replays are spent by the scorer,
 * and a report that omits them understates the run by the price of a judge
 * pass.
 */
export function meterExec(exec, tally) {
  return async (request) => {
    const raw = await exec(request);
    tally.usd += envelopeCost(raw);
    return raw;
  };
}

/**
 * Score every collected cell and assemble one ledger row.
 *
 * A leak signal never silently enters the scored fields: it downgrades a
 * GREEN or PROMOTE row to AMBER and says so in `notes`, because the score of a
 * run that may have read the answer key is not comparable evidence.
 */
export async function scorePlan({
  plan,
  contract,
  contractDigest,
  repoRoot,
  planDir,
  exec,
  calibrationSet,
  runGit = defaultRunGit,
  ledgerRows = [],
  baselineRow = null,
  now = new Date(),
  write = true,
}) {
  // Refuse edits to the branch-owned plan before calibration or judge calls
  // spend quota. Later evidence validation applies the same frozen matrix.
  if (!Array.isArray(plan.cells)) {
    throw new Error("plan carries no cells array");
  }
  if (!["full", "canary"].includes(plan.kind)) {
    throw new Error(
      `plan has no frozen ${String(plan.kind ?? "unknown")} matrix to score`,
    );
  }
  const expectedCells = planCells({ contract, kind: plan.kind });
  if (JSON.stringify(plan.cells) !== JSON.stringify(expectedCells)) {
    throw new Error(`plan cells do not match the frozen ${plan.kind} matrix`);
  }
  const baselineIsExplicit = baselineRow !== null;
  const baselineSelection = baselineIsExplicit ? "explicit" : "automatic";
  if (plan.baseline_selection !== baselineSelection) {
    throw new Error(
      `plan baseline_selection is ${String(plan.baseline_selection)}; this score command is ${baselineSelection}`,
    );
  }
  const plannedBaseline = plan.baseline ?? null;
  const scoreBaseline = baselinePlanIdentity(baselineRow);
  if (JSON.stringify(plannedBaseline) !== JSON.stringify(scoreBaseline)) {
    throw new Error(
      `plan baseline ${String(plannedBaseline?.executed_at ?? "none")} does not match score baseline ${String(scoreBaseline?.executed_at ?? "none")}`,
    );
  }
  if (baselineIsExplicit) {
    const eligibility = baselineEligibility(baselineRow);
    const baselineProblems = baselinePreflightProblems({
      row: baselineRow,
      contract,
      contractDigest,
      planComparabilityKey: plan.comparability_key,
      candidateExecutedAt: plan.planned_at,
    });
    if (!eligibility.usable) baselineProblems.unshift(eligibility.reason);
    if (baselineProblems.length > 0) {
      throw new Error(
        `explicit baseline is not eligible for this plan:\n${baselineProblems.join("\n")}`,
      );
    }
  }
  const completedCellResults = new Map();
  const fingerprint = cellFingerprint({ plan });
  const missing = [];
  for (const cell of plan.cells) {
    const cellResult = readCellResult(planDir, cell);
    if (!cellResult) {
      missing.push(cell.cell_id);
      continue;
    }
    const reuse = cellReuseDecision({
      plan,
      resultPath: cellResultPath(planDir, cell),
      result: cellResult,
    });
    if (!reuse.reuse) {
      throw new Error(`cell ${cell.cell_id} cannot be scored: ${reuse.reason}`);
    }
    completedCellResults.set(cell.cell_id, cellResult);
  }
  if (completedCellResults.size === 0) {
    throw new Error(
      `no completed cell results under ${planDir}; run the orchestrator first`,
    );
  }
  // Freeze every truth object before the first model call. A candidate run uses
  // the operator's live checkout, and calibration can take long enough for an
  // edit after the CLI's digest check to otherwise change later cell scoring.
  const truthByPr = new Map(
    [...new Set(plan.cells.map((cell) => cell.pr))].map((pr) => {
      const fixture = fixtureForPr(contract, pr);
      return [pr, readJson(path.join(repoRoot, fixture.truth_file))];
    }),
  );
  const scoringCost = { usd: 0 };
  const metered = meterExec(exec, scoringCost);
  const calibrationCost = { usd: 0 };
  const calibration = await runCalibration({
    calibrationSet,
    exec: meterExec(metered, calibrationCost),
    model: contract.judge.model,
  });
  // The calibration replay is the only recorded number with no other trace on
  // disk, so `--validate` had to take `judge_calibration` on the row's own say
  // so. Writing the forty outcomes beside the cell results makes the agreement
  // re-derivable the way every other counter already is.
  if (write) {
    writeFileSync(
      path.join(planDir, "calibration.json"),
      `${JSON.stringify(
        {
          model: contract.judge.model,
          agreement: calibration.agreement,
          total: calibration.total,
          fingerprint,
          completed_cell_ids: [...completedCellResults.keys()],
          // The replay's share of `scoring_usd`. With the per-cell shares it
          // makes the row's scoring cost re-derivable from the detail.
          scoring_usd: calibrationCost.usd,
          outcomes: calibration.outcomes ?? [],
        },
        null,
        2,
      )}\n`,
    );
  }
  const scored = new Map();
  const leaked = [];
  for (const cell of plan.cells) {
    const cellResult = completedCellResults.get(cell.cell_id);
    if (!cellResult) continue;
    const record = await scoreOneCell({
      cell,
      cellResult,
      fingerprint,
      contract,
      repoRoot,
      truth: truthByPr.get(cell.pr),
      exec: metered,
      runGit,
    });
    scored.set(cell.cell_id, record);
    if (record.leak.suspected) leaked.push(...record.leak.hard);
    if (write) {
      writeFileSync(
        path.join(
          planDir,
          `result-${cell.pr}-${cell.condition}-${cell.draw}.json`,
        ),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    }
  }
  const conditions = {};
  for (const name of ["pipeline", "replay", "control"]) {
    const folded = foldCondition({
      contract,
      cells: plan.cells.filter((cell) => scored.has(cell.cell_id)),
      condition: name,
      scored,
    });
    if (folded) conditions[name] = folded;
  }

  const status = missing.length === 0 ? "complete" : "partial";
  const notes = [];
  if (missing.length) {
    notes.push(`${missing.length} cell(s) missing: ${missing.join(", ")}`);
  }
  if (leaked.length) notes.push(`leak suspected: ${leaked.join("; ")}`);

  const row = {
    schema_version: 1,
    kind: plan.kind,
    executed_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    status,
    verdict: "INCOMPLETE",
    comparability_key: plan.comparability_key,
    contract_digest: contractDigest,
    inputs: plan.inputs,
    conditions,
    judge_calibration: {
      agreement: calibration.agreement,
      total: calibration.total,
    },
    // What the scorer itself spent: claim extraction, the match judge, the
    // novel judge, and the forty calibration replays. It is recorded beside
    // the per-condition dollars, never folded into them: a condition's `usd`
    // must stay the cost of the contestant cell it measures.
    scoring_usd: Number(scoringCost.usd.toFixed(2)),
    vs_baseline: null,
    detail_dir: plan.detail_dir,
    notes: notes.join(" | "),
  };
  // Automatic scoring creates the row before it appends it. Resolve it as the
  // next ledger entry so clock skew cannot replace append-order semantics with
  // the timestamp fallback reserved for external report files.
  const baseline =
    baselineRow ?? resolveBaseline({ rows: [...ledgerRows, row], row });
  row.vs_baseline = buildVsBaseline({
    row,
    baselineRow: baseline,
    selection: baselineSelection,
  });
  const decision = verdict({
    contract,
    row,
    baselineRow: baseline,
    baselineIsExplicit,
  });
  row.verdict = decision.verdict;
  if (leaked.length && ["GREEN", "PROMOTE"].includes(row.verdict)) {
    row.verdict = "AMBER";
    decision.reasons.push("leak suspected; the score is not usable evidence");
  }
  if (write) {
    writeFileSync(
      path.join(planDir, "row.json"),
      `${JSON.stringify(row, null, 2)}\n`,
    );
  }
  return {
    row,
    reasons: decision.reasons,
    calibration,
    missing,
    baselineRow: baseline,
    scored: [...scored.values()],
  };
}

/**
 * One staleness issue per contract per month, deduplicated by the marker block
 * the documentation schedulers already use.
 */
export function planStalenessIssueSync({
  month,
  contractDigest,
  issues,
  payload,
}) {
  const tracked = (issues ?? []).filter((issue) => issue.marker);
  const open = tracked.find((issue) => issue.state !== "CLOSED");
  if (open) {
    return {
      action:
        open.marker.month === month &&
        open.marker.contract_digest === contractDigest
          ? "keep-current"
          : "skip-prior-open",
      reason: `issue #${open.number} for ${open.marker.month} is still open`,
      issue: open,
    };
  }
  const closed = tracked.find(
    (issue) =>
      issue.marker.month === month &&
      issue.marker.contract_digest === contractDigest,
  );
  if (closed) {
    return {
      action: "skip-complete",
      reason: `${month} is already covered by closed issue #${closed.number}`,
      issue: closed,
    };
  }
  return {
    action: "create",
    reason: `no open or completed staleness issue exists for ${month}`,
    payload,
  };
}

// The scheduled workflow always runs on the default branch, so the ref is a
// constant here. Comparing GITHUB_WORKFLOW_REF against GITHUB_REF would put
// the same runtime value on both sides of the test and constrain nothing.
export const FRESHNESS_WORKFLOW_REF = "refs/heads/main";

/**
 * Live issue creation belongs to the scheduled freshness workflow alone. Every
 * other caller plans the synchronization and prints it. `workflow_dispatch` is
 * not accepted: a dispatch can name any branch, and an unattended issue write
 * from an arbitrary branch is exactly what this guard exists to refuse.
 */
export function assertAuthorizedFreshnessWorkflow(
  options,
  { env = process.env } = {},
) {
  const expected = `${options.repo}/.github/workflows/review-eval-freshness.yml@${FRESHNESS_WORKFLOW_REF}`;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    String(env.GITHUB_EVENT_NAME ?? "") !== "schedule" ||
    String(env.GITHUB_REF ?? "") !== FRESHNESS_WORKFLOW_REF ||
    String(env.GITHUB_WORKFLOW_REF ?? "") !== expected
  ) {
    throw new Error(
      `live issue creation is restricted to the review-eval freshness workflow on its schedule (${FRESHNESS_WORKFLOW_REF}); use --dry-run locally`,
    );
  }
}
