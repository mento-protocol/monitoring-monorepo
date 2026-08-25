#!/usr/bin/env node

// CLI for the review-skill evaluation. Every mode except `--score` is
// deterministic and safe in CI: no model, no credential, no mutation. `--score`
// is the only mode that spends model quota, and only the local orchestrator
// (`run-eval.sh`) invokes it.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
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
  loadContract,
} from "./review-eval-fixtures.mjs";
import {
  appendRow,
  checkLedger,
  freshness,
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
  DEFAULT_CALIBRATION_PATH,
  DEFAULT_LEDGER_PATH,
  DEFAULT_RUNS_DIR,
  planStalenessIssueSync,
  resolveKind,
  scorePlan,
} from "./review-eval-run.mjs";
import {
  resolveBaseline,
  resolveRowReference,
  revalidateRow,
} from "./review-eval-result-shape.mjs";

export const DEFAULT_REVIEW_EVAL_REPO = "mento-protocol/monitoring-monorepo";

const MODE_OPTIONS = {
  "check-fixtures": ["offline", "src-repo"],
  "check-ledger": ["base-ref", "require-base"],
  plan: ["kind", "skill-ref", "out", "runs-dir"],
  score: ["against", "calibration"],
  validate: ["append", "against"],
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
  kind: { type: "string" },
  "skill-ref": { type: "string" },
  out: { type: "string" },
  "runs-dir": { type: "string" },
  against: { type: "string" },
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
    kind: values.kind ?? null,
    skillRef: values["skill-ref"] ?? null,
    outDir: values.out ?? null,
    planDir: mode === "score" ? values.score : null,
    resultPath: mode === "validate" ? values.validate : null,
    against: values.against ?? null,
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
  --offline              Skip eval-tag reachability (--check-fixtures)
  --src-repo PATH        Resolve eval tags from a local clone
  --base-ref REF         Append-only comparison base (default: origin/main)
  --require-base         Fail when the base ref does not resolve (--check-ledger)
  --kind full|canary|auto  Run matrix to plan (default: auto, read from ledger)
  --skill-ref PATH       Evaluate a candidate skill directory; stamps dirty
  --out DIR              Plan directory (default: the run's detail directory)
  --runs-dir PATH        Detail root (default: ${DEFAULT_RUNS_DIR})
  --against REF          Baseline row: a file path or an executed_at prefix
                         (--score, --report, and --validate)
  --row REF              Row to report (default: the newest ledger row)
  --calibration PATH     Judge calibration set (--score)
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
    srcRepo: options.srcRepo
      ? path.resolve(options.srcRepo)
      : options.offline
        ? null
        : context.repoRoot,
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
      problems: result.problems,
    },
    options.json,
  );
  if (!result.ok) process.exitCode = 1;
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
  const revalidated = revalidateRow({
    contract: context.contract,
    row,
    repoRoot: context.repoRoot,
    ledgerRows,
    // Name the same baseline `--score --against` used, or the row's own
    // verdict is rechecked against a baseline it was never scored on.
    baselineRow: resolveRowReference({
      reference: options.against,
      rows: ledgerRows,
      repoRoot: context.repoRoot,
    }),
  });
  const problems = [...revalidated.problems];
  if (row.contract_digest !== context.contractDigest) {
    problems.push(
      `row contract_digest ${row.contract_digest?.slice(0, 8)} is not the current contract`,
    );
  }
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
  const row =
    resolveRowReference({
      reference: options.rowPath,
      rows,
      repoRoot: context.repoRoot,
    }) ?? rows.at(-1);
  if (!row) throw new Error("the ledger has no row to report");
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
