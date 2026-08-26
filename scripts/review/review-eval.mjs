#!/usr/bin/env node

// CLI for the review-skill evaluation. Every mode except `--score` is
// deterministic and safe in CI: no model, no credential, no mutation. `--score`
// is the only mode that spends model quota, and only the local orchestrator
// (`run-eval.sh`) invokes it.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
  freshness,
  frozenDefectProblems,
  fullMatrixProblems,
  readLedger,
} from "./review-eval-ledger.mjs";
import {
  parseLeadingReviewEvalMarkers,
  renderReport,
  REVIEW_EVAL_OWNERSHIP_LABEL,
  scheduleIssuePayload,
  verdict,
} from "./review-eval-report.mjs";
import {
  assertAuthorizedFreshnessWorkflow,
  buildPlan,
  claudeExec,
  comparabilityKey,
  DEFAULT_CALIBRATION_PATH,
  DEFAULT_LEDGER_PATH,
  DEFAULT_RUNS_DIR,
  fileDigest,
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
  plan: ["kind", "skill-ref", "out", "runs-dir"],
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
                         (--score, --report, and --validate)
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
    now = new Date(`${options.date}T00:00:00Z`),
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
  // Which rows are new is the base comparison's answer. Without it this flag
  // would either recompute the whole history — including rows of retired
  // contracts it cannot judge — or check nothing, and a guard that silently
  // no-ops is worse than no guard.
  if (!base.rows) {
    result.problems.push(
      `--revalidate-appended cannot tell which rows are new: ${base.reason}`,
    );
    return { ok: false, checked: null, unpaired: null };
  }
  const appended = rows.slice(base.rows.length);
  const calibrationFile = path.resolve(
    context.repoRoot,
    options.calibrationPath,
  );
  const calibrationSet = existsSync(calibrationFile)
    ? readJson(calibrationFile)
    : null;
  let unpaired = 0;
  for (const row of appended) {
    const label = `appended row ${row.executed_at}`;
    if (!row.detail_dir) {
      problems.push(`${label} carries no detail_dir to recompute from`);
      continue;
    }
    const dir = path.resolve(context.repoRoot, row.detail_dir);
    if (!existsSync(dir)) {
      problems.push(
        `${label} names detail_dir ${row.detail_dir}, which this branch does not commit`,
      );
      continue;
    }
    // The recorded pairing is rechecked against the row it actually names, not
    // against whatever anchor this ledger would resolve on its own — those are
    // two different pairs of runs, and comparing the wrong one reports
    // differences that are not errors. A candidate row scored against an
    // installed row whose own ledger PR has not merged yet names a row this
    // branch does not carry; that pairing cannot be rechecked here, so the row
    // is recomputed against its own bits and detail alone and counted as
    // unpaired rather than failed.
    const recordedAt = row.vs_baseline?.baseline_executed_at ?? null;
    const baselineRow =
      recordedAt === null
        ? null
        : (rows.find((candidate) => candidate.executed_at === recordedAt) ??
          null);
    if (recordedAt !== null && baselineRow === null) unpaired += 1;
    const check = revalidateRow({
      contract: context.contract,
      row,
      repoRoot: context.repoRoot,
      detailDir: dir,
      ledgerRows: recordedAt !== null && baselineRow === null ? [] : rows,
      baselineRow,
      calibrationSet,
    });
    problems.push(...check.problems.map((problem) => `${label}: ${problem}`));
  }
  result.problems.push(...problems);
  return { ok: problems.length === 0, checked: appended.length, unpaired };
}

async function modePlan(options, context) {
  const rows = readLedger(path.resolve(context.repoRoot, options.ledgerPath));
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
  const revalidated = revalidateRow({
    contract: context.contract,
    row,
    repoRoot: context.repoRoot,
    // The run detail may sit outside `--root`: the orchestrator reads the
    // contract from a spec worktree while the cells live in the real checkout.
    detailDir: options.detailDir ? path.resolve(options.detailDir) : null,
    ledgerRows,
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
  problems.push(
    ...frozenDefectProblems({ contract: context.contract, row, label: "row" }),
    ...fullMatrixProblems({ contract: context.contract, row, label: "row" }),
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
  const baselineRow =
    resolveRowReference({
      reference: options.against,
      rows,
      repoRoot: context.repoRoot,
    }) ?? resolveBaseline({ rows, row });
  const markdown = renderReport({
    contract: context.contract,
    row,
    baselineRow,
    repoRoot: context.repoRoot,
  });
  const decision = verdict({ contract: context.contract, row, baselineRow });
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
