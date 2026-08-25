#!/usr/bin/env node

// Planning, scoring, and validation for the review-skill evaluation. The CLI
// in `review-eval.mjs` parses arguments and prints; every decision lives here
// so the tests can exercise it without spawning a process.
//
// Only `scorePlan` reaches a model, and only through the `exec` function it is
// given. Nothing in this module calls `claude` or `codex` on its own.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import {
  defaultRunGit,
  fixtureForPr,
  forbiddenShasForFixture,
  gridFixtures,
  scorableTotals,
} from "./review-eval-fixtures.mjs";
import { freshness } from "./review-eval-ledger.mjs";
import {
  conditionScope,
  resolveBaseline,
} from "./review-eval-result-shape.mjs";
import {
  compareConditions,
  headlineCondition,
  verdict,
} from "./review-eval-report.mjs";
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
export const DEFAULT_RUNS_DIR = "docs/evals/review-skill-runs";
export const DEFAULT_SKILL_DIR = "~/.claude/skills/review";
export const DEFAULT_CODEX_REVIEW_SH = "~/.claude/bin/codex-review.sh";
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
    if (entry.isDirectory()) walkFiles(full, base, found);
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

/**
 * Digest over a skill directory: `SKILL.md` plus every bundled reference. This
 * is the treatment under test, so it is hashed by content and not by ref name.
 */
export function skillDigest(dir) {
  const root = expandHome(dir);
  const hash = createHash("sha256");
  for (const relative of walkFiles(root).sort()) {
    hash.update(relative);
    hash.update(readFileSync(path.join(root, relative)));
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
 * contract, the two frozen run prompts, the scorer with its judge prompts, and
 * the judge model. Change any one of them and the score stops being paired.
 */
export function comparabilityKey({
  contract,
  contractDigest,
  matcherDigest = scorerDigest(),
}) {
  const parts = [
    "review-skill-eval/v1",
    contractDigest,
    contract.prompts.request.sha256,
    contract.prompts.handoff.sha256,
    matcherDigest,
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
export function collectInputs({ skillRef = null, env = process.env } = {}) {
  const skillDir = expandHome(
    skillRef ?? env.REVIEW_EVAL_SKILL_DIR ?? DEFAULT_SKILL_DIR,
  );
  const codexReviewSh = expandHome(
    env.REVIEW_EVAL_CODEX_REVIEW_SH ?? DEFAULT_CODEX_REVIEW_SH,
  );
  return {
    skill_digest: skillDigest(skillDir),
    skill_ref: skillRef ? path.resolve(skillDir) : "installed",
    codex_review_sh_digest: fileDigest(codexReviewSh),
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
    for (const draw of [1, 2]) {
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
  now = new Date(),
  env = process.env,
  write = true,
}) {
  if (!["full", "canary"].includes(kind)) {
    throw new Error(`plan kind must be full or canary, not ${kind}`);
  }
  const key = comparabilityKey({ contract, contractDigest });
  const date = now.toISOString().slice(0, 10);
  const inputs = collectInputs({ skillRef, env });
  // The skill under test and the kind are part of the directory name because
  // the directory is also the resume cache: two runs of the same contract with
  // different skills must never land on each other's cells.
  const detailDir = path.posix.join(
    runsDir,
    `${date}-${key.slice(0, 8)}-${kind}-${String(inputs.skill_digest).slice(0, 8)}`,
  );
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
    comparability_key: key,
    judge: { ...contract.judge },
    detail_dir: detailDir,
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
 */
export function cellFingerprint({ plan }) {
  return {
    skill_digest: plan?.inputs?.skill_digest ?? null,
    kind: plan?.kind ?? null,
    contract_digest: plan?.contract_digest ?? null,
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

/** The default model call for `--score`: one non-interactive Claude session. */
export function claudeExec({
  prompt,
  model,
  effort,
  cwd = process.cwd(),
  allowedTools = CLAUDE_TOOLS,
  maxTurns = CLAUDE_MAX_TURNS,
}) {
  const args = [
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
    "--allowed-tools",
    ...allowedTools,
    "--max-turns",
    String(maxTurns),
  ];
  const result = spawnSync("claude", args, {
    cwd,
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `claude exited ${result.status}: ${String(result.stderr || "").slice(-400)}`,
    );
  }
  return result.stdout;
}

async function scoreOneCell({
  cell,
  cellResult,
  contract,
  repoRoot,
  exec,
  runGit = defaultRunGit,
}) {
  const fixture = fixtureForPr(contract, cell.pr);
  const truth = readJson(path.join(repoRoot, fixture.truth_file));
  const transcript = cellResult.output;
  const claims = await extractClaims({ transcript, exec });
  const matched = await matchClaims({
    claims,
    truthFindings: truth.findings,
    scorableIds: fixture.scorable_ids,
    transcript,
    exec,
  });
  const novel = await classifyNovel({
    claims,
    matchedIds: matched.matchedIds,
    truthFindings: truth.findings,
    fixturePath: cellResult.fixture_path ?? "",
    exec,
  });
  const leak = leakSignals({
    transcript,
    truth,
    pr: cell.pr,
    excludeLogins: [
      ...loginsInFixtureTree({
        fixturePath: cellResult.fixture_path ?? "",
        logins: reviewerLogins(truth),
        runGit,
      }),
    ],
    forbiddenShas: forbiddenShasForFixture({ fixture, repoRoot }),
  });
  return {
    cell_id: cell.cell_id,
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
  const zeroFindingPrs = new Set(
    own
      .filter((cell) => (scored.get(cell.cell_id)?.claims ?? []).length === 0)
      .map((cell) => cell.pr),
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

/**
 * The stored pairing against the baseline. `--against` may name a row from a
 * different comparability key, which measures something else: that pairing is
 * recorded with a null McNemar rather than with numbers nothing may read.
 */
function buildVsBaseline({ row, baselineRow }) {
  if (!baselineRow) return null;
  const paired =
    row.comparability_key === baselineRow.comparability_key ||
    row.kind === "bridge";
  if (!paired) {
    return {
      baseline_executed_at: baselineRow.executed_at,
      baseline_comparability_key: baselineRow.comparability_key,
      mcnemar: null,
    };
  }
  const { name, condition } = headlineCondition(row);
  const baseCondition = baselineRow.conditions?.[name];
  const flips = baseCondition
    ? compareConditions(baseCondition, condition)
    : { b: 0, c: 0 };
  const vs = {
    baseline_executed_at: baselineRow.executed_at,
    baseline_comparability_key: baselineRow.comparability_key,
    mcnemar: { b: flips.b, c: flips.c, delta: flips.b - flips.c },
  };
  if (row.conditions.control && baselineRow.conditions?.control) {
    const control = compareConditions(
      baselineRow.conditions.control,
      row.conditions.control,
    );
    vs.control_mcnemar = {
      b: control.b,
      c: control.c,
      delta: control.b - control.c,
    };
  }
  return vs;
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
  const calibration = await runCalibration({ calibrationSet, exec });
  const scored = new Map();
  const missing = [];
  const leaked = [];
  for (const cell of plan.cells) {
    const cellResult = readCellResult(planDir, cell);
    if (!cellResult) {
      missing.push(cell.cell_id);
      continue;
    }
    const record = await scoreOneCell({
      cell,
      cellResult,
      contract,
      repoRoot,
      exec,
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
  if (scored.size === 0) {
    throw new Error(
      `no completed cell results under ${planDir}; run the orchestrator first`,
    );
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
    vs_baseline: null,
    detail_dir: plan.detail_dir,
    notes: notes.join(" | "),
  };
  const baseline = baselineRow ?? resolveBaseline({ rows: ledgerRows, row });
  row.vs_baseline = buildVsBaseline({ row, baselineRow: baseline });
  const decision = verdict({ contract, row, baselineRow: baseline });
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
