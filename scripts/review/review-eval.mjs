#!/usr/bin/env node

// CLI for the review-skill evaluation. Every mode except `--score` is
// deterministic and safe in CI: no model, no credential, no mutation. `--score`
// is the only mode that spends model quota, and only the local orchestrator
// (`run-eval.sh`) invokes it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  ensureLabelsExist,
  ghPaginate,
  normalizeIssuePages,
  runGh,
} from "../lib/gh-issue-lifecycle.mjs";
import {
  checkFixtures,
  DEFAULT_CONTRACT_PATH,
  frozenInputProblems,
  loadContract,
} from "./review-eval-fixtures.mjs";
import {
  appendRow,
  checkLedger,
  completeMatrixProblems,
  freshness,
  frozenDefectProblems,
  parseInstant,
  readLedger,
  validateLedgerRow,
} from "./review-eval-ledger.mjs";
import {
  parseLeadingReviewEvalMarkers,
  leakSuspected,
  renderReport,
  REVIEW_EVAL_OWNERSHIP_LABEL,
  scheduleIssuePayload,
  verdict,
} from "./review-eval-report.mjs";
import {
  assertAuthorizedFreshnessWorkflow,
  buildPlan,
  baselinePlanIdentity,
  claudeExec,
  comparabilityKey,
  DEFAULT_CALIBRATION_PATH,
  DEFAULT_LEDGER_PATH,
  DEFAULT_RUNS_DIR,
  fileDigest,
  planCells,
  planStalenessIssueSync,
  resolveKind,
  scorePlan,
} from "./review-eval-run.mjs";
import { scorerDigest } from "./review-eval-score.mjs";
import {
  resolveBaseline,
  resolveRowReference,
  revalidateRow,
} from "./review-eval-result-shape.mjs";

export const DEFAULT_REVIEW_EVAL_REPO = "mento-protocol/monitoring-monorepo";

const MODE_OPTIONS = {
  "check-fixtures": ["offline", "src-repo"],
  "check-ledger": ["base-ref", "require-base", "revalidate-appended"],
  plan: ["kind", "skill-ref", "out", "runs-dir", "against"],
  score: ["against", "calibration"],
  validate: ["append", "against", "calibration", "detail-dir"],
  report: ["against", "row"],
  "schedule-issue": ["repo", "dry-run", "date"],
};

const OPTION_SPEC = {
  "check-fixtures": { type: "boolean" },
  "check-ledger": { type: "boolean" },
  plan: { type: "boolean" },
  score: { type: "string" },
  validate: { type: "string" },
  report: { type: "boolean" },
  "schedule-issue": { type: "boolean" },
  offline: { type: "boolean" },
  "src-repo": { type: "string" },
  "base-ref": { type: "string" },
  "require-base": { type: "boolean" },
  "revalidate-appended": { type: "boolean" },
  kind: { type: "string" },
  "skill-ref": { type: "string" },
  out: { type: "string" },
  "runs-dir": { type: "string" },
  against: { type: "string" },
  "detail-dir": { type: "string" },
  calibration: { type: "string" },
  append: { type: "boolean" },
  row: { type: "string" },
  repo: { type: "string" },
  "dry-run": { type: "boolean" },
  date: { type: "string" },
  contract: { type: "string" },
  ledger: { type: "string" },
  root: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export function parseArgs(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv.filter((arg) => arg !== "--"),
      options: OPTION_SPEC,
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    // node:util reports the offending flag; keep its wording, drop its stack.
    throw new Error(error.message, { cause: error });
  }
  const values = parsed.values;
  const modes = Object.keys(MODE_OPTIONS).filter((mode) =>
    values[mode] === undefined ? false : values[mode] !== false,
  );
  if (values.help) return { mode: null, help: true };
  if (modes.length === 0) {
    throw new Error(
      `choose one of ${Object.keys(MODE_OPTIONS)
        .map((mode) => `--${mode}`)
        .join(", ")}`,
    );
  }
  if (modes.length > 1) {
    throw new Error(`choose exactly one mode; got --${modes.join(" and --")}`);
  }
  const mode = modes[0];
  if (typeof values[mode] === "string" && values[mode].trim() === "") {
    throw new Error(`--${mode} requires a value`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (
      name in MODE_OPTIONS ||
      ["contract", "ledger", "root", "json", "help"].includes(name)
    ) {
      continue;
    }
    if (value === undefined || value === false) continue;
    if (!MODE_OPTIONS[mode].includes(name)) {
      throw new Error(`--${name} is not valid with --${mode}`);
    }
  }
  const options = {
    mode,
    help: false,
    repoRoot: values.root ?? process.cwd(),
    contractPath: values.contract ?? DEFAULT_CONTRACT_PATH,
    ledgerPath: values.ledger ?? DEFAULT_LEDGER_PATH,
    calibrationPath: values.calibration ?? DEFAULT_CALIBRATION_PATH,
    runsDir: values["runs-dir"] ?? DEFAULT_RUNS_DIR,
    offline: values.offline === true,
    srcRepo: values["src-repo"] ?? null,
    baseRef: values["base-ref"] ?? "origin/main",
    requireBase: values["require-base"] === true,
    revalidateAppended: values["revalidate-appended"] === true,
    kind: values.kind ?? null,
    skillRef: values["skill-ref"] ?? null,
    outDir: values.out ?? null,
    planDir: mode === "score" ? values.score : null,
    resultPath: mode === "validate" ? values.validate : null,
    against: values.against ?? null,
    detailDir: values["detail-dir"] ?? null,
    rowPath: values.row ?? null,
    append: values.append === true,
    repo: values.repo ?? env.GITHUB_REPOSITORY ?? DEFAULT_REVIEW_EVAL_REPO,
    dryRun: values["dry-run"] === true,
    date: values.date ?? new Date().toISOString().slice(0, 10),
    // The instant freshness is evaluated at, which is not the start of
    // `--date`. The scheduled workflow runs mid-morning UTC, and a row merged
    // earlier the same day is dated after midnight: `freshness()` counts such a
    // row as future-dated and lets no clock read it, so the workflow stays red
    // and keeps a staleness issue open over a run that is already there. An
    // explicit `--date` is the dated-test case and keeps naming that midnight.
    now:
      values.date === undefined
        ? new Date().toISOString()
        : `${values.date}T00:00:00Z`,
    json: values.json === true,
  };
  if (mode === "plan") {
    options.kind = options.kind ?? "auto";
    if (!["full", "canary", "auto"].includes(options.kind)) {
      throw new Error("--kind must be full, canary, or auto");
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) {
    throw new Error("--repo must be an owner/repository slug");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error("--date must be YYYY-MM-DD");
  }
  return options;
}

function usage() {
  return `Usage: node scripts/review/review-eval.mjs MODE [options]

Plan, score, validate, and report the recurring review-skill evaluation. Only
--score invokes a model; every other mode is deterministic and CI-safe.

Modes:
  --check-fixtures       Validate the frozen contract, truth, and prompts
  --check-ledger         Validate the ledger, its append-only history, freshness
  --plan                 Print the run matrix and write plan.json
  --score PLANDIR        Score collected run output (spends model quota)
  --validate FILE        Recompute one ledger row from its own detail
  --report               Render the ledger PR body for one row
  --schedule-issue       Create or retain the staleness issue

Options:
  --offline              Resolve eval tags locally, never over the network
  --src-repo PATH        Resolve eval tags from a local clone
  --base-ref REF         Append-only comparison base (default: origin/main)
  --require-base         Fail when the base ref does not resolve (--check-ledger)
  --revalidate-appended  Recompute every row this branch appends from its
                         committed detail (--check-ledger); calls no model
  --kind full|canary|auto  Run matrix to plan (default: auto, read from ledger)
  --skill-ref PATH       Evaluate a candidate skill directory; stamps dirty
  --out DIR              Plan directory (default: the run's detail directory)
  --runs-dir PATH        Detail root (default: ${DEFAULT_RUNS_DIR})
  --against REF          Baseline row: a file path or an executed_at prefix
                         (--plan, --score, --report, and --validate)
  --detail-dir DIR       Run detail to recompute from (--validate); default is
                         the row's own detail_dir under --root
  --row REF              Row to report (default: the newest ledger row)
  --calibration PATH     Judge calibration set (--score, --validate); --score
                         refuses it unless it digests to the set the plan's key
                         hashed, and --validate reads it to re-derive the row's
                         recorded judge_calibration
  --append               Append the validated row to the ledger (--validate)
  --repo OWNER/REPO      Repository for issue scheduling
  --dry-run              Plan issue synchronization without mutating
  --date YYYY-MM-DD      Scheduler date (default: today UTC)
  --contract PATH        Contract path (default: ${DEFAULT_CONTRACT_PATH})
  --ledger PATH          Ledger path (default: ${DEFAULT_LEDGER_PATH})
  --root PATH            Repository root (default: current directory)
  --json                 Print machine-readable output
  -h, --help             Show this help
`;
}

function printObject(value, json) {
  process.stdout.write(
    `${json ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`,
  );
}

function summarize(line, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

function loadContext(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const { contract, digest } = loadContract(
    path.resolve(repoRoot, options.contractPath),
  );
  return { repoRoot, contract, contractDigest: digest };
}

/**
 * Rows at the append-only comparison base.
 *
 * Two outcomes are not the same failure and are never reported as one. A base
 * ref that does not resolve means the append-only check cannot run at all, and
 * `--require-base` turns that into a hard failure. A ref that resolves while
 * the ledger is absent there is a legitimate bootstrap branch: there is
 * nothing committed to compare against yet.
 *
 * The comparison point is `git merge-base <baseRef> HEAD` when that resolves,
 * so a branch that predates later rows on the base branch is not accused of
 * deleting them. It falls back to the base ref tip and says which it used.
 */
export function baseLedgerRows({
  repoRoot,
  baseRef,
  ledgerPath,
  run = spawnSync,
}) {
  const git = (args) => run("git", args, { cwd: repoRoot, encoding: "utf8" });
  const resolved = git([
    "rev-parse",
    "--verify",
    "--quiet",
    `${baseRef}^{commit}`,
  ]);
  if (resolved.status !== 0) {
    return {
      rows: null,
      resolved: false,
      base: null,
      mode: null,
      reason: `base ref ${baseRef} does not resolve in this checkout; the append-only comparison cannot run`,
    };
  }
  const mergeBase = git(["merge-base", baseRef, "HEAD"]);
  const commit = String(mergeBase.stdout ?? "").trim();
  const usedMergeBase = mergeBase.status === 0 && commit !== "";
  const base = usedMergeBase ? commit : baseRef;
  const shown = git(["show", `${base}:${ledgerPath}`]);
  if (shown.status !== 0) {
    return {
      rows: null,
      resolved: true,
      base,
      mode: usedMergeBase ? "merge-base" : "tip",
      reason: `${ledgerPath} does not exist at ${base}; there is no committed base ledger yet`,
    };
  }
  return {
    rows: String(shown.stdout)
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line)),
    resolved: true,
    base,
    mode: usedMergeBase ? "merge-base" : "tip",
    reason: null,
  };
}

async function defaultListIssues(options) {
  const pages = await ghPaginate(`repos/${options.repo}/issues?state=all`);
  return normalizeIssuePages(pages, {
    ownershipLabel: REVIEW_EVAL_OWNERSHIP_LABEL,
    parseMarker: parseLeadingReviewEvalMarkers,
  });
}

async function defaultCreateIssue(options, payload) {
  return runGh([
    "issue",
    "create",
    "--repo",
    options.repo,
    "--title",
    payload.title,
    "--body",
    payload.body,
    "--label",
    payload.labels.join(","),
  ]);
}

export async function runScheduleIssue(options, context, deps = {}) {
  const {
    listIssues = defaultListIssues,
    authorize = assertAuthorizedFreshnessWorkflow,
    ensureLabels = ensureLabelsExist,
    createIssue = defaultCreateIssue,
    now = new Date(options.now ?? `${options.date}T00:00:00Z`),
  } = deps;
  const rows = readLedger(path.resolve(context.repoRoot, options.ledgerPath));
  const age = freshness({
    rows,
    contract: context.contract,
    now,
    contractDigest: context.contractDigest,
  });
  const payload = scheduleIssuePayload({
    freshnessResult: age,
    contract: context.contract,
    contractDigest: context.contractDigest,
    month: options.date.slice(0, 7),
  });
  if (!payload) {
    return {
      action: "skip-fresh",
      reason: `ledger is fresh: ${age.daysSinceAny} day(s) since the newest run`,
      level: age.level,
      reasons: age.reasons,
      mutated: false,
    };
  }
  const issues = await listIssues(options);
  const decision = planStalenessIssueSync({
    month: options.date.slice(0, 7),
    contractDigest: context.contractDigest,
    issues,
    payload,
  });
  let mutated = false;
  if (decision.action === "create" && !options.dryRun) {
    await authorize(options);
    await ensureLabels(options);
    await createIssue(options, payload);
    mutated = true;
  }
  return {
    action: decision.action,
    reason: decision.reason,
    issue_number: decision.issue?.number ?? null,
    level: age.level,
    reasons: age.reasons,
    title: payload.title,
    dry_run: options.dryRun,
    mutated,
  };
}

async function modeCheckFixtures(options, context) {
  const result = checkFixtures({
    contract: context.contract,
    repoRoot: context.repoRoot,
    offline: options.offline,
    // Offline resolves the eval tags in the local object store, which is the
    // only store there is without the network. Online is the mode that proves
    // the tags against the remote the contract names, so it must not fall back
    // to this checkout: a local tag that still points at the pinned commit
    // passes while the remote tag has moved or been deleted. An explicit
    // --src-repo names a clone to resolve from and wins in both modes.
    srcRepo: options.srcRepo
      ? path.resolve(options.srcRepo)
      : options.offline
        ? context.repoRoot
        : null,
  });
  printObject(
    {
      ok: result.ok,
      suite_id: context.contract.suite_id,
      contract_digest: context.contractDigest,
      ...result.checked,
      problems: result.problems,
    },
    options.json,
  );
  if (!result.ok) process.exitCode = 1;
}

async function modeCheckLedger(options, context) {
  const ledgerPath = path.resolve(context.repoRoot, options.ledgerPath);
  const base = baseLedgerRows({
    repoRoot: context.repoRoot,
    baseRef: options.baseRef,
    ledgerPath: options.ledgerPath,
  });
  const result = checkLedger({
    path: ledgerPath,
    contract: context.contract,
    contractDigest: context.contractDigest,
    baseRows: base.rows ?? undefined,
  });
  // A guard that silently no-ops is worse than no guard. `--require-base` is
  // for every caller that must prove the append-only check actually ran.
  if (options.requireBase && !base.resolved) {
    result.problems.push(base.reason);
    result.ok = false;
  }
  const revalidated = options.revalidateAppended
    ? revalidateAppendedRows({ options, context, result, base })
    : null;
  if (revalidated && !revalidated.ok) result.ok = false;
  const age = freshness({
    rows: result.rows,
    contract: context.contract,
    contractDigest: context.contractDigest,
  });
  printObject(
    {
      ok: result.ok,
      rows: result.rows.length,
      comparable_rows: result.comparableRows.length,
      append_only_base: base.rows ? options.baseRef : null,
      append_only_ref: base.base,
      append_only_mode: base.mode,
      append_only_reason: base.reason,
      freshness: {
        level: age.level,
        days_since_any: age.daysSinceAny,
        days_since_complete: age.daysSinceComplete,
        days_since_full: age.daysSinceFull,
        reasons: age.reasons,
      },
      revalidated_rows: revalidated?.checked ?? null,
      unpaired_baselines: revalidated?.unpaired ?? null,
      problems: result.problems,
    },
    options.json,
  );
  if (!result.ok) process.exitCode = 1;
}

/** Whether a detail directory holds any scored cell result. */
function holdsCellResults(dir) {
  try {
    return readdirSync(dir).some(
      (name) => name.startsWith("result-") && name.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

/** Reject evidence links and special files before any JSON reader follows them. */
function nonRegularEvidenceProblems(dir) {
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const file of readdirSync(dir).filter(
    (name) =>
      name === "calibration.json" ||
      name === "plan.json" ||
      (name.startsWith("result-") && name.endsWith(".json")),
  )) {
    try {
      if (!lstatSync(path.join(dir, file)).isFile()) {
        problems.push(`${dir}/${file} must be a regular evidence file`);
      }
    } catch {
      problems.push(`${dir}/${file} cannot be inspected as an evidence file`);
    }
  }
  return problems;
}

/**
 * The row's provenance, checked against the plan that produced it.
 *
 * `revalidateRow` re-derives every number a row states from the cell records
 * beside it, and nothing else. The fields that say which run those records
 * belong to — the contract, the comparability key, the kind, the recorded
 * inputs and the detail directory — it takes from the row. Editing one after
 * the local append therefore survived CI: a changed `comparability_key` on the
 * first full row keeps its no-baseline GREEN verdict, opens a lineage no run
 * produced, and `resolveBaseline` anchors every later run on it.
 *
 * `plan.json` is committed in the same directory as the cell records and is
 * written before the matrix spends anything, so it is the run's own statement
 * of what it was. A directory that holds cell results must hold it: deleting
 * the file cannot buy back the check, exactly as with `calibration.json`. A
 * Only an evidence-free hand-assembled bridge row may omit the plan. It cannot
 * become an automatic anchor or refresh the full-run clock.
 */
export function planProvenanceProblems({
  dir,
  row,
  contract,
  baselineRow = null,
  expectedComparabilityKey = null,
}) {
  const file = path.join(dir, "plan.json");
  if (!existsSync(file)) {
    if (row.kind === "bridge" && !holdsCellResults(dir)) return [];
    return [
      `${dir} carries no plan.json; the row's provenance cannot be checked against the run that produced it`,
    ];
  }
  let plan;
  try {
    plan = readJson(file);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const problems = [];
  /** True when the plan carries the complete explicit-baseline fingerprint. */
  const validBaselineIdentity = (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "comparability_key",
          "contract_digest",
          "detail_dir",
          "executed_at",
          "row_digest",
        ].sort(),
      ) &&
    parseInstant(value.executed_at) !== null &&
    /^[0-9a-f]{64}$/.test(value.contract_digest) &&
    /^[0-9a-f]{64}$/.test(value.comparability_key) &&
    typeof value.detail_dir === "string" &&
    value.detail_dir.length > 0 &&
    /^[0-9a-f]{64}$/.test(value.row_digest);
  for (const field of [
    "contract_digest",
    "comparability_key",
    "kind",
    "detail_dir",
  ]) {
    // The one kind a plan can legitimately disagree about. No CLI mode plans a
    // bridge — `--kind` takes `full` and `canary`, and `buildPlan` refuses
    // anything else — so the model-retirement procedure in
    // docs/evals/review-skill.md builds the bridge row by hand from the newer
    // of the two full runs: it copies that run's `row.json`, changes only
    // `kind`, and validates against that run's own detail directory. Demanding
    // plan parity on `kind` therefore rejected every bridge row the runbook
    // can produce, and `--revalidate-appended` is a required step of the
    // ledger PR. Only `bridge` over a `full` plan is allowed: a bridge over a
    // canary plan, or any other kind swap, is still an edit, and the other
    // three fields plus `inputs` are still checked for a bridge row.
    if (field === "kind" && row.kind === "bridge" && plan.kind === "full") {
      continue;
    }
    if (row[field] !== plan[field]) {
      problems.push(
        `row ${field} is ${JSON.stringify(row[field])}; plan.json in ${row.detail_dir} planned ${JSON.stringify(plan[field])}`,
      );
    }
  }
  if (
    expectedComparabilityKey !== null &&
    plan.comparability_key !== expectedComparabilityKey
  ) {
    problems.push(
      `plan.json in ${row.detail_dir} carries comparability_key ${JSON.stringify(plan.comparability_key)}; current frozen inputs derive ${expectedComparabilityKey}`,
    );
  }
  // The inputs are the skill, argv, orchestrator and CLI provenance the scorer
  // copies out of the plan verbatim, so any difference is an edit.
  if (JSON.stringify(row.inputs) !== JSON.stringify(plan.inputs)) {
    problems.push(
      `row inputs do not match the inputs plan.json in ${row.detail_dir} recorded`,
    );
  }
  if (!["automatic", "explicit"].includes(plan.baseline_selection)) {
    problems.push(
      `plan.json in ${row.detail_dir} carries invalid baseline_selection ${JSON.stringify(plan.baseline_selection)}`,
    );
  } else if (
    plan.baseline_selection === "automatic" &&
    plan.baseline !== null
  ) {
    problems.push(
      `plan.json in ${row.detail_dir} planned automatic baseline selection but carries an explicit baseline identity`,
    );
  } else if (
    plan.baseline_selection === "explicit" &&
    !validBaselineIdentity(plan.baseline)
  ) {
    problems.push(
      `plan.json in ${row.detail_dir} planned an explicit baseline but carries no valid baseline identity`,
    );
  } else if (
    plan.baseline_selection === "explicit" &&
    row.vs_baseline === null &&
    row.kind !== "bridge" &&
    row.status !== "failed"
  ) {
    problems.push(
      `row has no vs_baseline; plan.json in ${row.detail_dir} planned an explicit baseline`,
    );
  } else if (row.vs_baseline !== null && row.kind !== "bridge") {
    if (row.vs_baseline?.selection !== plan.baseline_selection) {
      problems.push(
        `row baseline selection is ${JSON.stringify(row.vs_baseline?.selection)}; plan.json in ${row.detail_dir} planned ${JSON.stringify(plan.baseline_selection)}`,
      );
    }
    if (
      plan.baseline_selection === "explicit" &&
      (plan.baseline.executed_at !== row.vs_baseline?.baseline_executed_at ||
        plan.baseline.comparability_key !==
          row.vs_baseline?.baseline_comparability_key)
    ) {
      problems.push(
        `row baseline identity does not match the explicit baseline plan.json in ${row.detail_dir} recorded`,
      );
    }
  }
  if (
    plan.baseline_selection === "explicit" &&
    baselineRow !== null &&
    JSON.stringify(plan.baseline) !==
      JSON.stringify(baselinePlanIdentity(baselineRow))
  ) {
    problems.push(
      `resolved baseline does not match the explicit baseline identity plan.json in ${row.detail_dir} recorded`,
    );
  }
  if (!Array.isArray(plan.cells)) {
    problems.push(`plan.json in ${row.detail_dir} carries no cells array`);
    return problems;
  }
  if (!contract || !["full", "canary"].includes(plan.kind)) {
    problems.push(
      `plan.json in ${row.detail_dir} has no frozen ${plan.kind ?? "unknown"} matrix to validate`,
    );
  } else {
    const expectedCells = planCells({ contract, kind: plan.kind });
    if (JSON.stringify(plan.cells) !== JSON.stringify(expectedCells)) {
      problems.push(
        `plan.json in ${row.detail_dir} cells do not match the frozen ${plan.kind} matrix`,
      );
    }
  }
  for (const [name, condition] of Object.entries(row.conditions ?? {})) {
    const cells = plan.cells.filter((cell) => cell.condition === name);
    if (cells.length === 0) {
      problems.push(
        `row condition ${name} has no matching cell in plan.json in ${row.detail_dir}`,
      );
      continue;
    }
    for (const field of ["model", "effort", "finder"]) {
      const planned = [...new Set(cells.map((cell) => cell[field]))];
      if (planned.length !== 1) {
        problems.push(
          `plan.json in ${row.detail_dir} records ${planned.length} ${field} values for condition ${name}`,
        );
      } else if (condition?.[field] !== planned[0]) {
        problems.push(
          `row condition ${name}.${field} is ${JSON.stringify(condition?.[field])}; plan.json recorded ${JSON.stringify(planned[0])}`,
        );
      }
    }
  }
  return problems;
}

/** Validate required fields that every scored result must retain. */
function resultEvidenceProblems({ dir, row }) {
  if (row.status === "failed" || !existsSync(dir)) return [];
  const regularityProblems = nonRegularEvidenceProblems(dir);
  if (regularityProblems.length > 0) return regularityProblems;
  const problems = [];
  if (holdsCellResults(dir)) {
    const scoringUsd = row?.scoring_usd;
    if (
      !Object.hasOwn(row ?? {}, "scoring_usd") ||
      typeof scoringUsd !== "number" ||
      !Number.isFinite(scoringUsd) ||
      scoringUsd < 0
    ) {
      problems.push(
        "row.scoring_usd must be a nonnegative finite number for scored evidence",
      );
    }
  }
  let resultRecordsLeak = false;
  for (const resultFile of readdirSync(dir).filter(
    (name) => name.startsWith("result-") && name.endsWith(".json"),
  )) {
    try {
      const record = readJson(path.join(dir, resultFile));
      const scoringUsd = record?.scoring_usd;
      if (
        !Object.hasOwn(record ?? {}, "scoring_usd") ||
        typeof scoringUsd !== "number" ||
        !Number.isFinite(scoringUsd) ||
        scoringUsd < 0
      ) {
        problems.push(
          `${dir}/${resultFile} scoring_usd must be a nonnegative finite number`,
        );
      }
      const leak = record?.leak;
      const hard = leak?.hard;
      const suspected = leak?.suspected;
      if (
        leak === null ||
        typeof leak !== "object" ||
        Array.isArray(leak) ||
        !Array.isArray(hard) ||
        typeof suspected !== "boolean"
      ) {
        problems.push(
          `${dir}/${resultFile} leak must carry a hard array and suspected boolean`,
        );
      } else if (suspected !== hard.length > 0) {
        problems.push(
          `${dir}/${resultFile} leak.suspected must equal whether leak.hard is non-empty`,
        );
      }
      if (suspected === true || (Array.isArray(hard) && hard.length > 0)) {
        resultRecordsLeak = true;
      }
    } catch {
      // The normal evidence checks report unreadable result records.
    }
  }
  const calibrationFile = path.join(dir, "calibration.json");
  if (existsSync(calibrationFile)) {
    try {
      const calibration = readJson(calibrationFile);
      const scoringUsd = calibration?.scoring_usd;
      if (
        !Object.hasOwn(calibration ?? {}, "scoring_usd") ||
        typeof scoringUsd !== "number" ||
        !Number.isFinite(scoringUsd) ||
        scoringUsd < 0
      ) {
        problems.push(
          `${dir}/calibration.json scoring_usd must be a nonnegative finite number`,
        );
      }
    } catch {
      // The calibration evidence checks report an unreadable record.
    }
  }
  if (resultRecordsLeak && !leakSuspected(row)) {
    problems.push(
      `${dir} carries a result with leak.suspected true, but the row notes omit leak suspected`,
    );
  }
  if (resultRecordsLeak && row.verdict !== "AMBER") {
    problems.push(
      `${dir} carries a result with leak.suspected true, but the row verdict is ${row.verdict} instead of AMBER`,
    );
  }
  return problems;
}

/** Evidence files required for every row that claims scored results. */
function runEvidenceProblems({ dir, row, contract }) {
  if (row.status === "failed") return [];
  const regularityProblems = nonRegularEvidenceProblems(dir);
  if (regularityProblems.length > 0) return regularityProblems;
  const problems = resultEvidenceProblems({ dir, row });
  // A bridge intentionally reuses the source full run's plan and scored
  // records. It owes no new evidence, but it must retain any leak flag those
  // records carry because that flag makes the reused score unusable.
  if (row.kind === "bridge") return problems;
  if (!holdsCellResults(dir)) {
    problems.push(`${dir} carries no scored result-*.json files`);
  }
  const planFile = path.join(dir, "plan.json");
  if (existsSync(planFile)) {
    try {
      const plan = readJson(planFile);
      if (Array.isArray(plan.cells)) {
        const rowConditions = new Set(Object.keys(row.conditions ?? {}));
        const planConditions = new Set(
          plan.cells.map((cell) => cell.condition),
        );
        const plannedResults = new Map(
          plan.cells.map((cell) => [
            `result-${cell.pr}-${cell.condition}-${cell.draw}.json`,
            cell,
          ]),
        );
        const resultFiles = readdirSync(dir).filter(
          (name) => name.startsWith("result-") && name.endsWith(".json"),
        );
        for (const resultFile of resultFiles) {
          const cell = plannedResults.get(resultFile);
          if (!cell) {
            problems.push(`${dir} carries unplanned result file ${resultFile}`);
            continue;
          }
          let record;
          try {
            record = readJson(path.join(dir, resultFile));
          } catch (error) {
            problems.push(
              error instanceof Error ? error.message : String(error),
            );
            continue;
          }
          for (const field of ["cell_id", "pr", "condition", "draw"]) {
            if (record?.[field] !== cell[field]) {
              problems.push(
                `${dir}/${resultFile} ${field} is ${JSON.stringify(record?.[field])}; plan.json recorded ${JSON.stringify(cell[field])}`,
              );
            }
          }
          const fixture = contract.fixtures.find(
            (candidate) => candidate.pr === cell.pr,
          );
          if (!Array.isArray(record?.matched_ids)) {
            problems.push(`${dir}/${resultFile} matched_ids must be an array`);
          } else if (fixture) {
            const allowedIds = new Set(fixture.scorable_ids.map(String));
            for (const id of record.matched_ids) {
              if (
                !(
                  typeof id === "string" ||
                  (typeof id === "number" && Number.isSafeInteger(id))
                )
              ) {
                problems.push(
                  `${dir}/${resultFile} matched_ids contains non-scalar ${JSON.stringify(id)}`,
                );
              } else if (!allowedIds.has(String(id))) {
                problems.push(
                  `${dir}/${resultFile} matched_ids contains ${JSON.stringify(id)}, which fixture PR ${cell.pr} does not score`,
                );
              }
            }
          }
          const claims = record?.claims;
          if (!Array.isArray(claims)) {
            problems.push(`${dir}/${resultFile} claims must be an array`);
          } else {
            for (const claim of claims) {
              if (typeof claim !== "string" || claim.trim().length === 0) {
                problems.push(
                  `${dir}/${resultFile} claims must contain only non-empty strings`,
                );
                break;
              }
            }
          }
          for (const field of [
            "claims",
            "novelWrong",
            "novelReal",
            "novelVague",
            "restatedKnown",
            "alreadyMatched",
          ]) {
            const value = Number(record?.novel?.[field]);
            if (!Number.isSafeInteger(value) || value < 0) {
              problems.push(
                `${dir}/${resultFile} novel.${field} must be a nonnegative safe integer`,
              );
            }
          }
          if (
            Array.isArray(claims) &&
            record?.novel?.claims !== claims.length
          ) {
            problems.push(
              `${dir}/${resultFile} novel.claims must equal the claims array length`,
            );
          }
          if (
            Array.isArray(record?.matched_ids) &&
            record?.novel?.alreadyMatched !== record.matched_ids.length
          ) {
            problems.push(
              `${dir}/${resultFile} novel.alreadyMatched must equal the matched_ids array length`,
            );
          }
          const verdicts = record?.novel?.verdicts;
          if (
            verdicts === null ||
            typeof verdicts !== "object" ||
            Array.isArray(verdicts)
          ) {
            problems.push(
              `${dir}/${resultFile} novel.verdicts must be an object`,
            );
          } else if (Array.isArray(claims)) {
            const expectedKeys = claims.map((_claim, index) =>
              String(index + 1),
            );
            const actualKeys = Object.keys(verdicts).sort(
              (left, right) => Number(left) - Number(right),
            );
            if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
              problems.push(
                `${dir}/${resultFile} novel.verdicts must carry one numbered verdict per claim`,
              );
            }
            const counts = {
              real: 0,
              wrong: 0,
              vague: 0,
              known: 0,
            };
            let validVerdicts = true;
            for (const verdict of Object.values(verdicts)) {
              if (
                verdict === null ||
                typeof verdict !== "object" ||
                Array.isArray(verdict) ||
                !Object.hasOwn(counts, verdict.class)
              ) {
                validVerdicts = false;
                break;
              }
              counts[verdict.class] += 1;
            }
            if (!validVerdicts) {
              problems.push(
                `${dir}/${resultFile} novel.verdicts carries an invalid class`,
              );
            } else {
              for (const [field, count] of [
                ["novelReal", counts.real],
                ["novelWrong", counts.wrong],
                ["novelVague", counts.vague],
                ["restatedKnown", counts.known],
              ]) {
                if (record?.novel?.[field] !== count) {
                  problems.push(
                    `${dir}/${resultFile} novel.${field} does not match novel.verdicts`,
                  );
                }
              }
            }
          }
          for (const field of ["usd", "seconds"]) {
            const value = record?.[field];
            if (
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0
            ) {
              problems.push(
                `${dir}/${resultFile} ${field} must be a nonnegative finite number`,
              );
            }
          }
          if (!rowConditions.has(cell.condition)) {
            problems.push(
              `${dir}/${resultFile} records condition ${cell.condition}, but the row omits it`,
            );
          }
        }
        if (row.status === "complete") {
          for (const condition of planConditions) {
            if (!rowConditions.has(condition)) {
              problems.push(
                `${dir} planned condition ${condition}, but the complete row omits it`,
              );
            }
          }
          for (const condition of rowConditions) {
            if (!planConditions.has(condition)) {
              problems.push(
                `${dir} complete row condition ${condition} has no planned cells`,
              );
            }
          }
          for (const cell of plan.cells) {
            const resultFile = `result-${cell.pr}-${cell.condition}-${cell.draw}.json`;
            if (!resultFiles.includes(resultFile)) {
              problems.push(
                `${dir} carries no ${resultFile} for planned cell ${cell.cell_id ?? "unknown"}`,
              );
            }
          }
        } else {
          const cells = plan.cells.filter((cell) =>
            rowConditions.has(cell.condition),
          );
          for (const condition of rowConditions) {
            const resultCells = cells.filter(
              (cell) =>
                cell.condition === condition &&
                resultFiles.includes(
                  `result-${cell.pr}-${cell.condition}-${cell.draw}.json`,
                ),
            );
            if (resultCells.length === 0) {
              problems.push(
                `${dir} carries no scored result for row condition ${condition}`,
              );
              continue;
            }
            const representedPrs = new Set(resultCells.map((cell) => cell.pr));
            const perDefect = row.conditions?.[condition]?.per_defect ?? {};
            for (const pr of representedPrs) {
              const fixture = contract.fixtures.find(
                (candidate) => candidate.pr === pr,
              );
              const missingIds = (fixture?.scorable_ids ?? [])
                .map(String)
                .filter((id) => !Object.hasOwn(perDefect, id));
              if (missingIds.length > 0) {
                problems.push(
                  `${dir} row condition ${condition} omits frozen defect ${missingIds.join(", ")} for scored result PR ${pr}`,
                );
              }
            }
          }
        }
      }
    } catch {
      // planProvenanceProblems reports the unreadable plan with its full error.
    }
  }
  if (!existsSync(path.join(dir, "calibration.json"))) {
    problems.push(`${dir} carries no calibration.json`);
  }
  return problems;
}

/** Canonical JSON text for evidence fingerprints. */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest one run's exact canonical scored evidence, independent of layout. */
function runEvidenceDigest(dir) {
  if (!existsSync(dir)) return null;
  if (nonRegularEvidenceProblems(dir).length > 0) return null;
  const files = readdirSync(dir)
    .filter(
      (name) =>
        name === "calibration.json" ||
        (name.startsWith("result-") && name.endsWith(".json")),
    )
    .sort();
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  const update = (value) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  try {
    for (const file of files) {
      update(file);
      update(canonicalJson(readJson(path.join(dir, file))));
    }
  } catch {
    return null;
  }
  return hash.digest("hex");
}

/**
 * Recompute every row this branch appends, from the detail the same branch
 * commits. `checkLedger` proves a ledger PR is schema-valid, covers the frozen
 * ids and adds rows without editing older ones — and nothing more. Editing a
 * committed row's `verdict`, its counters or a `per_defect` bit before opening
 * the PR left all three checks green while the committed report no longer
 * matched its own cell and calibration evidence, and `--validate` ran only on
 * the operator's machine before the commit.
 *
 * No model is called: `revalidateRow` reads the committed `result-*.json` and
 * `calibration.json` files. The job that runs this holds no model credential.
 */
function revalidateAppendedRows({ options, context, result, base }) {
  const problems = [];
  const rows = result.rows;
  // Which rows are new is the base comparison's answer. An unresolvable base
  // ref leaves that unanswerable — recomputing the whole history would judge
  // rows of retired contracts, and checking nothing is a guard that silently
  // no-ops. A base that resolves but carries no ledger is the bootstrap case:
  // every row on this branch is appended, zero rows included.
  if (!base.rows && !base.resolved) {
    result.problems.push(
      `--revalidate-appended cannot tell which rows are new: ${base.reason}`,
    );
    return { ok: false, checked: null, unpaired: null };
  }
  const appended = base.rows ? rows.slice(base.rows.length) : rows;
  const calibrationFile = path.resolve(
    context.repoRoot,
    options.calibrationPath,
  );
  const calibrationSet = existsSync(calibrationFile)
    ? readJson(calibrationFile)
    : null;
  const expectedComparabilityKey = comparabilityKey({
    contract: context.contract,
    contractDigest: context.contractDigest,
    calibrationDigest: fileDigest(calibrationFile),
  });
  const repoRoot = realpathSync(context.repoRoot);
  const detailDirectoryIdentity = (detailDir, label) => {
    const resolved = path.resolve(repoRoot, detailDir);
    const insideRepo = (target) => {
      const relative = path.relative(repoRoot, target);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    };
    if (!insideRepo(resolved)) {
      problems.push(`${label} names detail_dir ${detailDir} outside the repo`);
      return null;
    }
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    if (!insideRepo(canonical)) {
      problems.push(`${label} names detail_dir ${detailDir} outside the repo`);
      return null;
    }
    if (canonical === repoRoot) {
      problems.push(`${label} names the repository root as detail_dir`);
      return null;
    }
    return canonical;
  };
  const usedDetailDirs = new Set();
  const usedEvidence = new Map();
  const baseDetailPaths = new Map();
  for (const row of base.rows ?? []) {
    if (typeof row.detail_dir !== "string") continue;
    const identity = detailDirectoryIdentity(
      row.detail_dir,
      `base row ${row.executed_at}`,
    );
    if (identity !== null) {
      usedDetailDirs.add(identity);
      baseDetailPaths.set(
        path
          .relative(repoRoot, path.resolve(repoRoot, row.detail_dir))
          .split(path.sep)
          .join("/"),
        row.executed_at,
      );
      baseDetailPaths.set(
        path.relative(repoRoot, identity).split(path.sep).join("/"),
        row.executed_at,
      );
      problems.push(
        ...nonRegularEvidenceProblems(identity).map(
          (problem) => `base row ${row.executed_at}: ${problem}`,
        ),
      );
      if (row.kind !== "bridge" && row.status !== "failed") {
        const digest = runEvidenceDigest(identity);
        if (digest !== null) {
          usedEvidence.set(digest, `base row ${row.executed_at}`);
        }
      }
    }
  }
  if (base.rows && base.base) {
    const changed = spawnSync(
      "git",
      ["diff", "--name-only", "-z", "--no-renames", base.base, "--"],
      { cwd: repoRoot },
    );
    if (changed.status !== 0) {
      problems.push(
        `could not compare base evidence directories with ${base.base}`,
      );
    } else {
      for (const changedPath of String(changed.stdout)
        .split("\0")
        .filter(Boolean)) {
        for (const [detailPath, executedAt] of baseDetailPaths) {
          if (
            changedPath === detailPath ||
            changedPath.startsWith(`${detailPath}/`) ||
            detailPath.startsWith(`${changedPath}/`)
          ) {
            problems.push(
              `base row ${executedAt} evidence changed at ${changedPath}`,
            );
            break;
          }
        }
      }
    }
  }
  let unpaired = 0;
  for (const row of appended) {
    const label = `appended row ${row.executed_at}`;
    if (!row.detail_dir) {
      problems.push(`${label} carries no detail_dir to recompute from`);
      continue;
    }
    const dir = detailDirectoryIdentity(row.detail_dir, label);
    if (dir === null) continue;
    if (row.kind !== "bridge" && usedDetailDirs.has(dir)) {
      problems.push(
        `${label} reuses detail_dir ${row.detail_dir} from an earlier ledger row`,
      );
      continue;
    }
    usedDetailDirs.add(dir);
    if (!existsSync(dir)) {
      problems.push(
        `${label} names detail_dir ${row.detail_dir}, which this branch does not commit`,
      );
      continue;
    }
    problems.push(
      ...nonRegularEvidenceProblems(dir).map(
        (problem) => `${label}: ${problem}`,
      ),
    );
    if (row.kind !== "bridge" && row.status !== "failed") {
      const digest = runEvidenceDigest(dir);
      const previous = digest === null ? null : usedEvidence.get(digest);
      if (previous) {
        problems.push(
          `${label} reuses scored result and calibration evidence from ${previous}`,
        );
      } else if (digest !== null) {
        usedEvidence.set(digest, label);
      }
    }
    // The recorded pairing is rechecked against the row it actually names, not
    // against whatever anchor this ledger would resolve on its own — those are
    // two different pairs of runs, and comparing the wrong one reports
    // differences that are not errors. A candidate row scored against an
    // installed row whose own ledger PR has not merged yet names a row this
    // branch does not carry; that pairing cannot be rechecked here, so the row
    // is recomputed against its own bits and detail alone and counted as
    // unpaired rather than failed.
    const skipsBaselinePairing = row.status === "failed";
    const recordedAt = row.vs_baseline?.baseline_executed_at ?? null;
    const baselineRow =
      recordedAt === null
        ? null
        : (rows.find((candidate) => candidate.executed_at === recordedAt) ??
          null);
    const missingRecordedBaseline = recordedAt !== null && baselineRow === null;
    const baselineSelection = row.vs_baseline?.selection ?? null;
    const candidateMissingBaseline =
      missingRecordedBaseline &&
      row.inputs?.dirty === true &&
      row.inputs?.skill_ref !== "installed" &&
      baselineSelection === "explicit";
    if (
      !skipsBaselinePairing &&
      missingRecordedBaseline &&
      !candidateMissingBaseline
    ) {
      problems.push(
        `${label}: baseline ${recordedAt} is not in the ledger; only a dirty --skill-ref candidate row with explicit selection may waive a missing baseline`,
      );
    }
    const baselineMissing = candidateMissingBaseline;
    if (baselineMissing) unpaired += 1;
    if (
      !skipsBaselinePairing &&
      recordedAt !== null &&
      baselineSelection === null
    ) {
      problems.push(
        `${label}: vs_baseline.selection must record automatic or explicit baseline selection`,
      );
    }
    const baselineIsExplicit =
      row.kind === "bridge" || baselineSelection === "explicit";
    if (!skipsBaselinePairing && !baselineMissing && !baselineIsExplicit) {
      const resolvedBaseline = resolveBaseline({ rows, row });
      const sameBaseline =
        resolvedBaseline === baselineRow ||
        (resolvedBaseline !== null &&
          baselineRow !== null &&
          resolvedBaseline.executed_at === baselineRow.executed_at &&
          resolvedBaseline.contract_digest === baselineRow.contract_digest &&
          resolvedBaseline.detail_dir === baselineRow.detail_dir);
      if (
        !sameBaseline &&
        !(resolvedBaseline === null && baselineRow === null)
      ) {
        problems.push(
          `${label}: recorded baseline ${recordedAt ?? "none"} does not match the append-order baseline ${resolvedBaseline?.executed_at ?? "none"}`,
        );
      }
    }
    const check = revalidateRow({
      contract: context.contract,
      row,
      repoRoot: context.repoRoot,
      detailDir: dir,
      ledgerRows: baselineMissing || skipsBaselinePairing ? [] : rows,
      baselineRow: skipsBaselinePairing ? null : baselineRow,
      baselineIsExplicit,
      // Half the verdict is the pairing: a regression and a promotion are both
      // read out of the flip counts against the anchor. Recomputing an unpaired
      // row without one turns a recorded RED or PROMOTE into GREEN and fails
      // the ledger PR for it, over a row the runbook says only counts toward
      // `unpaired_baselines`. The detail checks above are unaffected — they
      // read the row's own bits and its own cell records — so they still run.
      baselineMissing,
      calibrationSet,
    });
    problems.push(...check.problems.map((problem) => `${label}: ${problem}`));
    problems.push(
      ...planProvenanceProblems({
        dir,
        row,
        contract: context.contract,
        baselineRow,
        expectedComparabilityKey,
      }).map((problem) => `${label}: ${problem}`),
    );
    problems.push(
      ...runEvidenceProblems({ dir, row, contract: context.contract }).map(
        (problem) => `${label}: ${problem}`,
      ),
    );
  }
  result.problems.push(...problems);
  return { ok: problems.length === 0, checked: appended.length, unpaired };
}

async function modePlan(options, context) {
  const rows = readLedger(path.resolve(context.repoRoot, options.ledgerPath));
  const baselineRow = resolveRowReference({
    reference: options.against,
    rows,
    repoRoot: context.repoRoot,
  });
  const kind = resolveKind({
    kind: options.kind,
    rows,
    contract: context.contract,
    contractDigest: context.contractDigest,
    now: new Date(),
  });
  const plan = buildPlan({
    contract: context.contract,
    contractDigest: context.contractDigest,
    kind,
    repoRoot: context.repoRoot,
    outDir: options.outDir,
    skillRef: options.skillRef,
    runsDir: options.runsDir,
    // The rows decide which detail directory this execution may own: one a row
    // already points at holds that row's evidence and is never written again.
    ledgerRows: rows,
    baselineRow,
  });
  printObject(plan, options.json);
}

async function modeScore(options, context) {
  const planDir = path.resolve(options.planDir);
  const plan = readJson(path.join(planDir, "plan.json"));
  if (plan.contract_digest !== context.contractDigest) {
    throw new Error(
      `plan was written against contract ${plan.contract_digest.slice(0, 8)}; this contract is ${context.contractDigest.slice(0, 8)}`,
    );
  }
  // The contract digest covers the contract JSON, not the files it pins by
  // sha256. `--check-fixtures` verified those before the matrix started, and
  // under `--skill-ref` the spec worktree is the live checkout the operator
  // keeps editing for the hours the matrix runs. `scoreOneCell` reads the truth
  // files here, and the cells above already read the prompts and the frozen
  // finder reports, so an edit during the run would score against different
  // bytes under the planned comparability key. Recheck them before the judge.
  const frozen = frozenInputProblems({
    contract: context.contract,
    repoRoot: context.repoRoot,
  });
  if (frozen.length) {
    throw new Error(
      `a frozen input changed after planning; the run is not scorable against this contract:\n${frozen.join("\n")}`,
    );
  }
  // The plan's `comparability_key` already hashed a calibration set. Scoring
  // with a different one would produce an agreement number, and through it a
  // verdict, from pairs that key never saw, and the row would still be paired
  // against every default-calibration row. Refuse the mismatch instead.
  const calibrationFile = path.resolve(
    context.repoRoot,
    options.calibrationPath,
  );
  const calibrationDigest = fileDigest(calibrationFile);
  if (plan.calibration_digest !== calibrationDigest) {
    throw new Error(
      `plan was written against calibration ${String(plan.calibration_digest).slice(0, 8)}; ${calibrationFile} digests to ${calibrationDigest.slice(0, 8)}`,
    );
  }
  // A full run takes hours, and under `--skill-ref` the spec is the live
  // checkout. A scorer module or judge prompt edited between planning and
  // scoring would score these cells with new code while the row keeps the
  // planned `comparability_key`, pairing it against rows produced by a
  // different pipeline. The key is recomputed rather than only compared field
  // by field, so the judge model and the frozen prompt hashes are covered too.
  const matcherDigest = scorerDigest();
  if (plan.matcher_digest !== matcherDigest) {
    throw new Error(
      `plan was written against scorer ${String(plan.matcher_digest).slice(0, 8)}; this scorer digests to ${matcherDigest.slice(0, 8)}; re-plan before scoring`,
    );
  }
  const key = comparabilityKey({
    contract: context.contract,
    contractDigest: context.contractDigest,
    matcherDigest,
    calibrationDigest,
  });
  if (plan.comparability_key !== key) {
    throw new Error(
      `plan carries comparability_key ${String(plan.comparability_key).slice(0, 8)}; this spec derives ${key.slice(0, 8)}; re-plan before scoring`,
    );
  }
  const rows = readLedger(path.resolve(context.repoRoot, options.ledgerPath));
  const scored = await scorePlan({
    plan,
    contract: context.contract,
    contractDigest: context.contractDigest,
    repoRoot: context.repoRoot,
    planDir,
    exec: claudeExec,
    calibrationSet: readJson(
      path.resolve(context.repoRoot, options.calibrationPath),
    ),
    ledgerRows: rows,
    baselineRow: resolveRowReference({
      reference: options.against,
      rows,
      repoRoot: context.repoRoot,
    }),
  });
  printObject(
    {
      row_path: path.join(planDir, "row.json"),
      verdict: scored.row.verdict,
      status: scored.row.status,
      missing: scored.missing,
      judge_calibration: scored.row.judge_calibration,
      reasons: scored.reasons,
    },
    options.json,
  );
}

async function modeValidate(options, context) {
  const rowPath = path.resolve(options.resultPath);
  const row = readJson(rowPath);
  const ledgerPath = path.resolve(context.repoRoot, options.ledgerPath);
  const ledgerRows = readLedger(ledgerPath);
  const calibrationFile = path.resolve(
    context.repoRoot,
    options.calibrationPath,
  );
  // An automatic row is scored at the next ledger position. Before append it
  // is still an external object, so timestamp fallback can wrongly exclude an
  // established anchor whose clock is later. Give validation the same pending
  // append position that scorePlan used.
  const validationLedgerRows = options.append
    ? [...ledgerRows, row]
    : ledgerRows;
  const revalidated = revalidateRow({
    contract: context.contract,
    row,
    repoRoot: context.repoRoot,
    // The run detail may sit outside `--root`: the orchestrator reads the
    // contract from a spec worktree while the cells live in the real checkout.
    detailDir: options.detailDir ? path.resolve(options.detailDir) : null,
    ledgerRows: validationLedgerRows,
    // Name the same baseline `--score --against` used, or the row's own
    // verdict is rechecked against a baseline it was never scored on.
    baselineRow: resolveRowReference({
      reference: options.against,
      rows: ledgerRows,
      repoRoot: context.repoRoot,
    }),
    // The frozen pairs the recorded calibration outcomes must be about, so a
    // detail file cannot relabel what the judge was expected to answer. A row
    // validated outside a checkout that carries the set still has its recorded
    // agreement re-derived from the outcomes themselves.
    calibrationSet: existsSync(calibrationFile)
      ? readJson(calibrationFile)
      : null,
  });
  const problems = [...revalidated.problems];
  if (row.contract_digest !== context.contractDigest) {
    problems.push(
      `row contract_digest ${row.contract_digest?.slice(0, 8)} is not the current contract`,
    );
  }
  // `revalidateRow` recomputes the conditions the row lists, and over the ids
  // each one lists. What it cannot see is what is not there. A condition that
  // is absent: a `kind: "full"`, `status: "complete"` row with `control`
  // deleted claims a whole matrix on a subset, and appending it would refresh
  // the full-run clock and make it an automatic baseline. And a defect that is
  // absent: a condition that kept one frozen id per PR passes the matrix check,
  // which only asks whether some id from each required PR is present, while its
  // recall and McNemar denominators have quietly shrunk. `--check-ledger`
  // applies both to the committed ledger; append must apply both before the row
  // gets in, or the committed ledger is where the fault is first reported.
  // The schema check runs here rather than only inside `appendRow`. Without
  // it a `--validate FILE` with no `--append` reports `ok: true` for a row
  // missing required `inputs` fields or carrying an out-of-schema kind, status
  // or verdict — the mode whose whole job is to say whether the row is sound,
  // answering yes about a row the ledger would refuse.
  problems.push(
    ...validateLedgerRow(row, "row"),
    ...frozenDefectProblems({ contract: context.contract, row, label: "row" }),
    ...completeMatrixProblems({
      contract: context.contract,
      row,
      label: "row",
    }),
  );
  let appended = false;
  if (problems.length === 0 && options.append) {
    appendRow(ledgerPath, row);
    appended = true;
  }
  printObject(
    {
      ok: problems.length === 0,
      row: rowPath,
      verdict: row.verdict,
      recomputed_verdict: revalidated.verdict,
      detail_dir: revalidated.detail_dir,
      appended,
      problems,
    },
    options.json,
  );
  if (problems.length > 0) process.exitCode = 1;
}

async function modeReport(options, context) {
  const rows = readLedger(path.resolve(context.repoRoot, options.ledgerPath));
  // The ledger is append-only, so a fixture or model contract refresh leaves
  // the rows it scored in place as history. Their bits were produced against a
  // different truth index and different verdict thresholds, so reporting one
  // under this contract recomputes a verdict the run never had and prints it
  // as current. The default selection takes the newest row of this contract,
  // and a row named explicitly must be one too — report an older row by
  // passing the contract it was scored against with `--contract`.
  const named = resolveRowReference({
    reference: options.rowPath,
    rows,
    repoRoot: context.repoRoot,
  });
  if (named && named.contract_digest !== context.contractDigest) {
    throw new Error(
      `the named row was scored against contract ${String(named.contract_digest).slice(0, 8)}; this contract is ${context.contractDigest.slice(0, 8)}; pass --contract with the archived contract to report it`,
    );
  }
  const row =
    named ??
    rows
      .filter((entry) => entry.contract_digest === context.contractDigest)
      .at(-1);
  if (!row) {
    throw new Error(
      `the ledger has no row for contract ${context.contractDigest.slice(0, 8)} to report`,
    );
  }
  const explicitBaseline = resolveRowReference({
    reference: options.against,
    rows,
    repoRoot: context.repoRoot,
  });
  const baselineRow = explicitBaseline ?? resolveBaseline({ rows, row });
  const baselineIsExplicit = explicitBaseline !== null;
  const markdown = renderReport({
    contract: context.contract,
    row,
    baselineRow,
    baselineIsExplicit,
    repoRoot: context.repoRoot,
  });
  const decision = verdict({
    contract: context.contract,
    row,
    baselineRow,
    baselineIsExplicit,
  });
  if (options.json) {
    printObject(
      {
        verdict: decision.verdict,
        reasons: decision.reasons,
        executed_at: row.executed_at,
        baseline_executed_at: baselineRow?.executed_at ?? null,
        markdown,
      },
      true,
    );
    return;
  }
  process.stdout.write(markdown);
}

async function modeScheduleIssue(options, context) {
  const result = await runScheduleIssue(options, context);
  printObject(result, options.json);
  summarize(`review-skill eval freshness: ${result.level} — ${result.reason}`);
  if (result.level === "red") process.exitCode = 1;
}

const MODE_HANDLERS = {
  "check-fixtures": modeCheckFixtures,
  "check-ledger": modeCheckLedger,
  plan: modePlan,
  score: modeScore,
  validate: modeValidate,
  report: modeReport,
  "schedule-issue": modeScheduleIssue,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const context = loadContext(options);
  await MODE_HANDLERS[options.mode](options, context);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`review-eval: ${message}\n`);
    process.exitCode = 1;
  });
}
