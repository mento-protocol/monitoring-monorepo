#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  assertAuthorizedGardenWorkflow,
  ensureLabelsExist,
  ghPaginate,
  runGh,
} from "./docs-garden-issue.mjs";
import {
  buildNavigationEvalIssueSpec,
  buildNavigationPrompt,
  fixtureDigest,
  monthForDate,
  navigationContextFloor,
  normalizeNavigationEvalIssuePages,
  planNavigationEvalIssueSync,
  routingSensitiveChanges,
  scoreNavigationResult,
  validateFixtureSuite,
} from "./docs-navigation-eval-helpers.mjs";
import {
  buildDocumentationInventory,
  trackedDocumentationFiles,
} from "./docs-index-helpers.mjs";

export const DEFAULT_NAVIGATION_EVAL_REPO =
  "mento-protocol/monitoring-monorepo";
export const DEFAULT_FIXTURES =
  "docs/evals/documentation-navigation-fixtures.json";
export const DEFAULT_BASELINE =
  "docs/evals/documentation-navigation-baseline.json";

function parseBoolean(value, name) {
  if (value == null || String(value).trim() === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1"].includes(normalized)) return true;
  if (["false", "0"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

export function parseArgs(argv, env = process.env) {
  const options = {
    mode: null,
    repo:
      env.DOCS_NAVIGATION_EVAL_REPO ||
      env.GITHUB_REPOSITORY ||
      DEFAULT_NAVIGATION_EVAL_REPO,
    repoRoot: process.cwd(),
    fixturesPath: DEFAULT_FIXTURES,
    baselinePath: DEFAULT_BASELINE,
    resultPath: null,
    questionId: null,
    date: new Date().toISOString().slice(0, 10),
    dryRun: parseBoolean(
      env.DOCS_NAVIGATION_EVAL_DRY_RUN,
      "DOCS_NAVIGATION_EVAL_DRY_RUN",
    ),
    json: false,
    help: false,
  };
  const setMode = (mode) => {
    if (options.mode && options.mode !== mode) {
      throw new Error(
        `choose exactly one mode; already selected --${options.mode}`,
      );
    }
    options.mode = mode;
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--") continue;
    if (arg === "--check-fixtures") setMode("check-fixtures");
    else if (arg === "--prompt") setMode("prompt");
    else if (arg === "--validate") {
      setMode("validate");
      options.resultPath = readValue();
    } else if (arg === "--schedule-issue") setMode("schedule-issue");
    else if (arg === "--question") options.questionId = readValue();
    else if (arg === "--repo") options.repo = readValue();
    else if (arg === "--root") options.repoRoot = readValue();
    else if (arg === "--fixtures") options.fixturesPath = readValue();
    else if (arg === "--baseline") options.baselinePath = readValue();
    else if (arg === "--date") options.date = readValue();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.help && !options.mode) {
    throw new Error(
      "choose one of --check-fixtures, --prompt, --validate, or --schedule-issue",
    );
  }
  if (options.questionId && !["prompt", "validate"].includes(options.mode)) {
    throw new Error("--question is valid only with --prompt or --validate");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) {
    throw new Error("--repo must be an owner/repository slug");
  }
  monthForDate(options.date);
  return options;
}

function usage() {
  return `Usage: node scripts/docs-navigation-eval.mjs MODE [options]

Generate and validate the read-only fresh-agent documentation navigation
evaluation, or synchronize its monthly claimable issue. No mode invokes a
model. Live issue creation is restricted to the serialized Documentation
Garden GitHub Actions workflow.

Modes:
  --check-fixtures       Validate the 15-20 question routing fixture suite
  --prompt               Print the bounded fresh-agent prompt
  --validate FILE        Validate and score one structured result
  --schedule-issue       Create or retain the monthly evaluation issue

Options:
  --question ID          Generate or validate one failed/contested question
  --repo OWNER/REPO      GitHub repository for issue scheduling
  --root PATH            Repository root (default: current directory)
  --fixtures PATH        Fixture JSON path relative to the repository root
  --baseline PATH        Baseline result used for routing-change reminders
  --date YYYY-MM-DD      Evaluation/scheduler date (default: today UTC)
  --dry-run              Read and plan issue synchronization without mutation
  --json                 Print machine-readable check/schedule output
  -h, --help             Show this help
`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

export function assertPassingNavigationResult({
  suite,
  result,
  repoRoot,
  label = "navigation evaluation result",
}) {
  const scored = scoreNavigationResult({ suite, result, repoRoot });
  if (scored.errors.length > 0 || !scored.report?.passed) {
    const details = [
      ...scored.errors,
      ...(!scored.report?.passed
        ? [`${label} misses one or more targets`]
        : []),
    ];
    throw new Error(`${label} is invalid:\n${details.join("\n")}`);
  }
  return scored.report;
}

export function assertCleanEvaluationCheckout(repoRoot, runner = execFileSync) {
  const status = runner("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (String(status).trim() !== "") {
    throw new Error(
      "prompt generation requires a clean checkout so repository_base_commit identifies the exact evaluated documentation",
    );
  }
}

export function loadEvaluationContext(options) {
  const repoRoot = realpathSync(path.resolve(options.repoRoot));
  const fixturesPath = path.resolve(repoRoot, options.fixturesPath);
  const suite = readJson(fixturesPath);
  const inventory = buildDocumentationInventory({
    repoRoot,
    files: trackedDocumentationFiles(repoRoot),
  });
  if (inventory.errors.length > 0) {
    throw new Error(
      `documentation inventory failed:\n${inventory.errors.join("\n")}`,
    );
  }
  const fixtureErrors = validateFixtureSuite(suite, inventory);
  if (fixtureErrors.length > 0) {
    throw new Error(
      `navigation fixtures are invalid:\n${fixtureErrors.join("\n")}`,
    );
  }
  return { repoRoot, suite, inventory };
}

async function defaultListIssues(options) {
  const pages = await ghPaginate(`repos/${options.repo}/issues?state=all`);
  return normalizeNavigationEvalIssuePages(pages);
}

async function defaultCreateIssue(options, spec) {
  return runGh([
    "issue",
    "create",
    "--repo",
    options.repo,
    "--title",
    spec.title,
    "--body",
    spec.body,
    "--label",
    spec.labels.join(","),
  ]);
}

export async function runNavigationEvalIssue(
  options,
  { suite, repoRoot },
  deps = {},
) {
  const {
    listIssues = defaultListIssues,
    authorizeLiveCreation = assertAuthorizedGardenWorkflow,
    ensureLabels = ensureLabelsExist,
    createIssue = defaultCreateIssue,
    changesSinceBaseline = routingSensitiveChanges,
    readBaseline = (file) => readJson(file),
    validateBaseline = (baseline) =>
      assertPassingNavigationResult({
        suite,
        result: baseline,
        repoRoot,
        label: "committed navigation baseline",
      }),
  } = deps;
  const month = monthForDate(options.date);
  const digest = fixtureDigest(suite);
  const baseline = readBaseline(path.resolve(repoRoot, options.baselinePath));
  const baselineReport = validateBaseline(baseline);
  const baselineCommit = baseline?.run?.repository_base_commit;
  const routingChanges = changesSinceBaseline(repoRoot, baselineCommit);
  const issues = await listIssues(options);
  const spec = buildNavigationEvalIssueSpec({
    month,
    fixtureDigest: digest,
    routingChanges,
  });
  const decision = planNavigationEvalIssueSync({
    month,
    fixtureDigest: digest,
    issues,
    spec,
  });
  const baselineExecutedAt = String(baseline?.run?.executed_at ?? "");
  if (
    decision.action === "create" &&
    baseline.fixture_digest === digest &&
    /^\d{4}-\d{2}/.test(baselineExecutedAt) &&
    baselineExecutedAt.slice(0, 7) === month
  ) {
    return {
      action: "skip-baseline-complete",
      reason: `${month} is already represented by the committed baseline`,
      issue_number: null,
      month,
      fixture_digest: digest,
      baseline_commit: baselineCommit,
      baseline_routing_accuracy_percent:
        baselineReport.routing_accuracy_percent ?? null,
      routing_change_count: routingChanges.length,
      routing_changes: routingChanges.slice(0, 40),
      dry_run: options.dryRun,
      mutated: false,
      mutation_result: null,
    };
  }
  let mutated = false;
  let mutationResult = null;
  if (decision.action === "create" && !options.dryRun) {
    await authorizeLiveCreation(options);
    await ensureLabels(options);
    mutationResult = await createIssue(options, decision.spec);
    mutated = true;
  }
  return {
    action: decision.action,
    reason: decision.reason,
    issue_number: decision.issue?.number ?? null,
    month,
    fixture_digest: digest,
    baseline_commit: baselineCommit,
    baseline_routing_accuracy_percent:
      baselineReport.routing_accuracy_percent ?? null,
    routing_change_count: routingChanges.length,
    routing_changes: routingChanges.slice(0, 40),
    dry_run: options.dryRun,
    mutated,
    mutation_result:
      typeof mutationResult === "string" ? mutationResult.trim() || null : null,
  };
}

function printObject(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const context = loadEvaluationContext(options);
  if (options.mode === "check-fixtures") {
    const contextFloor = navigationContextFloor(
      context.suite,
      context.inventory,
    );
    const result = {
      valid: true,
      suite_id: context.suite.suite_id,
      fixture_digest: fixtureDigest(context.suite),
      question_count: context.suite.questions.length,
      context_floor: {
        max_question_route_bytes: contextFloor.max_question_route_bytes,
        max_question_headroom_bytes:
          context.suite.targets.max_question_source_bytes -
          contextFloor.max_question_route_bytes,
        total_unique_route_bytes: contextFloor.total_unique_route_bytes,
        total_unique_headroom_bytes:
          context.suite.targets.max_total_unique_source_bytes -
          contextFloor.total_unique_route_bytes,
      },
    };
    printObject(result, options.json);
    return;
  }
  if (options.mode === "prompt") {
    assertCleanEvaluationCheckout(context.repoRoot);
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: context.repoRoot,
      encoding: "utf8",
    }).trim();
    process.stdout.write(
      buildNavigationPrompt(context.suite, {
        baseCommit,
        questionId: options.questionId,
      }),
    );
    return;
  }
  if (options.mode === "validate") {
    const result = readJson(path.resolve(options.resultPath));
    const scored = scoreNavigationResult({
      suite: context.suite,
      result,
      inventory: context.inventory,
      repoRoot: context.repoRoot,
      questionId: options.questionId,
    });
    printObject(scored, true);
    if (scored.errors.length > 0 || !scored.report?.passed)
      process.exitCode = 1;
    return;
  }
  const result = await runNavigationEvalIssue(options, context);
  printObject(result, options.json);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`docs-navigation-eval: ${message}\n`);
    process.exitCode = 1;
  });
}
