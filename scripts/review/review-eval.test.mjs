#!/usr/bin/env node

// CLI-level suite for the review-skill evaluation. Every case runs offline:
// no model, no network, no `gh`. `scorePlan` is exercised with a stubbed exec
// so the judge path is covered without spending a cent.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  forbiddenShasForFixture,
  loadContract,
} from "./review-eval-fixtures.mjs";
import {
  baselinePreflightProblems,
  readLedger,
  validateLedgerRow,
} from "./review-eval-ledger.mjs";
import {
  baseLedgerRows,
  parseArgs,
  planProvenanceProblems,
  runScheduleIssue,
} from "./review-eval.mjs";
import { baselineEligibility, verdict } from "./review-eval-report.mjs";
import {
  assertAuthorizedFreshnessWorkflow,
  baselinePlanIdentity,
  buildPlan,
  cellFingerprint,
  cellReuseDecision,
  claudeArgv,
  comparabilityKey,
  leakSignals,
  loginsInFixtureTree,
  ORCHESTRATOR_FILES,
  orchestratorSourceDigest,
  planCells,
  planStalenessIssueSync,
  resolveDetailDir,
  resolveKind,
  scorePlan,
  skillDigest,
  SCRUBBED_ENV_VARS,
  scrubbedEnv,
  treatmentIdentity,
} from "./review-eval-run.mjs";
import {
  buildVsBaseline,
  failedRow,
  resolveBaseline,
  revalidateRow,
} from "./review-eval-result-shape.mjs";
import {
  BLIND_JUDGE_MAX_TURNS,
  BLIND_JUDGE_TOOLS,
  scorerDigest,
} from "./review-eval-score.mjs";
import { runEvidenceProblems } from "./review-eval-run-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = fileURLToPath(new URL("./review-eval.mjs", import.meta.url));
const validationModuleLineLimits = new Map([
  ["review-eval.mjs", 900],
  ["review-eval-run.mjs", 100],
  ["review-eval-run-plan.mjs", 600],
  ["review-eval-run-execution.mjs", 600],
  ["review-eval-run-cell.mjs", 600],
  ["review-eval-run-score.mjs", 600],
  ["review-eval-plan-evidence.mjs", 600],
  ["review-eval-run-evidence.mjs", 600],
  ["review-eval-appended.mjs", 600],
]);
const contractRelative = "docs/evals/review-skill-fixtures.json";
const ledgerRelative = "docs/evals/review-skill-ledger.jsonl";
const { contract, digest: contractDigest } = loadContract(
  path.join(repoRoot, contractRelative),
);
const planEnv = {
  REVIEW_EVAL_CLAUDE_CLI: "2.1.14",
  REVIEW_EVAL_CODEX_CLI: "0.48.2",
  REVIEW_EVAL_HOST: "test-host",
  REVIEW_EVAL_SKILL_DIR: path.join(repoRoot, "scripts/review/prompts"),
};

const runEvalSourcePaths = new Map([
  ["wrapper", path.join(repoRoot, "scripts/review/run-eval.sh")],
  ["lifecycle", path.join(repoRoot, "scripts/review/run-eval-lifecycle.sh")],
  ["runtime", path.join(repoRoot, "scripts/review/run-eval-runtime.sh")],
]);

function runEvalSource(owner) {
  const sourcePath = runEvalSourcePaths.get(owner);
  assert.ok(sourcePath, `unknown run-eval source owner: ${owner}`);
  return readFileSync(sourcePath, "utf8");
}

function runEvalSourceSet() {
  return [...runEvalSourcePaths]
    .map(([owner]) => `# source-owner: ${owner}\n${runEvalSource(owner)}`)
    .join("\n");
}

function assertBefore(source, earlier, later, message) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.notEqual(
    earlierIndex,
    -1,
    `missing earlier marker ${JSON.stringify(earlier)}`,
  );
  assert.notEqual(
    laterIndex,
    -1,
    `missing later marker ${JSON.stringify(later)}`,
  );
  assert.ok(earlierIndex < laterIndex, message);
}

function sourceIndexes(source, needle) {
  const indexes = [];
  let offset = 0;
  for (;;) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return indexes;
    indexes.push(index);
    offset = index + needle.length;
  }
}

function reconstructLegacyOrchestrator() {
  let wrapper = runEvalSource("wrapper");
  const helpers = `${runEvalSource("lifecycle")}\n${runEvalSource("runtime")}`;
  for (const id of [
    "lifecycle-setup",
    "lifecycle-verify",
    "lifecycle-support",
    "cell-runtime",
  ]) {
    const payload = helpers.match(
      new RegExp(
        `# RUN-EVAL-ORIGINAL-BEGIN ${id}\\n([\\s\\S]*?)# RUN-EVAL-ORIGINAL-END ${id}\\n`,
      ),
    )?.[1];
    assert.notEqual(payload, undefined, `missing original payload ${id}`);
    const block = new RegExp(
      `# RUN-EVAL-EXTRACT-BEGIN ${id}\\n[\\s\\S]*?# RUN-EVAL-EXTRACT-END ${id}\\n`,
    );
    assert.match(wrapper, block);
    wrapper = wrapper.replace(block, () => payload);
  }
  return wrapper;
}

test("run-eval shell sources retain split headroom", () => {
  for (const owner of runEvalSourcePaths.keys()) {
    const source = runEvalSource(owner);
    const lines = source.endsWith("\n")
      ? source.slice(0, -1).split("\n").length
      : source.split("\n").length;
    assert.ok(lines < 600, `${owner} run-eval source has ${lines} lines`);
  }
});

test("the shell split reconstructs the cached-cell orchestrator bytes", () => {
  assert.equal(
    createHash("sha256").update(reconstructLegacyOrchestrator()).digest("hex"),
    "5cdfbd0e709af2d68c193d484b724706b339ab0562d14b283f5fc38eebe9ae49",
  );
});

test("review-eval validation modules retain split headroom", () => {
  for (const [name, limit] of validationModuleLineLimits) {
    const source = readFileSync(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      "utf8",
    );
    const lines = source.endsWith("\n")
      ? source.slice(0, -1).split("\n").length
      : source.split("\n").length;
    assert.ok(lines < limit, `${name} has ${lines} lines; limit is ${limit}`);
  }
});

/** A temporary repository root holding only what the CLI reads. */
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "review-eval-cli-"));
  mkdirSync(path.join(root, "docs/evals"), { recursive: true });
  mkdirSync(path.join(root, "scripts/review"), { recursive: true });
  for (const entry of [
    contractRelative,
    "docs/evals/review-skill-truth",
    "docs/evals/review-skill-finder-reports",
    "docs/evals/review-skill-judge-calibration.json",
    "scripts/review/prompts",
  ]) {
    cpSync(path.join(repoRoot, entry), path.join(root, entry), {
      recursive: true,
    });
  }
  writeFileSync(path.join(root, ledgerRelative), "");
  return root;
}

function cli(args, { root, env = {} } = {}) {
  return spawnSync(
    process.execPath,
    [scriptPath, ...(root ? ["--root", root] : []), ...args],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function scorableIdsFor(prs) {
  return contract.fixtures
    .filter((fixture) => prs.includes(fixture.pr))
    .flatMap((fixture) => fixture.scorable_ids.map(String));
}

function p1IdsFor(prs) {
  return contract.fixtures
    .filter((fixture) => prs.includes(fixture.pr))
    .flatMap((fixture) => fixture.p1_ids.map(String));
}

/**
 * A schema-valid row whose numbers agree with its own bits. `verdict` defaults
 * to the verdict those numbers actually give, because a row is only evidence
 * while every field on it agrees with every other.
 */
function makeRow({
  executedAt = "2026-09-08T10:41:07Z",
  kind = "full",
  status = "complete",
  matchedIds = [],
  key = comparabilityKey({ contract, contractDigest }),
  verdict: statedVerdict = null,
  // The rest of the matrix a complete full run owes: replay over the grid
  // fixtures and control over every fixture, on the same bits as the pipeline.
  // Off by default, because most tests here are about one condition's numbers.
  fullMatrix = false,
} = {}) {
  const prs = contract.fixtures.map((fixture) => fixture.pr);
  const gridPrs = contract.fixtures
    .filter((fixture) => fixture.grid === true)
    .map((fixture) => fixture.pr);
  const ids = scorableIdsFor(prs);
  const p1 = new Set(p1IdsFor(prs));
  const matched = new Set(matchedIds.map(String));
  // The draws each condition plans, which a complete row of this kind must
  // carry: pipeline samples the finder twice, replay replays both frozen
  // reports, control runs once. A draw repeats the same bit here — these rows
  // are about the counters, not about between-draw variance.
  const bitsFor = (id, draws) =>
    Array.from({ length: draws }, () => (matched.has(id) ? 1 : 0));
  const pipelineDraws = kind === "canary" ? 1 : 2;
  const perDefect = Object.fromEntries(
    ids.map((id) => [id, bitsFor(id, pipelineDraws)]),
  );
  const count = (subset, draws = pipelineDraws) => {
    const hit = subset.filter((id) => matched.has(id)).length * draws;
    const opportunities = subset.length * draws;
    return {
      matched: hit,
      opportunities,
      rate:
        opportunities === 0 ? null : Number((hit / opportunities).toFixed(3)),
    };
  };
  const conditionOver = (subset, draws, withFinder = true) => ({
    model: "claude-opus-5",
    effort: "high",
    ...(withFinder ? { finder: "gpt-5.6-sol@high" } : {}),
    draws,
    recall: count(subset, draws),
    p1: count(
      subset.filter((id) => p1.has(id)),
      draws,
    ),
    novel_real: 1,
    wrong_claims: 0,
    usd: 4.2,
    seconds: 600,
    per_defect: Object.fromEntries(
      subset.map((id) => [id, bitsFor(id, draws)]),
    ),
  });
  const built = {
    schema_version: 1,
    kind,
    executed_at: executedAt,
    status,
    verdict: "INCOMPLETE",
    comparability_key: key,
    contract_digest: contractDigest,
    inputs: {
      skill_digest: "a".repeat(64),
      skill_ref: "installed",
      finder_argv_digest: "b".repeat(64),
      orchestrator_digest: "c".repeat(64),
      claude_cli: "2.1.14",
      codex_cli: "0.48.2",
      host: "test-host",
    },
    conditions: {
      pipeline: {
        model: "claude-opus-5",
        effort: "high",
        finder: "gpt-5.6-sol@high",
        draws: pipelineDraws,
        recall: count(ids),
        p1: count(ids.filter((id) => p1.has(id))),
        novel_real: 1,
        wrong_claims: 0,
        usd: 4.2,
        seconds: 600,
        per_defect: perDefect,
      },
    },
    judge_calibration: { agreement: 40, total: 40 },
    scoring_usd: 0,
    vs_baseline: null,
    detail_dir: "docs/evals/review-skill-runs/2026-09-08-deadbeef",
    notes: "",
  };
  if (fullMatrix) {
    built.conditions.replay = conditionOver(scorableIdsFor(gridPrs), 2);
    built.conditions.control = conditionOver(ids, 1, false);
  }
  built.verdict = statedVerdict ?? verdict({ contract, row: built }).verdict;
  return built;
}

/** Write the plan, scored cells, and calibration evidence for one test row. */
function writeRowEvidence(root, row) {
  const detail = path.join(root, row.detail_dir);
  mkdirSync(detail, { recursive: true });
  const cells = planCells({ contract, kind: row.kind });
  const plan = {
    contract_digest: row.contract_digest,
    comparability_key: row.comparability_key,
    kind: row.kind,
    detail_dir: row.detail_dir,
    baseline_selection: row.vs_baseline?.selection ?? "automatic",
    baseline:
      row.vs_baseline?.selection === "explicit"
        ? {
            executed_at: row.vs_baseline.baseline_executed_at,
            contract_digest: row.contract_digest,
            comparability_key: row.vs_baseline.baseline_comparability_key,
            detail_dir: "external-baseline",
            row_digest: "0".repeat(64),
          }
        : null,
    inputs: row.inputs,
    cells,
  };
  const fingerprint = cellFingerprint({ plan });
  const treatment = treatmentIdentity({ plan });
  const completedCellIds = [];
  for (const [name, condition] of Object.entries(row.conditions)) {
    const idsByPr = new Map();
    for (const id of Object.keys(condition.per_defect)) {
      const fixture = contract.fixtures.find((candidate) =>
        candidate.scorable_ids.map(String).includes(id),
      );
      if (!fixture) continue;
      idsByPr.set(fixture.pr, [...(idsByPr.get(fixture.pr) ?? []), id]);
    }
    let first = true;
    for (let draw = 1; draw <= condition.draws; draw += 1) {
      for (const [pr, ids] of idsByPr) {
        const matchedIds = ids.filter(
          (id) => condition.per_defect[id][draw - 1] === 1,
        );
        const novelWrong = first ? condition.wrong_claims : 0;
        const novelReal = first ? condition.novel_real : 0;
        const claimCount = Math.max(1, novelWrong + novelReal);
        const claims = Array.from(
          { length: claimCount },
          (_unused, index) => `claim ${index + 1}`,
        );
        const classes = [
          ...Array(novelWrong).fill("wrong"),
          ...Array(novelReal).fill("real"),
          ...Array(claimCount - novelWrong - novelReal).fill("vague"),
        ];
        writeFileSync(
          path.join(detail, `result-${pr}-${name}-${draw}.json`),
          JSON.stringify({
            cell_id: `pr-${pr}-${name}-draw${draw}`,
            fingerprint,
            treatment,
            pr,
            condition: name,
            draw,
            matched_ids: matchedIds,
            claims,
            novel: {
              claims: claimCount,
              novelWrong,
              novelReal,
              novelVague: claimCount - novelWrong - novelReal,
              restatedKnown: 0,
              alreadyMatched: matchedIds.length,
              verdicts: Object.fromEntries(
                classes.map((className, index) => [
                  String(index + 1),
                  { class: className },
                ]),
              ),
            },
            usd: first ? condition.usd : 0,
            seconds: first ? condition.seconds : 0,
            scoring_usd: 0,
            leak: { suspected: false, hard: [] },
          }),
        );
        completedCellIds.push(`pr-${pr}-${name}-draw${draw}`);
        first = false;
      }
    }
  }
  writeFileSync(path.join(detail, "plan.json"), JSON.stringify(plan));
  const calibration = JSON.parse(
    readFileSync(
      path.join(root, "docs/evals/review-skill-judge-calibration.json"),
      "utf8",
    ),
  );
  writeFileSync(
    path.join(detail, "calibration.json"),
    JSON.stringify({
      fingerprint,
      treatment,
      completed_cell_ids: completedCellIds,
      outcomes: calibration.records.map((record) => ({
        record_id: record.record_id,
        expected: record.expected_verdict,
        actual: record.expected_verdict,
      })),
      scoring_usd: 0,
    }),
  );
  return detail;
}

test("parseArgs selects exactly one mode and rejects the rest", () => {
  assert.equal(parseArgs(["--check-fixtures"]).mode, "check-fixtures");
  assert.equal(parseArgs(["--score", "/tmp/plan"]).planDir, "/tmp/plan");
  assert.throws(() => parseArgs([]), /choose one of/);
  assert.throws(
    () => parseArgs(["--check-fixtures", "--check-ledger"]),
    /exactly one mode/,
  );
  assert.throws(() => parseArgs(["--nope"]), /--nope/);
  assert.throws(() => parseArgs(["--score", ""]), /requires a value/);
  assert.throws(
    () => parseArgs(["--validate", "/tmp/row", "--detail-dir", ""]),
    /--detail-dir requires a value/,
  );
});

test("parseArgs refuses an option that belongs to another mode", () => {
  assert.throws(
    () => parseArgs(["--check-ledger", "--offline"]),
    /--offline is not valid with --check-ledger/,
  );
  assert.throws(
    () => parseArgs(["--plan", "--kind", "weekly"]),
    /--kind must be full, canary, or auto/,
  );
  assert.throws(
    () => parseArgs(["--schedule-issue", "--repo", "nope"]),
    /owner\/repository/,
  );
  assert.throws(
    () => parseArgs(["--schedule-issue", "--date", "2026-9-1"]),
    /YYYY-MM-DD/,
  );
});

test("parseArgs defaults --kind to auto and tolerates the pnpm separator", () => {
  const options = parseArgs(["--", "--plan"]);
  assert.equal(options.mode, "plan");
  assert.equal(options.kind, "auto");
  assert.equal(options.contractPath, contractRelative);
  assert.equal(options.ledgerPath, ledgerRelative);
});

test("--help prints usage and exits zero", () => {
  const result = cli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Only\n--score invokes a model/);
});

test("--check-fixtures --offline passes on the committed contract", () => {
  const result = cli(["--check-fixtures", "--offline", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.contract_digest, contractDigest);
  assert.deepEqual(
    [output.prs, output.scorable, output.p1, output.grid],
    [6, 34, 12, 3],
  );
});

test("--check-fixtures online proves the tags against the remote", () => {
  const shim = mkdtempSync(path.join(tmpdir(), "review-eval-git-"));
  try {
    const log = path.join(shim, "calls.log");
    // A `git` that answers `ls-remote` from the contract and refuses every
    // other subcommand. Online mode that quietly resolved the tags in this
    // checkout would therefore fail here, which is the point: a local tag
    // still pointing at the pinned commit says nothing about the remote.
    writeFileSync(
      path.join(shim, "git"),
      `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[0] !== "ls-remote") process.exit(1);
const contract = JSON.parse(readFileSync(${JSON.stringify(path.join(repoRoot, contractRelative))}, "utf8"));
const ref = String(args[2] || "").replace(/^refs\\/tags\\//, "");
for (const fixture of contract.fixtures) {
  const sha =
    fixture.tag_head === ref
      ? fixture.first_head
      : fixture.tag_base === ref
        ? fixture.base_sha
        : null;
  if (sha) {
    process.stdout.write(sha + "\\trefs/tags/" + ref + "^{}\\n");
    process.exit(0);
  }
}
process.exit(1);
`,
      { mode: 0o755 },
    );
    const result = cli(["--check-fixtures", "--json"], {
      env: { PATH: `${shim}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, JSON.stringify(output.problems));
    assert.equal(output.offline, false);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, contract.fixtures.length * 2);
    assert.ok(
      calls.every((call) => call.startsWith("ls-remote https://github.com/")),
      calls.join(" | "),
    );
  } finally {
    rmSync(shim, { recursive: true, force: true });
  }
});

test("--check-fixtures fails on a tampered truth file", () => {
  const root = makeRoot();
  try {
    const truth = path.join(root, contract.fixtures[0].truth_file);
    writeFileSync(truth, `${readFileSync(truth, "utf8")} `);
    const result = cli(["--check-fixtures", "--offline", "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(
      output.problems.some((problem) => /sha256|digest/i.test(problem)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check-ledger accepts a valid row and rejects a foreign defect id", () => {
  const root = makeRoot();
  try {
    const ledger = path.join(root, ledgerRelative);
    const row = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    writeFileSync(ledger, `${JSON.stringify(row)}\n`);
    const good = cli(["--check-ledger", "--json"], { root });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).rows, 1);

    row.conditions.pipeline.per_defect["999999999"] = [0];
    row.conditions.pipeline.recall.opportunities += 1;
    row.conditions.pipeline.recall.rate = Number(
      (
        row.conditions.pipeline.recall.matched /
        row.conditions.pipeline.recall.opportunities
      ).toFixed(3),
    );
    writeFileSync(ledger, `${JSON.stringify(row)}\n`);
    const bad = cli(["--check-ledger", "--json"], { root });
    assert.equal(bad.status, 1);
    assert.ok(
      JSON.parse(bad.stdout).problems.some((problem) =>
        problem.includes("999999999"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check-ledger reports freshness from executed_at alone", () => {
  const root = makeRoot();
  try {
    const result = cli(["--check-ledger", "--json"], { root });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.rows, 0);
    assert.ok(["green", "warn", "red"].includes(output.freshness.level));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planCells builds the documented matrices", () => {
  const canary = planCells({ contract, kind: "canary" });
  assert.equal(canary.length, 3);
  assert.ok(canary.every((cell) => cell.condition === "replay"));
  assert.ok(canary.every((cell) => cell.finder_report));

  const full = planCells({ contract, kind: "full" });
  const byCondition = (name) =>
    full.filter((cell) => cell.condition === name).length;
  assert.equal(full.length, 24);
  assert.equal(byCondition("pipeline"), 12);
  assert.equal(byCondition("replay"), 6);
  assert.equal(byCondition("control"), 6);
  assert.ok(
    full
      .filter((cell) => cell.condition === "control")
      .every((cell) => cell.prompt === "request"),
  );
});

test("--plan writes plan.json and pins the comparability key", () => {
  const root = makeRoot();
  const out = path.join(root, "plan");
  try {
    const result = cli(["--plan", "--kind", "canary", "--out", out, "--json"], {
      root,
      env: planEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.kind, "canary");
    assert.equal(plan.baseline_selection, "automatic");
    assert.equal(plan.cells.length, 3);
    assert.equal(
      plan.comparability_key,
      comparabilityKey({ contract, contractDigest }),
    );
    assert.equal(plan.inputs.host, "test-host");
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(out, "plan.json"), "utf8")).cells,
      plan.cells,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--plan --skill-ref stamps a dirty candidate run", () => {
  const root = makeRoot();
  const out = path.join(root, "plan");
  try {
    const result = cli(
      [
        "--plan",
        "--kind",
        "canary",
        "--skill-ref",
        path.join(repoRoot, "scripts/review/prompts"),
        "--out",
        out,
        "--json",
      ],
      { root, env: planEnv },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.inputs.dirty, true);
    assert.match(plan.inputs.skill_ref, /prompts$/);

    const baseline = makeRow({ executedAt: "2026-07-08T10:00:00Z" });
    const baselinePath = path.join(root, "baseline-row.json");
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const explicit = cli(
      [
        "--plan",
        "--kind",
        "canary",
        "--against",
        baselinePath,
        "--out",
        path.join(root, "explicit-plan"),
        "--json",
      ],
      { root, env: planEnv },
    );
    assert.equal(explicit.status, 0, explicit.stderr);
    const explicitPlan = JSON.parse(explicit.stdout);
    assert.equal(explicitPlan.baseline_selection, "explicit");
    assert.deepEqual(explicitPlan.baseline, baselinePlanIdentity(baseline));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comparabilityKey moves with the contract, the prompts, and the scorer", () => {
  const base = comparabilityKey({ contract, contractDigest });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(
    base,
    comparabilityKey({ contract, contractDigest: "f".repeat(64) }),
  );
  const drifted = structuredClone(contract);
  drifted.prompts.request.sha256 = "0".repeat(64);
  assert.notEqual(
    base,
    comparabilityKey({ contract: drifted, contractDigest }),
  );
  assert.notEqual(
    base,
    comparabilityKey({
      contract,
      contractDigest,
      matcherDigest: "1".repeat(64),
    }),
  );
  // The frozen calibration set decides what `judge_calibration` means, so an
  // edit to it starts a new series instead of being compared across.
  assert.notEqual(
    base,
    comparabilityKey({
      contract,
      contractDigest,
      calibrationDigest: "2".repeat(64),
    }),
  );
  // The wrapper and both sourced helpers fix the contestant's tools, turn
  // limit, skill staging and finder truncation. An edit to any of them
  // re-anchors the series the way a prompt edit does.
  assert.notEqual(
    base,
    comparabilityKey({
      contract,
      contractDigest,
      orchestratorDigest: "3".repeat(64),
    }),
  );
  assert.equal(
    base,
    comparabilityKey({
      contract,
      contractDigest,
      orchestratorDigest: orchestratorSourceDigest(),
    }),
  );
});

test("orchestratorSourceDigest binds the wrapper and both helpers", () => {
  const expected =
    "77bba1e0af554775f19429d48ea6470a3574b05e6b3ed95a1b3e73e8bf3a2807";
  assert.equal(orchestratorSourceDigest(), expected);
  assert.deepEqual(
    ORCHESTRATOR_FILES.map((file) => path.basename(file)),
    ["run-eval.sh", "run-eval-lifecycle.sh", "run-eval-runtime.sh"],
  );

  for (const changed of ORCHESTRATOR_FILES) {
    const dir = mkdtempSync(path.join(tmpdir(), "review-eval-orchestrator-"));
    try {
      const copies = ORCHESTRATOR_FILES.map((file) => {
        const copy = path.join(dir, path.basename(file));
        cpSync(file, copy);
        return copy;
      });
      const changedCopy = copies.find(
        (file) => path.basename(file) === path.basename(changed),
      );
      writeFileSync(
        changedCopy,
        `${readFileSync(changedCopy, "utf8")}# drift\n`,
      );
      assert.notEqual(orchestratorSourceDigest({ files: copies }), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("resolveKind picks full only when the last full run is past cadence", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  const fresh = [
    makeRow({ executedAt: "2026-11-01T00:00:00Z", kind: "full" }),
  ].map((row) => ({ ...row, contract_digest: contractDigest }));
  assert.equal(
    resolveKind({ kind: "auto", rows: fresh, contract, contractDigest, now }),
    "canary",
  );
  const stale = [makeRow({ executedAt: "2026-01-01T00:00:00Z", kind: "full" })];
  assert.equal(
    resolveKind({ kind: "auto", rows: stale, contract, contractDigest, now }),
    "full",
  );
  assert.equal(
    resolveKind({ kind: "canary", rows: stale, contract, contractDigest, now }),
    "canary",
  );
  // A full run that failed leaves a `kind: "full"` trace row. It is a record
  // that the harness tried, not a score, so it must not buy the schedule
  // another cadence window of canaries.
  const failed = [
    makeRow({ executedAt: "2026-01-01T00:00:00Z", kind: "full" }),
    makeRow({
      executedAt: "2026-11-30T00:00:00Z",
      kind: "full",
      status: "failed",
      verdict: "INCOMPLETE",
    }),
  ];
  assert.equal(
    resolveKind({ kind: "auto", rows: failed, contract, contractDigest, now }),
    "full",
  );
});

test("leakSignals flags a PR number and a reviewer login, not a bare review", () => {
  const truth = JSON.parse(
    readFileSync(path.join(repoRoot, contract.fixtures[2].truth_file), "utf8"),
  );
  const clean = leakSignals({
    transcript: "scripts/pr/pr-ready-state-core.mjs:750 grows past the cap.",
    truth,
    pr: 1990,
  });
  assert.equal(clean.suspected, false);
  const leaked = leakSignals({
    transcript: `I read the comments on #1990 from ${truth.findings[0].author}.`,
    truth,
    pr: 1990,
  });
  assert.equal(leaked.suspected, true);
  assert.equal(leaked.hard.length, 2);
});

test("leakSignals keeps truth-independent checks when truth is absent", () => {
  for (const truth of [null, undefined]) {
    assert.deepEqual(
      leakSignals({ transcript: "ordinary review", truth, pr: 1990 }),
      { suspected: false, hard: [], advisory: [] },
    );
  }
  assert.deepEqual(
    leakSignals({ transcript: "reviewed #1990", truth: null, pr: 1990 }),
    {
      suspected: true,
      hard: ["transcript names PR 1990"],
      advisory: [],
    },
  );
});

test("a reviewer login the fixture's own source names is not a leak", () => {
  const truth = JSON.parse(
    readFileSync(path.join(repoRoot, contract.fixtures[2].truth_file), "utf8"),
  );
  const login = truth.findings[0].author;

  // A stub fixture whose tracked source names the reviewer, exactly as
  // pr-ready-state-core.mjs names coderabbitai[bot] at PR 1990's first head.
  const fixture = mkdtempSync(path.join(tmpdir(), "review-eval-tree-"));
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", fixture, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    writeFileSync(
      path.join(fixture, "pr-ready-state-core.mjs"),
      `export const BOT_APPROVER = ${JSON.stringify(login)};\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "fixture");

    const inTree = loginsInFixtureTree({
      fixturePath: fixture,
      logins: [login, "nobody-not-in-this-tree[bot]"],
    });
    assert.deepEqual([...inTree], [login]);

    const quoting = leakSignals({
      transcript: `line 1 sets BOT_APPROVER to ${login}, which is never read.`,
      truth,
      pr: 1990,
      excludeLogins: [...inTree],
    });
    assert.equal(quoting.suspected, false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("naming a commit withheld from the fixture is a hard leak signal", () => {
  const fixture = contract.fixtures[2];
  const truth = JSON.parse(
    readFileSync(path.join(repoRoot, fixture.truth_file), "utf8"),
  );
  const forbidden = forbiddenShasForFixture({ fixture, repoRoot });
  assert.ok(forbidden.length > 0, "the truth names a withheld fix head");

  const fetched = leakSignals({
    transcript: `I ran git show ${forbidden[0].slice(0, 12)} and read the fix.`,
    truth,
    pr: fixture.pr,
    forbiddenShas: forbidden,
  });
  assert.equal(fetched.suspected, true);
  assert.ok(
    fetched.hard.some((signal) => /withheld commit/.test(signal)),
    fetched.hard.join("; "),
  );

  const clean = leakSignals({
    transcript: "scripts/pr/pr-ready-state-core.mjs:750 grows past the cap.",
    truth,
    pr: fixture.pr,
    forbiddenShas: forbidden,
  });
  assert.equal(clean.suspected, false);
});

test("a cached cell from another skill or contract is never reused", () => {
  const plan = buildPlan({
    contract,
    contractDigest,
    kind: "canary",
    repoRoot,
    write: false,
    env: planEnv,
  });
  const fingerprint = cellFingerprint({ plan });
  assert.deepEqual(Object.keys(fingerprint).sort(), [
    "claude_cli",
    "codex_cli",
    "contract_digest",
    "finder_argv_digest",
    "kind",
    "orchestrator_digest",
    "skill_digest",
  ]);
  const candidatePlan = {
    ...plan,
    inputs: {
      ...plan.inputs,
      skill_ref: "/tmp/review-candidate",
      dirty: true,
    },
  };
  assert.deepEqual(cellFingerprint({ plan: candidatePlan }), fingerprint);
  assert.deepEqual(treatmentIdentity({ plan }), {
    skill_ref: "installed",
    dirty: false,
  });
  assert.deepEqual(treatmentIdentity({ plan: candidatePlan }), {
    skill_ref: "/tmp/review-candidate",
    dirty: true,
  });

  const decide = (result) =>
    cellReuseDecision({ plan, resultPath: "unused", result });
  assert.equal(decide({ ok: true, fingerprint }).reuse, true);
  const legacyOrchestratorFingerprint = {
    ...fingerprint,
    orchestrator_digest:
      "5cdfbd0e709af2d68c193d484b724706b339ab0562d14b283f5fc38eebe9ae49",
  };
  const transitioned = decide({
    ok: true,
    fingerprint: legacyOrchestratorFingerprint,
  });
  assert.equal(transitioned.reuse, true);
  assert.match(transitioned.reason, /recorded pure orchestrator split/);
  assert.equal(
    cellReuseDecision({
      plan: {
        ...plan,
        inputs: { ...plan.inputs, orchestrator_digest: "4".repeat(64) },
      },
      resultPath: "unused",
      result: { ok: true, fingerprint: legacyOrchestratorFingerprint },
    }).reuse,
    false,
  );
  assert.match(decide({ ok: true }).reason, /carries no fingerprint/);
  assert.match(
    decide({ ok: true, fingerprint: { ...fingerprint, skill_digest: "0" } })
      .reason,
    /different skill_digest/,
  );
  assert.match(
    decide({ ok: true, fingerprint: { ...fingerprint, legacy: true } }).reason,
    /unexpected legacy/,
  );
  assert.match(
    decide({ ok: true, fingerprint: { ...fingerprint, kind: "full" } }).reason,
    /different kind/,
  );
  assert.match(
    decide({
      ok: true,
      fingerprint: { ...fingerprint, contract_digest: "0".repeat(64) },
    }).reason,
    /different contract_digest/,
  );
  // A run resumed after a CLI upgrade must re-run its cells: the new row
  // stamps the current versions, so reusing output from the previous binaries
  // would record two runtimes under one provenance.
  // An edited orchestrator is the same class of change: it decides the tools,
  // the turn limit and the staging a cell ran under, so cells produced by the
  // previous script may not be folded into this run's numbers.
  for (const field of [
    "claude_cli",
    "codex_cli",
    "finder_argv_digest",
    "orchestrator_digest",
  ]) {
    assert.match(
      decide({ ok: true, fingerprint: { ...fingerprint, [field]: "moved" } })
        .reason,
      new RegExp(`different ${field}`),
    );
  }
  assert.match(
    cellReuseDecision({ plan, resultPath: path.join(repoRoot, "no-such-cell") })
      .reason,
    /no cell result/,
  );
});

test("the exact pre-split cache is discovered, seeded, and reused", () => {
  const root = makeRoot();
  const now = new Date("2026-08-28T20:00:00Z");
  const oldKey =
    "4543e3da483d5f2c70fc97e97664377ae22cc844bf1e5f376c1ce60eb3a42267";
  const oldMatcher =
    "d183758cd7a3b28aa14fe857ed04c6ca93601e1834a1dfd08cf730ad2332c922";
  const oldOrchestrator =
    "5cdfbd0e709af2d68c193d484b724706b339ab0562d14b283f5fc38eebe9ae49";
  try {
    const planArgs = {
      contract,
      contractDigest,
      kind: "full",
      repoRoot: root,
      now,
      env: planEnv,
    };
    const first = buildPlan({ ...planArgs, write: false });
    const runs = "docs/evals/review-skill-runs";
    const oldDetail = `${runs}/2026-08-28-${oldKey.slice(0, 8)}-full-${first.inputs.skill_digest.slice(0, 8)}`;
    const oldPhysical = path.join(root, oldDetail);
    const cell = first.cells[0];
    const oldResult = path.join(
      oldPhysical,
      "cells",
      cell.cell_id,
      "result.json",
    );
    mkdirSync(path.dirname(oldResult), { recursive: true });
    const oldPlan = {
      ...first,
      matcher_digest: oldMatcher,
      comparability_key: oldKey,
      detail_dir: oldDetail,
      plan_dir: oldPhysical,
      resume_from: null,
      inputs: {
        ...first.inputs,
        orchestrator_digest: oldOrchestrator,
      },
    };
    writeFileSync(
      path.join(oldPhysical, "plan.json"),
      JSON.stringify({ ...oldPlan, matcher_digest: "0".repeat(64) }),
    );
    const oldFingerprint = {
      ...cellFingerprint({ plan: first }),
      orchestrator_digest: oldOrchestrator,
    };
    writeFileSync(
      oldResult,
      JSON.stringify({ ok: true, fingerprint: oldFingerprint }),
    );

    const currentOut = path.join(root, first.detail_dir);
    const refused = buildPlan({
      ...planArgs,
      outDir: currentOut,
      write: false,
    });
    assert.equal(refused.resume_from, null);

    writeFileSync(path.join(oldPhysical, "plan.json"), JSON.stringify(oldPlan));
    const invalidDetail = `${oldDetail}-2`;
    const invalidPhysical = path.join(root, invalidDetail);
    mkdirSync(invalidPhysical, { recursive: true });
    writeFileSync(
      path.join(invalidPhysical, "plan.json"),
      JSON.stringify({
        ...oldPlan,
        planned_at: "2026-08-28T21:00:00Z",
        detail_dir: invalidDetail,
        plan_dir: invalidPhysical,
      }),
    );
    for (const invalidCell of first.cells.slice(0, 2)) {
      const invalidResult = path.join(
        invalidPhysical,
        "cells",
        invalidCell.cell_id,
        "result.json",
      );
      mkdirSync(path.dirname(invalidResult), { recursive: true });
      writeFileSync(
        invalidResult,
        JSON.stringify({
          ok: true,
          fingerprint: { ...oldFingerprint, unexpected: true },
        }),
      );
    }
    const planned = buildPlan({
      ...planArgs,
      outDir: currentOut,
      write: true,
    });
    assert.equal(planned.resume_from, oldDetail);

    const shell = runEvalSourceSet();
    const block = shell.match(
      /\nRESUME_FROM="\$\(json_field "\$PLAN_OUT" resume_from\)"\n[\s\S]*?\nfi\n/,
    )?.[0];
    const guard = shell.match(
      /\nrequire_safe_detail\(\) \{\n[\s\S]*?\n\}\n/,
    )?.[0];
    assert.ok(block, "the resume-cache step was not found in run-eval.sh");
    assert.ok(guard, "the detail-path guard was not found in run-eval.sh");
    const harness = [
      "set -euo pipefail",
      `REPO=${JSON.stringify(root)}`,
      `RUN_DIR=${JSON.stringify(currentOut)}`,
      `PLAN_OUT=${JSON.stringify(path.join(currentOut, "plan.json"))}`,
      `fail() { printf 'FATAL: %s\\n' "$*" >&2; exit 1; }`,
      `log() { printf '%s\\n' "$*"; }`,
      `json_field() { node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(d[process.argv[2]]));' "$1" "$2"; }`,
      guard,
      block,
    ].join("\n");
    const seeded = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.match(seeded.stdout, /seeded the resume cache/);

    const copiedResult = path.join(
      currentOut,
      "cells",
      cell.cell_id,
      "result.json",
    );
    const decision = cellReuseDecision({
      plan: planned,
      resultPath: copiedResult,
    });
    assert.equal(decision.reuse, true);
    assert.match(decision.reason, /recorded pure orchestrator split/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the detail directory separates two skills under one contract", () => {
  const forSkill = (skillDir) =>
    buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot,
      write: false,
      skillRef: skillDir,
      env: planEnv,
    });
  const a = forSkill(path.join(repoRoot, "scripts/review/prompts"));
  const b = forSkill(path.join(repoRoot, "docs/evals/review-skill-truth"));
  assert.notEqual(a.inputs.skill_digest, b.inputs.skill_digest);
  assert.notEqual(a.detail_dir, b.detail_dir);
  assert.equal(a.comparability_key, b.comparability_key);
  assert.match(a.detail_dir, /-canary-[0-9a-f]{8}$/);
});

test("a detail directory a ledger row records is never planned again", () => {
  // The directory is the resume cache, so a run killed before it recorded
  // anything is retried into it and reuses its paid cells. It is also the
  // evidence a row points at: a second execution on the same day, with the same
  // key, kind and skill, used to overwrite the earlier row's plan, results, row
  // and report, and reuse its publication branch name.
  const plan = () =>
    buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot,
      write: false,
      env: planEnv,
      ledgerRows: recorded,
    });
  const recorded = [];
  const first = plan();
  assert.equal(first.resume_from, null);
  // Nothing recorded yet: the retry lands on the same cells.
  assert.equal(plan().detail_dir, first.detail_dir);

  recorded.push({ detail_dir: first.detail_dir });
  const second = plan();
  assert.equal(second.detail_dir, `${first.detail_dir}-2`);
  assert.equal(second.resume_from, first.detail_dir);

  recorded.push({ detail_dir: second.detail_dir });
  const third = plan();
  assert.equal(third.detail_dir, `${first.detail_dir}-3`);
  assert.equal(third.resume_from, second.detail_dir);

  // A row from another run never moves this name.
  assert.equal(
    resolveDetailDir({
      runsDir: "runs",
      base: "b",
      ledgerRows: [{ detail_dir: "runs/other" }, { detail_dir: null }],
    }).detailDir,
    "runs/b",
  );
  assert.throws(
    () =>
      resolveDetailDir({
        runsDir: "runs",
        base: "b",
        ledgerRows: Array.from({ length: 60 }, (_unused, index) => ({
          detail_dir: index === 0 ? "runs/b" : `runs/b-${index + 1}`,
        })),
      }),
    /refusing to plan another/,
  );
});

test("a symlink in the skill directory refuses the digest", () => {
  // `readdirSync` calls a symlink neither a file nor a directory, so it was
  // walked past silently: nothing under it reached `skill_digest`, while
  // `run-eval.sh` stages the skill with `cp -R`, which keeps the link. The
  // contestant would read target bytes no digest keys, and an edit to that
  // target mid-run would change the treatment under the recorded digest.
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-skill-"));
  const outside = mkdtempSync(path.join(tmpdir(), "review-eval-outside-"));
  try {
    writeFileSync(path.join(dir, "SKILL.md"), "# review\n");
    const clean = skillDigest(dir);
    assert.match(clean, /^[0-9a-f]{64}$/);

    writeFileSync(path.join(outside, "playbook.md"), "the real instructions\n");
    symlinkSync(path.join(outside, "playbook.md"), path.join(dir, "refs.md"));
    assert.throws(() => skillDigest(dir), /refs\.md is a symlink/);

    // A directory link escapes the same way, and used to be skipped too.
    // unlinkSync, not rmSync: Linux rmSync stats through a directory symlink
    // and refuses with ERR_FS_EISDIR, while unlink removes the link itself on
    // every platform.
    unlinkSync(path.join(dir, "refs.md"));
    symlinkSync(outside, path.join(dir, "references"));
    assert.throws(() => skillDigest(dir), /references is a symlink/);
    unlinkSync(path.join(dir, "references"));
    assert.equal(skillDigest(dir), clean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("skillDigest frames file paths and contents", () => {
  const first = mkdtempSync(path.join(tmpdir(), "review-eval-skill-first-"));
  const second = mkdtempSync(path.join(tmpdir(), "review-eval-skill-second-"));
  try {
    for (const dir of [first, second]) {
      writeFileSync(path.join(dir, "SKILL.md"), "# review\n");
    }
    // Without framing, both streams end in the same bytes: `abc`.
    writeFileSync(path.join(first, "a"), "bc");
    writeFileSync(path.join(second, "ab"), "c");
    assert.notEqual(skillDigest(first), skillDigest(second));
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("a baseline from another CLI version is paired and labelled", () => {
  // The comparability key deliberately omits the CLI versions: they ship far
  // more often than this suite runs, so keying on them would end the lineage at
  // every upgrade and leave every later run with no baseline and no flip rule.
  // The pairing therefore stands, and the drift is named beside the verdict.
  const baselineRow = makeRow({
    executedAt: "2026-09-01T10:00:00Z",
    matchedIds: scorableIdsFor([1990]),
    fullMatrix: true,
  });
  const row = makeRow({
    executedAt: "2026-09-08T10:00:00Z",
    matchedIds: scorableIdsFor([1990]),
    fullMatrix: true,
  });
  row.inputs = { ...row.inputs, claude_cli: "2.2.0" };
  const decision = verdict({ contract, row, baselineRow });
  const reasons = decision.reasons.join(" | ");
  assert.match(reasons, /baseline ran under claude 2\.1\.14/);
  assert.match(reasons, /this run under claude 2\.2\.0/);
  assert.match(
    reasons,
    /a flip may come from the runtime rather than the skill/,
  );
  // Labelled, not refused: the flip counts still come from the pair.
  assert.notEqual(buildVsBaseline({ row, baselineRow })?.mcnemar, null);
  assert.deepEqual(
    verdict({
      contract,
      row: makeRow({
        executedAt: "2026-09-08T10:00:00Z",
        matchedIds: scorableIdsFor([1990]),
        fullMatrix: true,
      }),
      baselineRow,
    }).reasons.filter((reason) => reason.includes("runtime")),
    [],
  );
});

test("failedRow is schema-valid and never ranks", () => {
  const plan = buildPlan({
    contract,
    contractDigest,
    kind: "canary",
    repoRoot,
    write: false,
    env: planEnv,
  });
  const row = failedRow({
    plan,
    contract,
    contractDigest,
    reason: "claude was unauthenticated",
  });
  assert.deepEqual(validateLedgerRow(row), []);
  assert.equal(row.status, "failed");
  assert.equal(row.verdict, "INCOMPLETE");
  assert.equal(row.conditions.replay.finder, plan.cells[0].finder);
  assert.match(row.notes, /unauthenticated/);
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-failed-row-"));
  try {
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
    assert.deepEqual(planProvenanceProblems({ dir, row, contract }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revalidateRow recomputes the numbers and catches a tampered count", () => {
  const row = makeRow({ matchedIds: scorableIdsFor([1990]) });
  assert.deepEqual(revalidateRow({ contract, row, repoRoot }).problems, []);
  row.conditions.pipeline.recall.matched += 3;
  const bad = revalidateRow({ contract, row, repoRoot });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((problem) => problem.includes("recall.matched")));
});

test("revalidateRow recomputes the P1 denominator, not just its numerator", () => {
  // `verdict()` skips the `p1_recall_floor` check on a null rate, because only
  // zero P1 opportunities may produce one. A row that keeps its P1 bits but
  // states it scored no P1 defect therefore hides a floor breach: every P1 bit
  // is a miss and the row still passes as GREEN with the floor never applied.
  const honest = makeRow({ matchedIds: [] });
  const opportunities = honest.conditions.pipeline.p1.opportunities;
  assert.ok(opportunities > 0);
  const laundered = makeRow({ matchedIds: [], verdict: "GREEN" });
  laundered.conditions.pipeline.p1 = {
    matched: 0,
    opportunities: 0,
    rate: null,
  };
  const caught = revalidateRow({ contract, row: laundered, repoRoot });
  assert.equal(caught.ok, false);
  assert.ok(
    caught.problems.some((problem) =>
      problem.startsWith(
        `conditions.pipeline.p1.opportunities is 0; the bits give ${opportunities}`,
      ),
    ),
    JSON.stringify(caught.problems),
  );
  assert.ok(
    caught.problems.some((problem) => /p1\.rate is null/.test(problem)),
    JSON.stringify(caught.problems),
  );
});

test("revalidateRow recomputes the verdict a row states about itself", () => {
  const honest = makeRow({ matchedIds: scorableIdsFor([1990]) });
  const recomputed = revalidateRow({ contract, row: honest, repoRoot });
  assert.deepEqual(recomputed.problems, []);
  assert.equal(recomputed.verdict, honest.verdict);

  const stated = honest.verdict === "GREEN" ? "PROMOTE" : "GREEN";
  const mislabelled = makeRow({
    matchedIds: scorableIdsFor([1990]),
    verdict: stated,
  });
  const caught = revalidateRow({ contract, row: mislabelled, repoRoot });
  assert.equal(caught.ok, false);
  assert.ok(
    caught.problems.some((problem) =>
      problem.startsWith(
        `row.verdict is ${stated}; the row's own numbers give`,
      ),
    ),
    JSON.stringify(caught.problems),
  );
});

test("revalidateRow recomputes vs_baseline instead of trusting it", () => {
  // `verdict()` never reads `vs_baseline`; it pairs the two rows itself. That
  // left the stored pairing — the McNemar counts printed in the committed
  // report — as the row's own say-so, retypeable by hand.
  const baselineRow = makeRow({
    executedAt: "2026-09-08T10:00:00Z",
    matchedIds: scorableIdsFor([1990, 1999]),
  });
  const row = makeRow({
    executedAt: "2026-12-08T10:00:00Z",
    matchedIds: scorableIdsFor([1990]),
  });
  row.vs_baseline = buildVsBaseline({
    row,
    baselineRow,
    selection: "explicit",
  });
  row.verdict = verdict({ contract, row, baselineRow }).verdict;
  assert.ok(row.vs_baseline.mcnemar.b > 0, "the fixture pair must flip");
  assert.deepEqual(
    revalidateRow({ contract, row, repoRoot, baselineRow }).problems,
    [],
  );
  assert.match(
    revalidateRow({
      contract,
      row,
      repoRoot,
      baselineRow,
      baselineIsExplicit: false,
    }).problems.join(" | "),
    /row\.vs_baseline\.selection is explicit; this validation uses automatic/,
  );

  const flattened = {
    ...row,
    vs_baseline: { ...row.vs_baseline, mcnemar: { b: 0, c: 0, delta: 0 } },
  };
  const caught = revalidateRow({
    contract,
    row: flattened,
    repoRoot,
    baselineRow,
  });
  assert.equal(caught.ok, false);
  assert.ok(
    caught.problems.some((problem) =>
      problem.startsWith("row.vs_baseline.mcnemar is b=0 c=0 delta=0;"),
    ),
    JSON.stringify(caught.problems),
  );

  const misnamed = {
    ...row,
    vs_baseline: {
      ...row.vs_baseline,
      baseline_executed_at: "2020-01-01T00:00:00Z",
    },
  };
  const named = revalidateRow({
    contract,
    row: misnamed,
    repoRoot,
    baselineRow,
  });
  assert.equal(named.ok, false);
  assert.ok(
    named.problems.some((problem) =>
      problem.startsWith(
        "row.vs_baseline.baseline_executed_at is 2020-01-01T00:00:00Z;",
      ),
    ),
    JSON.stringify(named.problems),
  );

  // A row that records no pairing under-claims, which is not a problem: there
  // is no baseline row to recompute against when `--validate` is handed none.
  assert.deepEqual(
    revalidateRow({ contract, row: { ...row, vs_baseline: null }, repoRoot })
      .problems,
    [],
  );
});

test("an explicit baseline must be a complete full run", () => {
  // `--against` reaches `comparable()` with whatever row it names. A canary is
  // a two-cell floor test and a partial run is a matrix with cells that never
  // ran, so neither carries the bits a flip count needs.
  const row = makeRow({
    executedAt: "2026-12-08T10:00:00Z",
    matchedIds: scorableIdsFor([1990]),
  });
  const ranking = makeRow({
    executedAt: "2026-09-08T10:00:00Z",
    matchedIds: scorableIdsFor([1990, 1999]),
  });
  // The same pair, ranked: the flip count is what a partial or canary baseline
  // must not be allowed to produce.
  assert.match(
    verdict({ contract, row, baselineRow: ranking }).reasons.join(" | "),
    /lost a net \d+ defects against the baseline/,
  );
  const unpaired = verdict({ contract, row, baselineRow: null });
  for (const baseline of [
    makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      status: "partial",
      matchedIds: scorableIdsFor([1990, 1999]),
    }),
    makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      kind: "canary",
      matchedIds: scorableIdsFor([1990, 1999]),
    }),
  ]) {
    const decision = verdict({ contract, row, baselineRow: baseline });
    assert.match(
      decision.reasons.join(" | "),
      /comparison refused \(a baseline must be a complete full run\)/,
    );
    // A refused baseline contributes nothing: no flip count, no reason drawn
    // from one, and the same verdict the row gets with no baseline at all.
    assert.doesNotMatch(
      decision.reasons.join(" | "),
      /against the baseline|noise floor/,
    );
    assert.equal(decision.verdict, unpaired.verdict);
  }
});

test("revalidateRow refuses a detail sum that is not a finite number", () => {
  const detail = mkdtempSync(path.join(tmpdir(), "review-eval-nonfinite-"));
  try {
    const row = makeRow({ matchedIds: [] });
    // `Number("about $2")` is NaN and every comparison with NaN is false, so a
    // corrupt cell record used to let any stated cost pass the recompute.
    writeFileSync(
      path.join(detail, "result-1990-pipeline-1.json"),
      JSON.stringify({
        pr: 1990,
        condition: "pipeline",
        draw: 1,
        matched_ids: [],
        claims: ["one"],
        novel: { novelWrong: 0, novelReal: 1 },
        usd: "about $2",
        seconds: 600,
      }),
    );
    const result = revalidateRow({
      contract,
      row,
      repoRoot,
      detailDir: detail,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) =>
        problem.startsWith(
          "conditions.pipeline.usd cannot be checked; the run detail sums to NaN",
        ),
      ),
      JSON.stringify(result.problems),
    );
  } finally {
    rmSync(detail, { recursive: true, force: true });
  }
});

test("run-eval.sh refuses a detail_dir before it can delete the checkout", () => {
  // `json_field` prints `String(doc[key])`: a missing key arrives as the word
  // "undefined" and a JSON null as "null". An empty value is the dangerous one
  // — it makes `rm -rf "$REPO/$detail"` target the checkout itself.
  const shell = runEvalSourceSet();
  const guard = shell.match(
    /\nrequire_safe_detail\(\) \{\n[\s\S]*?\n\}\n/,
  )?.[0];
  assert.ok(guard, "require_safe_detail was not found in run-eval.sh");
  const harness = [
    "set -euo pipefail",
    'REPO="/tmp/review-eval-checkout"',
    `fail() { printf 'FATAL: %s\\n' "$*" >&2; exit 1; }`,
    guard,
    'require_safe_detail "$1"',
  ].join("\n");
  const check = (value) =>
    spawnSync("bash", ["-c", harness, "bash", value], { encoding: "utf8" });
  for (const bad of [
    "",
    "undefined",
    "null",
    "/etc",
    "docs/../../evals/runs",
    "..",
  ]) {
    assert.equal(
      check(bad).status,
      1,
      `detail_dir ${JSON.stringify(bad)} was accepted`,
    );
  }
  for (const good of [
    "docs/evals/review-skill-runs/2026-09-08-deadbeef-full-abc",
    // Two dots inside a component are a name, not a climb.
    "docs/evals/review-skill-runs/2026-09-08..deadbeef",
  ]) {
    const run = check(good);
    assert.equal(run.status, 0, `${good}: ${run.stderr}`);
  }
});

test("run-eval.sh exits non-zero when no PR carries the row", () => {
  // Both endings append a row to the checkout's ledger — the scored one and the
  // status:failed trace alike — and the installed launchd job runs without
  // --pr. Exiting zero while only the publish commands were printed reports a
  // clean run while the next scheduled run refuses to start against a ledger
  // with uncommitted changes.
  const shell = runEvalSourceSet();
  const guard = shell.match(
    /\nif \[\[ \$PUBLISHED -ne 1 \]\]; then\n[\s\S]*?\nfi\nexit 0\n/,
  )?.[0];
  assert.ok(guard, "the success path does not check PUBLISHED");
  const harness = (published) =>
    [
      "set -uo pipefail",
      `fail() { printf 'FATAL: %s\\n' "$*" >&2; exit 1; }`,
      'VERDICT="GREEN"',
      'LEDGER="/tmp/ledger.jsonl"',
      `PUBLISHED=${published}`,
      guard,
    ].join("\n");
  const unpublished = spawnSync("bash", ["-c", harness(0)], {
    encoding: "utf8",
  });
  assert.equal(unpublished.status, 1);
  assert.match(unpublished.stderr, /no PR carries it yet/);
  assert.equal(
    spawnSync("bash", ["-c", harness(1)], { encoding: "utf8" }).status,
    0,
  );

  // The failure path has carried the same rule since it was written.
  assert.match(shell, /if \[\[ \$PUBLISHED -eq 1 \]\]; then\n\s*exit 0\n\s*fi/);
});

test("run-eval.sh seeds a fresh run directory from the cells it superseded", () => {
  // Once a ledger row records a detail directory the plan hands the next
  // execution its own. The cells in the old one are paid for, so they are
  // copied across — and re-checked one by one against this run's fingerprint,
  // exactly as cells found in place are.
  const shell = runEvalSourceSet();
  const block = shell.match(
    /\nRESUME_FROM="\$\(json_field "\$PLAN_OUT" resume_from\)"\n[\s\S]*?\nfi\n/,
  )?.[0];
  assert.ok(block, "the resume-cache step was not found in run-eval.sh");
  const guard = shell.match(
    /\nrequire_safe_detail\(\) \{\n[\s\S]*?\n\}\n/,
  )?.[0];
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-resume-"));
  try {
    const runs = "docs/evals/review-skill-runs";
    const previous = path.join(dir, runs, "2026-09-08-key-full-skill");
    mkdirSync(path.join(previous, "cells", "pr-1990-pipeline-draw1"), {
      recursive: true,
    });
    writeFileSync(
      path.join(previous, "cells", "pr-1990-pipeline-draw1", "result.json"),
      '{"ok":true}\n',
    );
    const runDir = path.join(dir, runs, "2026-09-08-key-full-skill-2");
    const harness = (resumeFrom) =>
      [
        "set -euo pipefail",
        `REPO=${JSON.stringify(dir)}`,
        `RUN_DIR=${JSON.stringify(runDir)}`,
        `PLAN_OUT=${JSON.stringify(path.join(dir, "plan.json"))}`,
        `fail() { printf 'FATAL: %s\\n' "$*" >&2; exit 1; }`,
        `log() { printf '%s\\n' "$*"; }`,
        `json_field() { printf '%s' ${JSON.stringify(resumeFrom)}; }`,
        guard,
        block,
      ].join("\n");
    const seeded = spawnSync(
      "bash",
      ["-c", harness(`${runs}/2026-09-08-key-full-skill`)],
      { encoding: "utf8" },
    );
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.match(seeded.stdout, /seeded the resume cache/);
    assert.ok(
      existsSync(
        path.join(runDir, "cells", "pr-1990-pipeline-draw1", "result.json"),
      ),
    );

    // A first run has nothing to seed from, and a resume_from that climbs out
    // of the checkout is refused before anything is copied.
    rmSync(runDir, { recursive: true, force: true });
    const first = spawnSync("bash", ["-c", harness("null")], {
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(path.join(runDir, "cells")), false);
    const escaping = spawnSync("bash", ["-c", harness("../../etc")], {
      encoding: "utf8",
    });
    assert.equal(escaping.status, 1);
    assert.match(escaping.stderr, /must not climb out of the checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-eval.sh publishes the appended row when the report fails", () => {
  // `--validate --append` has already put the row in the checkout's ledger by
  // the time the report is generated. `set -e` exiting on a failed `--report`
  // — a same-sitting `--against` file under /tmp that is gone by now is enough
  // — printed no PR and no recovery commands, and the next scheduled run then
  // refuses to start against the dirty ledger it left behind.
  const shell = runEvalSourceSet();
  const block = shell.match(
    /\nREPORT="\$RUN_DIR\/report\.md"\n[\s\S]*?\nlog "verdict \$VERDICT"\n/,
  )?.[0];
  assert.ok(block, "the report step was not found in run-eval.sh");
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-report-"));
  try {
    const runDir = path.join(dir, "run");
    mkdirSync(runDir);
    writeFileSync(
      path.join(runDir, "row.json"),
      JSON.stringify({ verdict: "AMBER" }),
    );
    const harness = [
      "set -euo pipefail",
      `TMPROOT=${JSON.stringify(dir)}`,
      `RUN_DIR=${JSON.stringify(runDir)}`,
      // A CLI path that is not there: `node` exits non-zero, which is every
      // way `--report` can fail as far as this step is concerned.
      `CLI=${JSON.stringify(path.join(dir, "no-such-cli.mjs"))}`,
      `SPEC=${JSON.stringify(dir)}`,
      `LEDGER=${JSON.stringify(path.join(dir, "ledger.jsonl"))}`,
      "AGAINST_ARGS=()",
      `log() { printf '%s\\n' "$*"; }`,
      `log_stderr_tail() { [[ -s $1 ]] && printf 'stderr: seen\\n'; }`,
      // shellcheck-clean stand-in for the real reader, which spawns node.
      `json_field() { node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]))' "$1" "$2"; }`,
      block,
      'printf "reached-publish %s\\n" "$VERDICT"',
    ].join("\n");
    const run = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /reached-publish AMBER/);
    assert.match(run.stdout, /the report could not be generated/);
    assert.match(run.stdout, /stderr: seen/);
    const body = readFileSync(path.join(runDir, "report.md"), "utf8");
    assert.match(body, /Review-skill eval: AMBER/);
    assert.match(body, /re-run `pnpm review:eval -- --report`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-eval.sh keeps the stderr of a bounded command it had to fail", () => {
  // A finder, a contestant or the scorer says why it exited on stderr, and
  // every failure path logs only an exit status. Discarding stderr left the
  // one line that explains the failure unreachable.
  const shell = runEvalSourceSet();
  const parts = ["run_bounded", "log_stderr_tail"].map((name) => {
    const source = shell.match(
      new RegExp(`\\n${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`),
    )?.[0];
    assert.ok(source, `${name} was not found in run-eval.sh`);
    return source;
  });
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-stderr-"));
  try {
    const out = path.join(dir, "out");
    const harness = [
      "set -uo pipefail",
      `log() { printf '%s\\n' "$*"; }`,
      ...parts,
      "status=0",
      `run_bounded "${out}" 30 bash -c 'printf hello; printf "boom: session limit reached\\n" >&2; exit 7' || status=$?`,
      `printf 'status=%s\\n' "$status"`,
      `log_stderr_tail "${out}.err"`,
    ].join("\n");
    const run = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /status=7/);
    assert.equal(readFileSync(out, "utf8"), "hello");
    assert.match(readFileSync(`${out}.err`, "utf8"), /boom: session limit/);
    // The tail reaches the log, which is the only place a scheduled run's
    // failure is ever read.
    assert.match(run.stdout, /boom: session limit reached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Every failure path that follows a bounded command logs that tail.
  for (const pattern of [
    /the finder exited \$finder_status; not cached"\n\s*log_stderr_tail "\$finder_out\.err"/,
    /claude exited \$claude_status; not cached"\n\s*fi\n\s*log_stderr_tail "\$raw\.err"/,
    /if \[\[ \$SCORE_STATUS -ne 0 \]\]; then\n\s*log_stderr_tail "\$SCORE_OUT\.err"/,
  ]) {
    assert.match(shell, pattern);
  }
});

test("run-eval.sh refuses a skill staging that did not land", () => {
  // The preamble is taken in a command substitution, so a failed `cp -R` and a
  // preamble missing the instructions both used to render as a plausible,
  // empty treatment that the cell was scored on.
  const shell = runEvalSourceSet();
  const parts = ["purge_skill", "skill_body_head", "stage_skill"].map(
    (name) => {
      const source = shell.match(
        new RegExp(`\\n${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`),
      )?.[0];
      assert.ok(source, `${name} was not found in run-eval.sh`);
      return source;
    },
  );
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-stage-"));
  try {
    const skill = path.join(dir, "skill");
    mkdirSync(path.join(skill, "references"), { recursive: true });
    writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: review\n---\n\nReview the change sceptically.\n",
    );
    writeFileSync(path.join(skill, "references/checks.md"), "checks\n");
    const fixture = path.join(dir, "fixture");
    mkdirSync(fixture, { recursive: true });
    const harness = (extra) =>
      [`set -uo pipefail`, `SKILL_DIR="${skill}"`, ...parts, extra].join("\n");

    const ok = spawnSync(
      "bash",
      ["-c", harness(`stage_skill "${fixture}" || printf 'STATUS=%s\\n' "$?"`)],
      { encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, /STATUS=/);
    assert.match(ok.stdout, /Review the change sceptically\./);
    assert.match(ok.stdout, /- \.skill\/references\/checks\.md/);
    // The frontmatter never reaches the model.
    assert.doesNotMatch(ok.stdout, /name: review/);

    // A copy that fails outright fails the staging.
    const noSource = spawnSync(
      "bash",
      [
        "-c",
        harness(
          `SKILL_DIR="${dir}/absent"\nstage_skill "${fixture}" >/dev/null 2>&1 || printf 'STATUS=%s\\n' "$?"`,
        ),
      ],
      { encoding: "utf8" },
    );
    assert.equal(noSource.status, 0, noSource.stderr);
    assert.match(noSource.stdout, /STATUS=1/);

    // A copy that reports success but leaves no instructions behind fails too:
    // the preamble would otherwise be framing printfs around nothing.
    const partial = spawnSync(
      "bash",
      [
        "-c",
        harness(
          [
            `cp() { mkdir -p "$3" && : >"$3/SKILL.md"; }`,
            `stage_skill "${fixture}" >/dev/null 2>&1 || printf 'STATUS=%s\\n' "$?"`,
          ].join("\n"),
        ),
      ],
      { encoding: "utf8" },
    );
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(partial.stdout, /STATUS=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The caller fails the cell rather than scoring the empty treatment.
  assert.match(
    shell,
    /if ! preamble="\$\(stage_skill "\$fixture"\)"; then\n\s*log "\s*\$cell_id FAILED — the skill did not stage into the fixture; not cached"/,
  );
});

test("run-eval.sh inserts finder output into the handoff prompt verbatim", () => {
  // The finder output is model text. `String.prototype.replace` reads $&, $`,
  // $' and $1 in a *string* replacement, so a review containing one of those
  // would rewrite the prompt the treatment under test receives. This runs the
  // shell script's own node program to prove the replacement stays literal.
  const shell = runEvalSourceSet();
  const program = shell.match(
    /REVIEW_EVAL_OTHER="\$other_review" node -e '\n([\s\S]*?)\n {4}' "\$SPEC/,
  )?.[1];
  assert.ok(program, "the handoff prompt node program was not found");
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-handoff-"));
  try {
    const template = path.join(dir, "handoff.md");
    writeFileSync(template, "before\n{{OTHER_REVIEW}}\nafter\n");
    const other = "finding: the regex $& eats $`this$' and $1 too";
    const result = spawnSync(process.execPath, ["-e", program, template], {
      encoding: "utf8",
      env: { ...process.env, REVIEW_EVAL_OTHER: other },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `before\n${other}\nafter\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--validate refuses bad or evidence-free rows and appends a good one", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    // A row `--append` may actually accept: a complete full run owes the whole
    // matrix, so the appended one carries pipeline, replay and control.
    const row = makeRow({
      matchedIds: scorableIdsFor([1990, 1999]),
      fullMatrix: true,
    });
    row.conditions.pipeline.p1.matched += 1;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const bad = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).appended, false);
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);

    row.conditions.pipeline.p1.matched -= 1;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const bitsOnly = cli(["--validate", rowPath, "--json"], { root });
    assert.equal(bitsOnly.status, 0, bitsOnly.stderr);
    assert.equal(JSON.parse(bitsOnly.stdout).ok, true);

    const explicitMissing = cli(
      [
        "--validate",
        rowPath,
        "--detail-dir",
        path.join(root, "missing-detail"),
        "--json",
      ],
      { root },
    );
    assert.equal(explicitMissing.status, 1);
    assert.match(
      JSON.parse(explicitMissing.stdout).problems.join(" | "),
      /--validate requires an existing non-symlink detail directory/,
    );

    const missing = cli(["--validate", rowPath, "--append", "--json"], {
      root,
    });
    assert.equal(missing.status, 1);
    assert.match(
      JSON.parse(missing.stdout).problems.join(" | "),
      /requires an existing non-symlink detail directory/,
    );
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);

    writeRowEvidence(root, row);
    const good = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).appended, true);
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --detail-dir recomputes from a run outside --root", () => {
  const root = makeRoot();
  const detail = mkdtempSync(path.join(tmpdir(), "review-eval-detail-"));
  try {
    const row = makeRow({ matchedIds: scorableIdsFor([1990]) });
    const rowPath = path.join(root, "row.json");
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    // The orchestrator reads the contract from a spec worktree while the
    // scored cells live in the real checkout, so the row's repo-relative
    // detail_dir does not resolve against --root.
    writeFileSync(
      path.join(detail, "result-1990-pipeline-1.json"),
      JSON.stringify({
        pr: 1990,
        condition: "pipeline",
        draw: 1,
        matched_ids: [],
        claims: ["one"],
        novel: { novelWrong: 0 },
      }),
    );
    const result = cli(
      ["--validate", rowPath, "--detail-dir", detail, "--json"],
      { root },
    );
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.detail_dir, detail);
    assert.ok(
      parsed.problems.some((problem) => /the run detail gives/.test(problem)),
      JSON.stringify(parsed.problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(detail, { recursive: true, force: true });
  }
});

test("--validate rejects a symlinked detail directory without append", () => {
  const root = makeRoot();
  try {
    const row = makeRow({
      matchedIds: scorableIdsFor([1990, 1999]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, row);
    const linkedDetail = path.join(root, "linked-detail");
    symlinkSync(detail, linkedDetail, "dir");
    const rowPath = path.join(root, "row.json");
    writeFileSync(rowPath, JSON.stringify(row, null, 2));

    const result = cli(
      ["--validate", rowPath, "--detail-dir", linkedDetail, "--json"],
      { root },
    );
    assert.equal(result.status, 1);
    assert.match(
      JSON.parse(result.stdout).problems.join(" | "),
      /--validate requires an existing non-symlink detail directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate reports a malformed row as problems, not a stack trace", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    const row = makeRow({ matchedIds: scorableIdsFor([1990, 1999]) });
    // A hand-edited or truncated row file reaches `--validate` unvalidated.
    // Dropping the counts the recompute reads must name the gap, not throw.
    delete row.conditions.pipeline.recall;
    delete row.conditions.pipeline.p1;
    row.conditions.control = null;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--json"], { root });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Cannot read properties/);
    const problems = JSON.parse(result.stdout).problems;
    assert.ok(
      problems.some((problem) =>
        /conditions\.pipeline is missing recall or p1/.test(problem),
      ),
      JSON.stringify(problems),
    );
    assert.ok(
      problems.some((problem) =>
        /conditions\.control is not an object/.test(problem),
      ),
      JSON.stringify(problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --append refuses a row that overstates its own verdict", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    const row = makeRow({
      matchedIds: scorableIdsFor([1990, 1999]),
      verdict: "PROMOTE",
    });
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.appended, false);
    assert.notEqual(output.recomputed_verdict, "PROMOTE");
    assert.ok(
      output.problems.some((problem) => problem.includes("row.verdict")),
      JSON.stringify(output.problems),
    );
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --append rejects coerced cell cost and duration", () => {
  const root = makeRoot();
  try {
    const row = makeRow({
      matchedIds: scorableIdsFor([1990, 1999]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, row);
    const rowPath = path.join(root, "row.json");
    const resultPath = path.join(detail, "result-1990-pipeline-1.json");
    const resultRecord = JSON.parse(readFileSync(resultPath, "utf8"));
    resultRecord.usd = null;
    resultRecord.seconds = "600";
    writeFileSync(resultPath, JSON.stringify(resultRecord));
    writeFileSync(rowPath, JSON.stringify(row, null, 2));

    const result = cli(
      ["--validate", rowPath, "--append", "--detail-dir", detail, "--json"],
      { root },
    );
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.appended, false);
    assert.match(
      output.problems.join(" | "),
      /conditions\.pipeline\.usd cannot be checked; the run detail sums to NaN/,
    );
    assert.match(
      output.problems.join(" | "),
      /conditions\.pipeline\.seconds cannot be checked; the run detail sums to NaN/,
    );
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate applies the schema check without --append", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    // `validateLedgerRow` used to run only inside `appendRow`, so a row the
    // ledger would refuse was reported `ok: true` by the mode whose whole job
    // is to say whether the row is sound.
    const row = makeRow({ matchedIds: scorableIdsFor([1990, 1999]) });
    delete row.inputs.codex_cli;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.problems.join(" | "), /inputs.*codex_cli/);
    // And the same row still fails with --append, without being written.
    const appended = cli(["--validate", rowPath, "--append", "--json"], {
      root,
    });
    assert.equal(appended.status, 1);
    assert.equal(JSON.parse(appended.stdout).appended, false);
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --against rechecks the verdict on the named baseline", () => {
  const root = makeRoot();
  try {
    const baselineRow = makeRow({
      executedAt: "2026-08-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990, 1999]),
      fullMatrix: true,
    });
    const baselinePath = path.join(root, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(baselineRow, null, 2));
    const row = makeRow({
      executedAt: "2026-12-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990, 1999]),
      fullMatrix: true,
    });
    row.verdict = verdict({ contract, row, baselineRow }).verdict;
    row.vs_baseline = buildVsBaseline({
      row,
      baselineRow,
      selection: "explicit",
    });
    const detail = writeRowEvidence(root, row);
    const planPath = path.join(detail, "plan.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.baseline = baselinePlanIdentity(baselineRow);
    writeFileSync(planPath, JSON.stringify(plan));
    const rowPath = path.join(root, "row.json");
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(
      ["--validate", rowPath, "--against", baselinePath, "--append", "--json"],
      { root },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.appended, true);
    assert.equal(output.recomputed_verdict, row.verdict);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --append refuses a complete full row missing a condition", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    for (const name of ["pipeline", "replay", "control"]) {
      // `revalidateRow` recomputes the conditions a row lists, so a condition
      // deleted from an uncommitted row is invisible to it. Appending such a
      // row refreshes the full-run clock and makes it an automatic baseline
      // even though the live pipeline or the model-drift control never ran.
      const row = makeRow({
        matchedIds: scorableIdsFor([1990, 1999]),
        fullMatrix: true,
      });
      delete row.conditions[name];
      row.verdict = verdict({ contract, row }).verdict;
      writeFileSync(rowPath, JSON.stringify(row, null, 2));
      const result = cli(["--validate", rowPath, "--append", "--json"], {
        root,
      });
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.appended, false);
      assert.match(
        output.problems.join(" | "),
        new RegExp(`complete full run but scores no ${name} condition`),
      );
      assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);
    }

    // A condition present but scoring only one PR is the same claim made a
    // different way: pipeline and control cover every fixture in a full run.
    const narrow = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    for (const id of scorableIdsFor([2001])) {
      delete narrow.conditions.control.per_defect[id];
    }
    narrow.conditions.control.recall.opportunities -= scorableIdsFor([
      2001,
    ]).length;
    narrow.conditions.control.p1.opportunities -= p1IdsFor([2001]).length;
    narrow.conditions.control.recall.rate = Number(
      (
        narrow.conditions.control.recall.matched /
        narrow.conditions.control.recall.opportunities
      ).toFixed(3),
    );
    narrow.conditions.control.p1.rate = Number(
      (
        narrow.conditions.control.p1.matched /
        narrow.conditions.control.p1.opportunities
      ).toFixed(3),
    );
    narrow.verdict = verdict({ contract, row: narrow }).verdict;
    writeFileSync(rowPath, JSON.stringify(narrow, null, 2));
    const result = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(result.status, 1);
    assert.match(
      JSON.parse(result.stdout).problems.join(" | "),
      /conditions\.control is a complete full run but scores no defect from PR 2001/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --append refuses a row that dropped a scored PR's frozen defects", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    // The matrix check only asks whether *some* id from each required PR is
    // present, and `revalidateRow` recomputes over the ids the row lists, so a
    // condition that keeps one id per PR reads as a whole matrix whose numbers
    // agree with its own bits — on a recall and McNemar denominator that has
    // quietly shrunk. Only `--check-ledger` refused this, which reports the
    // fault after the row is already committed.
    const allIds = scorableIdsFor(
      contract.fixtures.map((fixture) => fixture.pr),
    );
    const p1 = new Set(
      p1IdsFor(contract.fixtures.map((fixture) => fixture.pr)),
    );
    const row = makeRow({
      matchedIds: scorableIdsFor([1990, 1999]),
      fullMatrix: true,
    });
    const control = row.conditions.control;
    for (const id of scorableIdsFor([1982]).slice(1)) {
      delete control.per_defect[id];
    }
    // Re-derive the condition's own numbers from the bits it still carries, so
    // the shrunken denominator is the only fault the row has left.
    const tally = (ids) => {
      const matched = ids.reduce(
        (total, id) => total + control.per_defect[id][0],
        0,
      );
      return {
        matched,
        opportunities: ids.length,
        rate:
          ids.length === 0 ? null : Number((matched / ids.length).toFixed(3)),
      };
    };
    const kept = allIds.filter((id) => Object.hasOwn(control.per_defect, id));
    control.recall = tally(kept);
    control.p1 = tally(kept.filter((id) => p1.has(id)));
    row.verdict = verdict({ contract, row }).verdict;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.appended, false);
    assert.match(
      output.problems.join(" | "),
      /conditions\.control\.per_defect scored PR 1982 but omits .*; the contract freezes 5 defect\(s\) for that PR/,
    );
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--score refuses a frozen input edited after planning", () => {
  const root = makeRoot();
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: planDir,
      env: planEnv,
    });
    // The contract digest covers the contract JSON, not the files it pins by
    // sha256. Under `--skill-ref` the spec worktree is the live checkout, and a
    // truth file edited during the hours the matrix runs would be scored
    // against under the planned comparability key.
    const truth = path.join(root, contract.fixtures[0].truth_file);
    writeFileSync(truth, `${readFileSync(truth, "utf8")} `);
    const result = cli(["--score", planDir], { root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /a frozen input changed after planning/);
    assert.match(result.stderr, /truth does not match its frozen sha256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--report refuses a row scored against another contract", () => {
  const root = makeRoot();
  try {
    const ledger = path.join(root, ledgerRelative);
    const current = makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990, 1999]),
    });
    // The ledger is append-only, so a contract refresh leaves the rows it
    // scored in place. Their bits came from a different truth index and
    // different thresholds, and the newest row is not necessarily this
    // contract's.
    const archived = {
      ...makeRow({
        executedAt: "2026-12-08T10:00:00Z",
        matchedIds: scorableIdsFor([1990]),
      }),
      contract_digest: "9".repeat(64),
    };
    writeFileSync(
      ledger,
      `${JSON.stringify(current)}\n${JSON.stringify(archived)}\n`,
    );
    const markdown = cli(["--report"], { root });
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /Review-skill eval — 2026-09-08 \(full\)/);

    // Naming the archived row explicitly is refused rather than silently
    // recomputed under this contract.
    const named = cli(["--report", "--row", "2026-12-08"], { root });
    assert.equal(named.status, 1);
    assert.match(named.stderr, /was scored against contract 99999999/);

    // A ledger with no row of this contract has nothing to report.
    writeFileSync(ledger, `${JSON.stringify(archived)}\n`);
    const empty = cli(["--report", "--json"], { root });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /has no row for contract/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--report renders the newest row and pairs it with its baseline", () => {
  const root = makeRoot();
  try {
    const baseline = makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990, 1999]),
    });
    const candidate = makeRow({
      executedAt: "2026-12-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990]),
    });
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseline)}\n${JSON.stringify(candidate)}\n`,
    );
    const markdown = cli(["--report"], { root });
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /Review-skill eval — 2026-12-08 \(full\)/);
    assert.match(markdown.stdout, /McNemar vs 2026-09-08/);

    const json = cli(["--report", "--json"], { root });
    assert.equal(json.status, 0, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.baseline_executed_at, baseline.executed_at);
    assert.ok(["RED", "AMBER", "GREEN", "PROMOTE"].includes(output.verdict));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveBaseline ignores incomparable, incomplete, and later-appended rows", () => {
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  const rows = [
    makeRow({ executedAt: "2026-09-08T10:00:00Z", status: "partial" }),
    makeRow({ executedAt: "2026-10-08T10:00:00Z", key: "c".repeat(64) }),
    makeRow({ executedAt: "2026-11-08T10:00:00Z", kind: "canary" }),
    makeRow({ executedAt: "2027-01-08T10:00:00Z" }),
  ];
  const laterAppended = rows.at(-1);
  const prior = rows.slice(0, -1);
  assert.equal(
    resolveBaseline({ rows: [...prior, row, laterAppended], row }),
    null,
  );
  const usable = makeRow({ executedAt: "2026-11-30T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [...prior, usable, row, laterAppended], row })
      .executed_at,
    usable.executed_at,
  );
});

test("baselineEligibility refuses rows that cannot be paired", () => {
  const usable = makeRow({ fullMatrix: true });
  assert.equal(baselineEligibility(usable).usable, true);
  for (const row of [
    { ...usable, kind: "canary" },
    { ...usable, status: "partial" },
    { ...usable, judge_calibration: { agreement: 33, total: 40 } },
    { ...usable, notes: "leak suspected: reviewer login" },
    {
      ...usable,
      inputs: { ...usable.inputs, skill_ref: "/tmp/candidate", dirty: true },
    },
    { ...usable, conditions: {} },
  ]) {
    assert.equal(baselineEligibility(row).usable, false);
  }
});

test("baseline preflight rejects a wrong key and malformed frozen bits", () => {
  const row = makeRow({ fullMatrix: true });
  assert.deepEqual(
    baselinePreflightProblems({
      row,
      contract,
      contractDigest,
      planComparabilityKey: row.comparability_key,
      candidateExecutedAt: "2026-10-08T10:00:00Z",
    }),
    [],
  );
  assert.match(
    baselinePreflightProblems({
      row,
      contract,
      contractDigest,
      planComparabilityKey: "f".repeat(64),
      candidateExecutedAt: "2026-10-08T10:00:00Z",
    }).join(" | "),
    /comparability_key does not match the generated plan/,
  );
  const malformed = JSON.parse(JSON.stringify(row));
  const [id] = Object.keys(malformed.conditions.pipeline.per_defect);
  malformed.conditions.pipeline.per_defect[id] = "found";
  assert.match(
    baselinePreflightProblems({
      row: malformed,
      contract,
      contractDigest,
      planComparabilityKey: malformed.comparability_key,
      candidateExecutedAt: "2026-10-08T10:00:00Z",
    }).join(" | "),
    /must be a non-empty array/,
  );
  assert.match(
    baselinePreflightProblems({
      row,
      contract,
      contractDigest,
      planComparabilityKey: row.comparability_key,
      candidateExecutedAt: row.executed_at,
    }).join(" | "),
    /must precede the generated plan's candidate timestamp/,
  );
});

test("resolveBaseline uses the same eligibility rule as an explicit baseline", () => {
  const empty = {
    ...makeRow({ executedAt: "2026-09-08T10:00:00Z" }),
    conditions: {},
  };
  const clean = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  const emptyPromotion = {
    ...makeRow({
      executedAt: "2026-11-08T10:00:00Z",
      verdict: "PROMOTE",
    }),
    conditions: {},
  };
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  assert.equal(resolveBaseline({ rows: [empty], row }), null);
  assert.equal(
    resolveBaseline({ rows: [empty, clean, emptyPromotion], row }).executed_at,
    clean.executed_at,
  );
});

test("resolveBaseline anchors on the first full row until a PROMOTE re-anchors", () => {
  const anchor = makeRow({ executedAt: "2026-09-08T10:00:00Z" });
  const later = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  // Pairing against the previous run would hide a slide that never trips the
  // per-run flip threshold, so the anchor is the baseline of record.
  assert.equal(
    resolveBaseline({ rows: [anchor, later], row }).executed_at,
    anchor.executed_at,
  );
  // The runbook moves the anchor in exactly one place: a reviewed PROMOTE row.
  const promoted = makeRow({
    executedAt: "2026-11-08T10:00:00Z",
    verdict: "PROMOTE",
  });
  const older = makeRow({
    executedAt: "2026-10-20T10:00:00Z",
    verdict: "PROMOTE",
  });
  assert.equal(
    resolveBaseline({ rows: [anchor, older, later, promoted], row })
      .executed_at,
    promoted.executed_at,
  );
});

test("resolveBaseline keeps append order when a later row is backdated", () => {
  const anchor = makeRow({ executedAt: "2026-09-08T10:00:00Z" });
  const backdated = makeRow({ executedAt: "2026-08-08T10:00:00Z" });
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [anchor, backdated, row], row }).executed_at,
    anchor.executed_at,
  );
});

test("resolveBaseline finds a deserialized ledger row by stable identity", () => {
  const anchor = makeRow({ executedAt: "2026-09-08T10:00:00Z" });
  const row = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  const promoted = makeRow({
    executedAt: "2026-11-08T10:00:00Z",
    verdict: "PROMOTE",
  });
  const clone = JSON.parse(JSON.stringify(row));
  assert.equal(
    resolveBaseline({ rows: [anchor, row, promoted], row: clone }).executed_at,
    anchor.executed_at,
  );
});

test("resolveBaseline excludes future ledger anchors from an external row", () => {
  const anchor = makeRow({ executedAt: "2026-09-08T10:00:00Z" });
  const external = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  const futurePromotion = makeRow({
    executedAt: "2026-11-08T10:00:00Z",
    verdict: "PROMOTE",
  });
  assert.equal(
    resolveBaseline({ rows: [anchor, futurePromotion], row: external })
      .executed_at,
    anchor.executed_at,
  );
});

test("resolveBaseline rejects a malformed instant on an external row", () => {
  const anchor = makeRow({ executedAt: "2026-02-28T10:00:00Z" });
  const external = makeRow({ executedAt: "2026-02-31T10:00:00Z" });
  assert.equal(resolveBaseline({ rows: [anchor], row: external }), null);
});

test("resolveBaseline excludes a malformed external baseline candidate", () => {
  const anchor = makeRow({ executedAt: "2026-02-01T10:00:00Z" });
  const malformedPromotion = makeRow({
    executedAt: "2026-02-31T10:00:00Z",
    verdict: "PROMOTE",
  });
  const external = makeRow({ executedAt: "2026-04-01T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [anchor, malformedPromotion], row: external })
      .executed_at,
    anchor.executed_at,
  );
});

test("an automatic baseline ranks a later-appended backdated row", () => {
  const ids = scorableIdsFor(contract.fixtures.map((fixture) => fixture.pr));
  const p1 = new Set(p1IdsFor(contract.fixtures.map((fixture) => fixture.pr)));
  const lost = ids.filter((id) => !p1.has(id)).slice(0, 6);
  const anchor = makeRow({
    executedAt: "2026-09-08T10:00:00Z",
    matchedIds: ids,
  });
  const row = makeRow({
    executedAt: "2026-08-08T10:00:00Z",
    matchedIds: ids.filter((id) => !lost.includes(id)),
  });
  const decision = verdict({
    contract,
    row,
    baselineRow: anchor,
    baselineIsExplicit: false,
  });
  assert.equal(decision.verdict, "RED");
  assert.match(decision.reasons.join(" | "), /lost a net 6 defects/);
});

test("resolveBaseline refuses a row whose judge calibration failed", () => {
  // The runbook excludes an under-calibrated row from baseline comparison, and
  // an anchor is the comparison every later run is paired against: bits a
  // judge that failed its own replay produced must not become the record.
  const drifted = {
    ...makeRow({ executedAt: "2026-09-08T10:00:00Z" }),
    judge_calibration: { agreement: 33, total: 40 },
  };
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  assert.equal(resolveBaseline({ rows: [drifted], row }), null);

  const clean = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [drifted, clean], row }).executed_at,
    clean.executed_at,
  );
  // Nor may it re-anchor as a PROMOTE row.
  const promoted = {
    ...makeRow({ executedAt: "2026-11-08T10:00:00Z", verdict: "PROMOTE" }),
    judge_calibration: { agreement: 30, total: 40 },
  };
  assert.equal(
    resolveBaseline({ rows: [drifted, clean, promoted], row }).executed_at,
    clean.executed_at,
  );
});

test("resolveBaseline refuses a row whose notes record a leak", () => {
  // A leaked row's own verdict is already capped at AMBER, but as an anchor it
  // would set the denominator of every flip count after it: each later clean
  // run would be ranked against bits the run may have read from the answer key
  // rather than found, and score as a regression for it.
  const leaked = {
    ...makeRow({ executedAt: "2026-09-08T10:00:00Z" }),
    notes: "leak suspected: transcript names PR 1999",
  };
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  assert.equal(resolveBaseline({ rows: [leaked], row }), null);

  const clean = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [leaked, clean], row }).executed_at,
    clean.executed_at,
  );
  // Nor may it re-anchor as a PROMOTE row.
  const promoted = {
    ...makeRow({ executedAt: "2026-11-08T10:00:00Z", verdict: "PROMOTE" }),
    notes: "leak_suspected: PR number in transcript",
  };
  assert.equal(
    resolveBaseline({ rows: [leaked, clean, promoted], row }).executed_at,
    clean.executed_at,
  );
});

test("resolveBaseline refuses a candidate row as the installed anchor", () => {
  // A `--skill-ref` run measured a working copy, and a rejected candidate
  // leaves the installed skill untouched. Anchoring on it would make that
  // experiment the denominator of every flip counted for the installed skill
  // after it. The runbook's comparison — candidate against installed — is what
  // `--against` names explicitly; automatic selection stays on the lineage.
  const asCandidate = (base) => ({
    ...base,
    inputs: {
      ...base.inputs,
      skill_ref: "/Users/eng/skills/review-candidate",
      dirty: true,
    },
  });
  const candidate = asCandidate(
    makeRow({ executedAt: "2026-09-08T10:00:00Z" }),
  );
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  assert.equal(resolveBaseline({ rows: [candidate], row }), null);

  const installed = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [candidate, installed], row }).executed_at,
    installed.executed_at,
  );
  // Nor may it re-anchor as a PROMOTE row.
  const promoted = asCandidate(
    makeRow({ executedAt: "2026-11-08T10:00:00Z", verdict: "PROMOTE" }),
  );
  assert.equal(
    resolveBaseline({ rows: [candidate, installed, promoted], row })
      .executed_at,
    installed.executed_at,
  );
});

test("--validate reports a malformed per_defect vector instead of throwing", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    const row = makeRow({ matchedIds: scorableIdsFor([1990]) });
    const [first] = Object.keys(row.conditions.pipeline.per_defect);
    // A scalar where a bit vector belongs: `--validate` reads a row file it did
    // not write, so this is a problem to report, not a `.join is not a
    // function` stack trace in place of the problem list.
    row.conditions.pipeline.per_defect[first] = 1;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(
      output.problems.some((problem) =>
        /per_defect must map each defect to a non-empty array/.test(problem),
      ),
      output.problems.join(" | "),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--score refuses a calibration set the plan never hashed", () => {
  const root = makeRoot();
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: planDir,
      env: planEnv,
    });
    assert.match(plan.calibration_digest, /^[0-9a-f]{64}$/);
    const other = path.join(root, "other-calibration.json");
    writeFileSync(
      other,
      `${readFileSync(path.join(root, "docs/evals/review-skill-judge-calibration.json"), "utf8")} `,
    );
    const result = cli(
      ["--score", planDir, "--calibration", "other-calibration.json"],
      { root },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /plan was written against calibration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPlan hashes the calibration set under --root, not its own checkout", () => {
  const root = makeRoot();
  try {
    // `--score` resolves the calibration set under `--root`. Hashing this
    // module's own checkout instead keys the plan to one set and scores it with
    // another the moment the two trees differ, which is what the orchestrator's
    // spec worktree does by design.
    const underRoot = path.join(
      root,
      "docs/evals/review-skill-judge-calibration.json",
    );
    const edited = JSON.parse(readFileSync(underRoot, "utf8"));
    edited.records = edited.records.slice(0, 3);
    writeFileSync(underRoot, `${JSON.stringify(edited, null, 2)}\n`);
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "plan"),
      env: planEnv,
      write: false,
    });
    assert.equal(
      plan.calibration_digest,
      createHash("sha256").update(readFileSync(underRoot)).digest("hex"),
    );
    assert.notEqual(
      plan.calibration_digest,
      createHash("sha256")
        .update(
          readFileSync(
            path.join(
              repoRoot,
              "docs/evals/review-skill-judge-calibration.json",
            ),
          ),
        )
        .digest("hex"),
    );
    // The key moves with it, so a row planned under one set never pairs with a
    // row planned under another.
    assert.notEqual(
      plan.comparability_key,
      comparabilityKey({ contract, contractDigest }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--score refuses a plan whose scorer changed after planning", () => {
  const root = makeRoot();
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: planDir,
      env: planEnv,
      write: false,
    });
    // The recheck must accept an untouched plan: it recomputes the key exactly
    // as `buildPlan` derived it, so a mismatch means the spec really moved.
    assert.equal(plan.matcher_digest, scorerDigest());
    assert.equal(
      plan.comparability_key,
      comparabilityKey({
        contract,
        contractDigest,
        matcherDigest: scorerDigest(),
        calibrationDigest: plan.calibration_digest,
      }),
    );
    // A full run takes hours and `--skill-ref` points the spec at the live
    // checkout, so a scorer module edited mid-run would score these cells with
    // new code under the planned comparability key.
    const stale = { ...plan, matcher_digest: "0".repeat(64) };
    writeFileSync(
      path.join(planDir, "plan.json"),
      JSON.stringify(stale, null, 2),
    );
    const result = cli(["--score", planDir], { root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /plan was written against scorer 00000000/);

    // A plan whose scorer digest still matches but whose key does not is
    // refused too: the key also binds the judge model and the frozen prompts.
    writeFileSync(
      path.join(planDir, "plan.json"),
      JSON.stringify({ ...plan, comparability_key: "1".repeat(64) }, null, 2),
    );
    const keyed = cli(["--score", planDir], { root });
    assert.equal(keyed.status, 1);
    assert.match(keyed.stderr, /plan carries comparability_key 11111111/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the row records the finder command a cell runs, not an unrun wrapper", () => {
  const plan = buildPlan({
    contract,
    contractDigest,
    kind: "full",
    repoRoot,
    write: false,
    env: planEnv,
  });
  // `codex_review_sh_digest` recorded `~/.claude/bin/codex-review.sh`, which no
  // cell ever executes: it claimed a drift control the harness did not have.
  // The pipeline cells spawn the contract's argv, so that is what is digested.
  assert.equal(
    plan.inputs.finder_argv_digest,
    createHash("sha256")
      .update(JSON.stringify(contract.sut.finder.argv))
      .digest("hex"),
  );
  assert.ok(!Object.hasOwn(plan.inputs, "codex_review_sh_digest"));
  const pipeline = plan.cells.find((cell) => cell.condition === "pipeline");
  assert.deepEqual(pipeline.finder_argv, contract.sut.finder.argv);
});

test("--schedule-issue stays silent while the ledger is fresh", () => {
  const root = makeRoot();
  try {
    const row = makeRow({ executedAt: "2027-05-30T10:00:00Z" });
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    const result = cli(
      ["--schedule-issue", "--json", "--dry-run", "--date", "2027-06-01"],
      { root },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).action, "skip-fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runScheduleIssue creates one issue per contract month and then keeps it", async () => {
  const root = makeRoot();
  try {
    const options = {
      ledgerPath: ledgerRelative,
      repo: "mento-protocol/monitoring-monorepo",
      date: "2027-06-01",
      dryRun: false,
    };
    const context = { repoRoot: root, contract, contractDigest };
    const created = [];
    const deps = {
      listIssues: async () => [],
      authorize: async () => {},
      ensureLabels: async () => {},
      createIssue: async (_options, payload) => created.push(payload),
    };
    const first = await runScheduleIssue(options, context, deps);
    assert.equal(first.action, "create");
    assert.equal(first.mutated, true);
    assert.equal(created.length, 1);
    assert.match(created[0].title, /Review-skill eval is stale/);

    const open = [
      {
        number: 42,
        state: "OPEN",
        marker: { month: "2027-06", contract_digest: contractDigest },
      },
    ];
    const second = await runScheduleIssue(options, context, {
      ...deps,
      listIssues: async () => open,
    });
    assert.equal(second.action, "keep-current");
    assert.equal(second.mutated, false);
    assert.equal(created.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planStalenessIssueSync skips a completed month and a foreign digest", () => {
  const payload = { title: "t", body: "b", labels: [] };
  const closed = planStalenessIssueSync({
    month: "2027-06",
    contractDigest,
    issues: [
      {
        number: 7,
        state: "CLOSED",
        marker: { month: "2027-06", contract_digest: contractDigest },
      },
    ],
    payload,
  });
  assert.equal(closed.action, "skip-complete");
  const drifted = planStalenessIssueSync({
    month: "2027-06",
    contractDigest,
    issues: [
      {
        number: 8,
        state: "OPEN",
        marker: { month: "2027-06", contract_digest: "e".repeat(64) },
      },
    ],
    payload,
  });
  assert.equal(drifted.action, "skip-prior-open");
});

test("live issue creation is restricted to the freshness workflow", () => {
  const options = { repo: "mento-protocol/monitoring-monorepo" };
  assert.throws(
    () => assertAuthorizedFreshnessWorkflow(options, { env: {} }),
    /restricted to the review-eval freshness workflow/,
  );
  assert.throws(
    () =>
      assertAuthorizedFreshnessWorkflow(options, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/heads/main",
          GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/main`,
        },
      }),
    /restricted/,
  );
  // A dispatch can name any branch, so it never authorizes an issue write.
  assert.throws(
    () =>
      assertAuthorizedFreshnessWorkflow(options, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/main",
          GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/main`,
        },
      }),
    /restricted/,
  );
  // The ref is pinned to the default branch, not to whatever the run reports.
  assert.throws(
    () =>
      assertAuthorizedFreshnessWorkflow(options, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "schedule",
          GITHUB_REF: "refs/heads/attacker",
          GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/attacker`,
        },
      }),
    /restricted/,
  );
  assert.doesNotThrow(() =>
    assertAuthorizedFreshnessWorkflow(options, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_REF: "refs/heads/main",
        GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/main`,
      },
    }),
  );
});

/** A git stand-in: one handler per subcommand, everything else fails. */
function fakeGit(handlers) {
  const calls = [];
  const run = (binary, args) => {
    calls.push(args.join(" "));
    const handler = handlers[args[0]];
    return handler ? handler(args) : { status: 128, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

const OK = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const FAILED = { status: 128, stdout: "", stderr: "fatal" };

test("baseLedgerRows separates an unresolvable ref from an absent ledger", () => {
  const args = {
    repoRoot: "/tmp/repo",
    baseRef: "origin/main",
    ledgerPath: ledgerRelative,
  };
  const unresolvable = baseLedgerRows({
    ...args,
    run: fakeGit({ "rev-parse": () => FAILED }),
  });
  assert.equal(unresolvable.rows, null);
  assert.equal(unresolvable.resolved, false);
  assert.match(unresolvable.reason, /does not resolve/);

  // The ref resolves and the ledger is simply not committed there yet: a
  // bootstrap branch, not a failure.
  const bootstrap = baseLedgerRows({
    ...args,
    run: fakeGit({
      "rev-parse": () => OK("commit\n"),
      "merge-base": () => OK("aaaa111\n"),
      show: () => FAILED,
    }),
  });
  assert.equal(bootstrap.rows, null);
  assert.equal(bootstrap.resolved, true);
  assert.match(bootstrap.reason, /does not exist at aaaa111/);
});

test("baseLedgerRows reads the merge base, and falls back to the tip", () => {
  const row = makeRow();
  const args = {
    repoRoot: "/tmp/repo",
    baseRef: "origin/main",
    ledgerPath: ledgerRelative,
  };
  const merged = fakeGit({
    "rev-parse": () => OK("commit\n"),
    "merge-base": () => OK("aaaa111\n"),
    show: () => OK(`${JSON.stringify(row)}\n`),
  });
  const fromMergeBase = baseLedgerRows({ ...args, run: merged });
  assert.equal(fromMergeBase.mode, "merge-base");
  assert.equal(fromMergeBase.base, "aaaa111");
  assert.equal(fromMergeBase.rows.length, 1);
  assert.ok(merged.calls.includes(`show aaaa111:${ledgerRelative}`));

  const detached = fakeGit({
    "rev-parse": () => OK("commit\n"),
    "merge-base": () => FAILED,
    show: () => OK(`${JSON.stringify(row)}\n`),
  });
  const fromTip = baseLedgerRows({ ...args, run: detached });
  assert.equal(fromTip.mode, "tip");
  assert.equal(fromTip.base, "origin/main");
  assert.ok(detached.calls.includes(`show origin/main:${ledgerRelative}`));
});

test("--check-ledger --require-base fails when the base ref does not resolve", () => {
  const root = makeRoot();
  try {
    const flags = ["--base-ref", "refs/heads/no-such-base", "--json"];
    const lenient = cli(["--check-ledger", ...flags], { root });
    assert.equal(lenient.status, 0, lenient.stderr);
    const skipped = JSON.parse(lenient.stdout);
    assert.equal(skipped.ok, true);
    assert.equal(skipped.append_only_base, null);
    assert.match(skipped.append_only_reason, /does not resolve/);

    const strict = cli(["--check-ledger", "--require-base", ...flags], {
      root,
    });
    assert.equal(strict.status, 1);
    const failed = JSON.parse(strict.stdout);
    assert.equal(failed.ok, false);
    assert.ok(
      failed.problems.some((problem) => /does not resolve/.test(problem)),
      JSON.stringify(failed.problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A judge stand-in. It never leaves the process and never calls a model. */
function stubExec({ matchAll = true } = {}) {
  const calls = [];
  return {
    calls,
    exec: async ({ prompt }) => {
      calls.push(prompt);
      if (prompt.startsWith("Below is a code review.")) {
        return JSON.stringify(["claim one", "claim two"]);
      }
      if (prompt.startsWith("You are matching a code review")) {
        // Only the DEFECTS block numbers defects. Scanning the whole prompt
        // also picks up numbered lines inside a defect's detail or inside the
        // review, and answering with an index the prompt never offered is what
        // `requireMatches` now refuses — a stub must not need that licence.
        const defects = prompt.slice(
          prompt.indexOf("<<<DEFECTS"),
          prompt.indexOf("\nDEFECTS\n"),
        );
        // `defectBlock` writes each header as `N. [severity] path:line — title`.
        const indexes = [...defects.matchAll(/^(\d+)\. \[/gm)].map((match) =>
          Number(match[1]),
        );
        return JSON.stringify({
          matches: matchAll ? indexes : [],
          reasoning: Object.fromEntries(
            indexes.map((index) => [String(index), "same defect"]),
          ),
        });
      }
      return JSON.stringify({
        verdicts: { 1: { class: "real" }, 2: { class: "wrong" } },
      });
    },
  };
}

/**
 * A git stand-in for the scoring path. On an operator machine the fixture a
 * cell names is a real checkout that scoring resets before the judge reads it;
 * here it is a temporary directory, so git answers from this instead.
 */
function stubGit({ failOn = null } = {}) {
  const calls = [];
  // A real checkout answers `rev-parse HEAD` with whatever the last checkout
  // landed on, and the scoring reset reads that back to prove it landed, so
  // the stub has to model the head rather than answer the empty string.
  let head = "";
  return {
    calls,
    runGit: ({ args, cwd }) => {
      calls.push({ args, cwd });
      const status = args[0] === failOn ? 128 : args[0] === "grep" ? 1 : 0;
      if (args[0] === "checkout" && status === 0) head = args.at(-1);
      const stdout = args[0] === "rev-parse" ? `${head}\n` : "";
      return { status, stdout, stderr: "" };
    },
  };
}

test("scorePlan folds stubbed cells into a schema-valid ledger row", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          fingerprint: cellFingerprint({ plan }),
          output: `scripts/pr/pr-ready-state-core.mjs:750 is too long.`,
          seconds: 300,
          cost_usd: 3.5,
          fixture_path: root,
        }),
      );
    }
    const { exec } = stubExec();
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    assert.deepEqual(validateLedgerRow(scored.row), []);
    assert.equal(scored.row.kind, "canary");
    assert.equal(scored.row.status, "complete");
    assert.deepEqual(scored.missing, []);
    assert.equal(Object.keys(scored.row.conditions).length, 1);
    const replay = scored.row.conditions.replay;
    assert.equal(replay.draws, 1);
    assert.equal(replay.recall.opportunities, 22);
    assert.equal(replay.usd, 10.5);
    assert.equal(replay.novel_real, 3);
    assert.equal(replay.wrong_claims, 3);
    assert.equal(
      readLedger(path.join(root, ledgerRelative)).length,
      0,
      "scoring never writes the ledger",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan freezes truth before the calibration pass", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const fixture = contract.fixtures.find(
      (candidate) => candidate.pr === plan.cells[0].pr,
    );
    const truthFile = path.join(root, fixture.truth_file);
    const originalTruth = JSON.parse(readFileSync(truthFile, "utf8"));
    for (const cell of plan.cells) {
      writeCell(plan, cell, {
        output: `scripts/pr/pr-ready-state-core.mjs:750 is too long. ${originalTruth.last_head}`,
        root,
      });
    }
    const inner = stubExec().exec;
    let changed = false;
    const exec = async (request) => {
      if (!changed) {
        changed = true;
        writeFileSync(truthFile, JSON.stringify({ findings: [] }));
      }
      return inner(request);
    };
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    const frozenBits = fixture.scorable_ids.flatMap(
      (id) => scored.row.conditions.replay.per_defect[String(id)] ?? [],
    );
    assert.ok(frozenBits.some((bit) => bit === 1));
    assert.match(scored.row.notes, /withheld commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan verifies the exact truth bytes it snapshots", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      writeCell(plan, cell, { output: "nothing looks wrong here", root });
    }
    const fixture = contract.fixtures.find(
      (candidate) => candidate.pr === plan.cells[0].pr,
    );
    const truthFile = path.join(root, fixture.truth_file);
    writeFileSync(truthFile, `${readFileSync(truthFile, "utf8")} `);
    let modelCalls = 0;
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec: async () => {
          modelCalls += 1;
          throw new Error("model must not run");
        },
        runGit: stubGit().runGit,
        calibrationSet: JSON.parse(
          readFileSync(
            path.join(root, "docs/evals/review-skill-judge-calibration.json"),
            "utf8",
          ),
        ),
      }),
      /truth .* changed after frozen-input verification/,
    );
    assert.equal(modelCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the login exclusions are snapshotted before the tool-bearing judge", async () => {
  // The novelty judge runs with `Bash` inside the fixture. Fixture content that
  // prompt-injects it into writing a reviewer login into a tracked file would,
  // if the exclusion scan ran afterwards, have that login treated as original
  // fixture content — and a transcript naming the reviewer would then evade the
  // hard leak signal. The scan therefore runs on the tree `resetFixture` just
  // restored, before any judge call.
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const fixture = contract.fixtures.find(
      (candidate) => candidate.pr === plan.cells[0].pr,
    );
    const truth = JSON.parse(
      readFileSync(path.join(root, fixture.truth_file), "utf8"),
    );
    const login = truth.findings[0].author;
    for (const cell of plan.cells) {
      writeCell(plan, cell, {
        output: `I read the review ${login} left on this change.`,
        root,
      });
    }
    // The novelty judge — the only judge that runs inside the fixture — writes
    // the login into a tracked file: from its first call on, a `git grep` for
    // that login succeeds.
    const { exec: inner } = stubExec();
    let judged = false;
    const exec = async (request) => {
      const answer = await inner(request);
      // Only the novelty judge runs in the fixture; the blind judges get a
      // scratch directory.
      if (request.cwd === root) judged = true;
      return answer;
    };
    let head = "";
    const runGit = ({ args }) => {
      if (args[0] === "checkout") head = args.at(-1);
      if (args[0] === "rev-parse")
        return { status: 0, stdout: `${head}\n`, stderr: "" };
      if (args[0] !== "grep") return { status: 0, stdout: "", stderr: "" };
      return { status: judged ? 0 : 1, stdout: "", stderr: "" };
    };
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    assert.match(scored.row.notes, /leak suspected/);
    assert.ok(
      scored.row.notes.includes(`names reviewer ${login}`),
      scored.row.notes,
    );
    assert.equal(scored.row.verdict, "AMBER");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a PR that ran fewer draws loses opportunities, not recall", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "full",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const both = contract.fixtures[0];
    const single = contract.fixtures[1];
    const firstScorable = (fixture) => {
      const truth = JSON.parse(
        readFileSync(path.join(root, fixture.truth_file), "utf8"),
      );
      return truth.findings.find((finding) =>
        fixture.scorable_ids.includes(finding.id),
      );
    };
    const hit = {
      [both.pr]: firstScorable(both),
      [single.pr]: firstScorable(single),
    };
    // PR `both` runs draws 1 and 2; PR `single` runs draw 1 only. Every other
    // cell of the matrix is missing, exactly as a deadline or an abort leaves it.
    const ran = plan.cells.filter(
      (cell) =>
        cell.condition === "pipeline" &&
        (cell.pr === both.pr || (cell.pr === single.pr && cell.draw === 1)),
    );
    assert.equal(ran.length, 3);
    for (const cell of ran) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      const finding = hit[cell.pr];
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          fingerprint: cellFingerprint({ plan }),
          output: `${finding.path}:${finding.line} is wrong.`,
          seconds: 300,
          cost_usd: 3.5,
          fixture_path: root,
        }),
      );
    }
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec: stubExec().exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    const pipeline = scored.row.conditions.pipeline;
    assert.equal(pipeline.draws, 2);
    for (const id of both.scorable_ids) {
      assert.equal(pipeline.per_defect[String(id)].length, 2, `defect ${id}`);
    }
    for (const id of single.scorable_ids) {
      assert.equal(pipeline.per_defect[String(id)].length, 1, `defect ${id}`);
    }
    // The defect PR `single` did find is a 1 and nothing else: the draw it
    // never ran contributes no bit, so no false zero follows it.
    assert.deepEqual(pipeline.per_defect[String(hit[single.pr].id)], [1]);
    assert.equal(
      pipeline.recall.opportunities,
      both.scorable_ids.length * 2 + single.scorable_ids.length,
    );
    assert.deepEqual(validateLedgerRow(scored.row), []);
    // The ledger's own recompute reads the per-cell detail and must fold it the
    // same way, or `--validate --append` would refuse every partial run.
    const revalidated = revalidateRow({
      contract,
      row: scored.row,
      repoRoot: root,
      detailDir: plan.plan_dir,
    });
    assert.deepEqual(revalidated.problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan binds an eligible explicit baseline before model work", async () => {
  const root = makeRoot();
  try {
    const baseline = makeRow({
      executedAt: "2026-08-01T10:00:00Z",
      fullMatrix: true,
    });
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      baselineRow: baseline,
      env: planEnv,
    });
    for (const cell of plan.cells) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          fingerprint: cellFingerprint({ plan }),
          output: "scripts/pr/pr-ready-state-core.mjs:750 is too long.",
          seconds: 300,
          cost_usd: 3.5,
          fixture_path: root,
        }),
      );
    }
    const calibrationSet = JSON.parse(
      readFileSync(
        path.join(root, "docs/evals/review-skill-judge-calibration.json"),
        "utf8",
      ),
    );
    const score = (baselineRow) =>
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec: stubExec().exec,
        runGit: stubGit().runGit,
        calibrationSet,
        baselineRow,
      });

    const paired = await score(baseline);
    assert.deepEqual(validateLedgerRow(paired.row), []);
    assert.equal(paired.row.vs_baseline.selection, "explicit");
    assert.equal(typeof paired.row.vs_baseline.mcnemar.delta, "number");

    await assert.rejects(
      score(makeRow()),
      /plan baseline .* does not match score baseline/,
    );
    await assert.rejects(
      score(null),
      /plan baseline_selection is explicit; this score command is automatic/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan rejects an ineligible explicit baseline before model work", async () => {
  const root = makeRoot();
  try {
    const baseline = makeRow({
      executedAt: "2026-08-01T10:00:00Z",
      status: "partial",
    });
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      baselineRow: baseline,
      env: planEnv,
    });
    let modelCalls = 0;
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec: async () => {
          modelCalls += 1;
          throw new Error("model must not run");
        },
        calibrationSet: JSON.parse(
          readFileSync(
            path.join(root, "docs/evals/review-skill-judge-calibration.json"),
            "utf8",
          ),
        ),
        baselineRow: baseline,
      }),
      /explicit baseline is not eligible.*complete full run/s,
    );
    assert.equal(modelCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan rejects altered plan inputs before model work", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          fingerprint: cellFingerprint({ plan }),
          output: "nothing looks wrong here",
          seconds: 10,
          cost_usd: 0.5,
          fixture_path: root,
        }),
      );
    }
    let modelCalls = 0;
    const score = (digest = contractDigest) =>
      scorePlan({
        plan,
        contract,
        contractDigest: digest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec: async () => {
          modelCalls += 1;
          throw new Error("model must not run");
        },
        calibrationSet: JSON.parse(
          readFileSync(
            path.join(root, "docs/evals/review-skill-judge-calibration.json"),
            "utf8",
          ),
        ),
      });
    await assert.rejects(
      score("f".repeat(64)),
      /plan contract digest does not match the scoring contract/,
    );
    assert.equal(modelCalls, 0);

    plan.cells[0].model = `${plan.cells[0].model}-altered`;
    await assert.rejects(
      score(),
      /plan cells do not match the frozen canary matrix/,
    );
    assert.equal(modelCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan resolves an automatic baseline by ledger append order", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          fingerprint: cellFingerprint({ plan }),
          output: "scripts/pr/pr-ready-state-core.mjs:750 is too long.",
          seconds: 300,
          cost_usd: 3.5,
          fixture_path: root,
        }),
      );
    }
    const anchor = makeRow({
      executedAt: "2026-10-08T10:00:00Z",
      fullMatrix: true,
    });
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec: stubExec().exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
      ledgerRows: [anchor],
      now: new Date("2026-09-08T10:00:00Z"),
    });
    assert.equal(
      scored.row.vs_baseline.baseline_executed_at,
      anchor.executed_at,
    );
    assert.equal(scored.row.vs_baseline.selection, "automatic");

    // The local append validates the row at its pending ledger position. The
    // anchor's clock is later than this row, so treating the row as external
    // would exclude the established anchor and recompute the wrong verdict.
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(anchor)}\n`,
    );
    const rowPath = path.join(plan.plan_dir, "row.json");
    writeFileSync(rowPath, JSON.stringify(scored.row));
    const appended = cli(
      [
        "--validate",
        rowPath,
        "--append",
        "--detail-dir",
        plan.plan_dir,
        "--json",
      ],
      { root },
    );
    assert.equal(appended.status, 0, appended.stdout + appended.stderr);
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan reports a partial matrix and refuses an empty one", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const { exec } = stubExec({ matchAll: false });
    const calibrationSet = JSON.parse(
      readFileSync(
        path.join(root, "docs/evals/review-skill-judge-calibration.json"),
        "utf8",
      ),
    );
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec,
        runGit: stubGit().runGit,
        calibrationSet,
      }),
      /no completed cell results/,
    );

    const cell = plan.cells[0];
    const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
    mkdirSync(dir, { recursive: true });
    const canonicalFingerprint = cellFingerprint({ plan });
    writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({
        ok: true,
        fingerprint: { ...canonicalFingerprint, legacy: true },
        output: "nothing looks wrong here",
        seconds: 10,
        cost_usd: 0.5,
        fixture_path: root,
      }),
    );
    let invalidFingerprintCalls = 0;
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec: async () => {
          invalidFingerprintCalls += 1;
          throw new Error("model must not run");
        },
        runGit: stubGit().runGit,
        calibrationSet,
      }),
      /fingerprint carries unexpected legacy/,
    );
    assert.equal(invalidFingerprintCalls, 0);

    const reorderedFingerprint = Object.fromEntries(
      Object.entries(canonicalFingerprint).reverse(),
    );
    writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({
        ok: true,
        fingerprint: reorderedFingerprint,
        output: "nothing looks wrong here",
        seconds: 10,
        cost_usd: 0.5,
        fixture_path: root,
      }),
    );
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: stubGit().runGit,
      calibrationSet,
    });
    assert.equal(scored.row.status, "partial");
    assert.equal(scored.missing.length, 2);
    assert.match(scored.row.notes, /2 cell\(s\) missing/);
    const scoredResult = JSON.parse(
      readFileSync(
        path.join(
          plan.plan_dir,
          `result-${cell.pr}-${cell.condition}-${cell.draw}.json`,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(scoredResult.fingerprint, canonicalFingerprint);
    assert.deepEqual(scoredResult.treatment, treatmentIdentity({ plan }));
    const scoredCalibration = JSON.parse(
      readFileSync(path.join(plan.plan_dir, "calibration.json"), "utf8"),
    );
    assert.deepEqual(scoredCalibration.fingerprint, canonicalFingerprint);
    assert.deepEqual(scoredCalibration.treatment, treatmentIdentity({ plan }));
    // A canary that did not finish never ranks, not even as a pass.
    assert.equal(scored.row.verdict, "INCOMPLETE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write one stubbed cell result under a plan directory. */
function writeCell(plan, cell, { output, root, usd = 3.5 }) {
  const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({
      ok: true,
      fingerprint: cellFingerprint({ plan }),
      output,
      seconds: 300,
      cost_usd: usd,
      fixture_path: root,
    }),
  );
}

test("a PR is zero-finding only when every draw it ran found nothing", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "full",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const [quiet, mixed] = contract.fixtures.map((fixture) => fixture.pr);
    const cells = plan.cells.filter(
      (cell) =>
        cell.condition === "pipeline" && [quiet, mixed].includes(cell.pr),
    );
    assert.equal(cells.length, 4);
    for (const cell of cells) {
      // `mixed` finds nothing on draw 1 and reviews on draw 2; `quiet` finds
      // nothing on either draw. Only `quiet` found nothing on its PR.
      const empty = cell.pr === quiet || cell.draw === 1;
      writeCell(plan, cell, {
        root,
        output: empty ? "" : "scripts/review/run-eval.sh:150 is wrong.",
      });
    }
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec: stubExec().exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    const pipeline = scored.row.conditions.pipeline;
    assert.equal(pipeline.zero_finding_prs, 1);
    assert.deepEqual(validateLedgerRow(scored.row), []);
    // Two zero-finding PRs are RED, so counting one empty draw per PR would
    // red a run on the strength of a PR it did review.
    assert.ok(
      !scored.reasons.some((reason) =>
        /emitted no parseable finding on 2 PRs/.test(reason),
      ),
      JSON.stringify(scored.reasons),
    );

    // `--validate` derives both RED-capable counters from the run detail, so
    // an edited counter cannot ride along on the row's own say-so.
    const honest = revalidateRow({
      contract,
      row: scored.row,
      repoRoot: root,
      detailDir: plan.plan_dir,
    });
    assert.deepEqual(honest.problems, []);
    const tampered = structuredClone(scored.row);
    tampered.conditions.pipeline.wrong_claims += 5;
    tampered.conditions.pipeline.zero_finding_prs = 0;
    const caught = revalidateRow({
      contract,
      row: tampered,
      repoRoot: root,
      detailDir: plan.plan_dir,
    });
    assert.equal(caught.ok, false);
    assert.ok(
      caught.problems.some((problem) => problem.includes("wrong_claims is")),
      JSON.stringify(caught.problems),
    );
    assert.ok(
      caught.problems.some((problem) =>
        problem.includes("zero_finding_prs is 0"),
      ),
      JSON.stringify(caught.problems),
    );

    // The three measurements no verdict rule reads are re-derived too: they
    // are printed in the committed report, and the runbook's guarantee is that
    // every recorded number comes back from the detail rather than from the
    // row's own say-so.
    for (const [field, delta] of [
      ["novel_real", 7],
      ["usd", 1.5],
      ["seconds", 60],
    ]) {
      const edited = structuredClone(scored.row);
      edited.conditions.pipeline[field] += delta;
      const found = revalidateRow({
        contract,
        row: edited,
        repoRoot: root,
        detailDir: plan.plan_dir,
      });
      assert.ok(
        found.problems.some((problem) =>
          problem.startsWith(`conditions.pipeline.${field} is`),
        ),
        `${field}: ${JSON.stringify(found.problems)}`,
      );
    }

    // `scoring_usd` was the one number with no evidence beside it. Each cell
    // record now carries what its own judge calls cost and `calibration.json`
    // carries the replay's, so the run total is a sum of the detail.
    const overstated = structuredClone(scored.row);
    overstated.scoring_usd += 2;
    const spent = revalidateRow({
      contract,
      row: overstated,
      repoRoot: root,
      detailDir: plan.plan_dir,
    });
    assert.ok(
      spent.problems.some((problem) =>
        problem.startsWith("row.scoring_usd is"),
      ),
      JSON.stringify(spent.problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate re-derives judge_calibration instead of trusting the row", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      writeCell(plan, cell, {
        output: "scripts/pr/pr-ready-state-core.mjs:750 is too long.",
        root,
      });
    }
    const calibrationPath = path.join(
      root,
      "docs/evals/review-skill-judge-calibration.json",
    );
    const calibrationSet = JSON.parse(readFileSync(calibrationPath, "utf8"));
    const { exec } = stubExec();
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: stubGit().runGit,
      calibrationSet,
    });
    const outcomesPath = path.join(plan.plan_dir, "calibration.json");
    const outcomes = JSON.parse(readFileSync(outcomesPath, "utf8"));
    assert.equal(outcomes.outcomes.length, scored.row.judge_calibration.total);
    const validate = (row) =>
      revalidateRow({
        contract,
        row,
        repoRoot: root,
        detailDir: plan.plan_dir,
        calibrationSet,
      });
    assert.deepEqual(validate(scored.row).problems, []);

    // The gate every other number sits under used to be two integers the row
    // stated about itself, so a hand-edited row could lift it.
    const forged = structuredClone(scored.row);
    forged.judge_calibration = { agreement: 40, total: 40 };
    const caught = validate(forged);
    assert.equal(caught.ok, false);
    assert.ok(
      caught.problems.some((problem) =>
        /judge_calibration\.agreement is 40; calibration\.json gives/.test(
          problem,
        ),
      ),
      JSON.stringify(caught.problems),
    );

    // Relabelling what the judge was expected to answer is the cheap way to
    // turn a disagreement into agreement inside the detail file itself.
    const relabelled = structuredClone(outcomes);
    relabelled.outcomes[0].expected =
      relabelled.outcomes[0].expected === "matched" ? "unmatched" : "matched";
    writeFileSync(outcomesPath, JSON.stringify(relabelled, null, 2));
    assert.ok(
      validate(scored.row).problems.some((problem) =>
        /the frozen pair says/.test(problem),
      ),
    );

    // Deleting the file must not buy back the trust it was written to remove.
    rmSync(outcomesPath);
    assert.ok(
      validate(scored.row).problems.some((problem) =>
        /no calibration\.json/.test(problem),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoring resets each fixture, uses the contract judge, and totals its cost", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      writeCell(plan, cell, {
        root,
        output: "scripts/review/run-eval.sh:150 is wrong.",
      });
    }
    // Every judge reply arrives in a CLI envelope carrying its own cost.
    const models = new Set();
    const inner = stubExec().exec;
    let judgeCalls = 0;
    const exec = async (request) => {
      models.add(request.model);
      judgeCalls += 1;
      return JSON.stringify({
        result: await inner(request),
        total_cost_usd: 0.25,
      });
    };
    const git = stubGit();
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: git.runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    // The judge the comparability key records is the judge that ran.
    assert.deepEqual([...models], [contract.judge.model]);
    // The forty calibration replays and every judge call the cells needed.
    assert.ok(judgeCalls >= 40 + plan.cells.length);
    assert.equal(
      scored.row.scoring_usd,
      Number((judgeCalls * 0.25).toFixed(2)),
    );
    assert.deepEqual(validateLedgerRow(scored.row), []);
    // And it is re-derivable: each cell record carries what its own judge
    // calls cost, `calibration.json` carries the replay's, and `--validate`
    // adds them up instead of taking the row's word for the total.
    assert.deepEqual(
      revalidateRow({
        contract,
        row: scored.row,
        repoRoot: root,
        detailDir: plan.plan_dir,
      }).problems,
      [],
    );
    const inflated = structuredClone(scored.row);
    inflated.scoring_usd += 1;
    assert.ok(
      revalidateRow({
        contract,
        row: inflated,
        repoRoot: root,
        detailDir: plan.plan_dir,
      }).problems.some((problem) => problem.startsWith("row.scoring_usd is")),
    );
    // The last cell left the fixture dirty, so every scoring pass resets it
    // before the novel judge reads the tree with Bash.
    const resets = git.calls.filter((call) => call.args[0] === "reset");
    const cleans = git.calls.filter((call) => call.args[0] === "clean");
    const checkouts = git.calls.filter((call) => call.args[0] === "checkout");
    assert.equal(resets.length, plan.cells.length);
    assert.equal(cleans.length, plan.cells.length);
    assert.equal(checkouts.length, plan.cells.length);
    assert.ok(resets.every((call) => call.cwd === root));
    // And it resets to the head the contract pins, not to whatever `HEAD`
    // names now: the last cell ran with Bash and could have committed its own
    // edits, or checked out the fixture's `base`, making that tree the fixture
    // for the login snapshot and the novelty judge of every cell after it.
    for (const cell of plan.cells) {
      const pinned = contract.fixtures.find(
        (candidate) => candidate.pr === cell.pr,
      ).first_head;
      assert.ok(
        checkouts.some((call) => call.args.at(-1) === pinned),
        `no scoring checkout named the pinned head ${pinned}`,
      );
      assert.ok(resets.some((call) => call.args.at(-1) === pinned));
    }

    // A reset that does not land on the pinned head fails scoring rather than
    // scoring the contestant's tree.
    const drifting = stubGit();
    const driftGit = ({ args, cwd }) => {
      const answer = drifting.runGit({ args, cwd });
      if (args[0] === "rev-parse")
        return { ...answer, stdout: `${"0".repeat(40)}\n` };
      return answer;
    };
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec,
        runGit: driftGit,
        calibrationSet: JSON.parse(
          readFileSync(
            path.join(root, "docs/evals/review-skill-judge-calibration.json"),
            "utf8",
          ),
        ),
      }),
      /not the pinned/,
    );

    // A fixture that cannot be reset is a scoring failure, never a number.
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec,
        runGit: stubGit({ failOn: "reset" }).runGit,
        calibrationSet: JSON.parse(
          readFileSync(
            path.join(root, "docs/evals/review-skill-judge-calibration.json"),
            "utf8",
          ),
        ),
      }),
      /could not be reset before scoring/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blind judge keeps its turn bound and emits no --allowed-tools", () => {
  const blind = claudeArgv({
    prompt: "judge this",
    model: "claude-opus-5",
    effort: "high",
    allowedTools: BLIND_JUDGE_TOOLS,
    maxTurns: BLIND_JUDGE_MAX_TURNS,
  });
  // An empty `--allowed-tools` makes the CLI eat the next flag and its value as
  // tool names, which silently unbounds the judge. The flag must be absent.
  assert.equal(blind.includes("--allowed-tools"), false);
  const turnsAt = blind.indexOf("--max-turns");
  assert.notEqual(turnsAt, -1);
  assert.equal(blind[turnsAt + 1], "1");

  const tooled = claudeArgv({
    prompt: "review this",
    model: "claude-opus-5",
    effort: "high",
    allowedTools: ["Read", "Grep"],
    maxTurns: 60,
  });
  const toolsAt = tooled.indexOf("--allowed-tools");
  assert.notEqual(toolsAt, -1);
  assert.deepEqual(tooled.slice(toolsAt + 1, toolsAt + 3), ["Read", "Grep"]);
  assert.deepEqual(tooled.slice(toolsAt + 3), ["--max-turns", "60"]);
});

test("a scoring subprocess inherits no GitHub credential", () => {
  const scrubbed = scrubbedEnv({
    env: {
      PATH: "/usr/bin",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GITHUB_PERSONAL_ACCESS_TOKEN: "secret",
      GH_ENTERPRISE_TOKEN: "secret",
      ANTHROPIC_API_KEY: "kept",
    },
    ghConfigDir: "/tmp/empty-gh",
  });
  for (const name of SCRUBBED_ENV_VARS) {
    assert.equal(scrubbed[name], undefined, name);
  }
  // The model API must stay reachable; only the credentials go.
  assert.equal(scrubbed.ANTHROPIC_API_KEY, "kept");
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.GH_CONFIG_DIR, "/tmp/empty-gh");
  assert.equal(scrubbed.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(scrubbed.GIT_CONFIG_VALUE_0, "");
  assert.equal(scrubbed.GIT_ALLOW_PROTOCOL, "file");
  assert.equal(scrubbed.GIT_TERMINAL_PROMPT, "0");
});

test("a scoring judge inherits no path back to a source checkout", () => {
  // `classifyNovel` runs its judge with `Bash` inside the fixture, so the
  // checkout paths pnpm exports — INIT_CWD, npm_config_local_prefix and the
  // rest — and the `<checkout>/node_modules/.bin` entry it prepends to `PATH`
  // are a route to docs/evals/review-skill-truth/ for a prompt-injected claim.
  // A judge reading the answer key passes through no `leakSignals()`, so it
  // gets the same treatment `run-eval.sh` gives a contestant cell.
  const checkout = mkdtempSync(path.join(tmpdir(), "review-eval-checkout-"));
  try {
    const bin = path.join(checkout, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    const scrubbed = scrubbedEnv({
      env: {
        PATH: `${bin}:/usr/bin:${checkout}`,
        INIT_CWD: checkout,
        npm_config_local_prefix: checkout,
        npm_package_json: path.join(checkout, "package.json"),
        PNPM_SCRIPT_SRC_DIR: checkout,
        NODE_PATH: path.join(checkout, "node_modules"),
        OLDPWD: checkout,
        PWD: checkout,
        ANTHROPIC_API_KEY: "kept",
      },
      ghConfigDir: "/tmp/empty-gh",
    });
    for (const name of [
      "INIT_CWD",
      "npm_config_local_prefix",
      "npm_package_json",
      "PNPM_SCRIPT_SRC_DIR",
      "NODE_PATH",
      "OLDPWD",
      "PWD",
    ]) {
      assert.equal(scrubbed[name], undefined, name);
    }
    // The model API stays reachable, and the entries a judge needs survive.
    assert.equal(scrubbed.ANTHROPIC_API_KEY, "kept");
    assert.equal(scrubbed.PATH, "/usr/bin");
    assert.deepEqual(
      Object.entries(scrubbed).filter(([, value]) =>
        String(value).includes(checkout),
      ),
      [],
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a cell inherits no path back to the source checkout", () => {
  // The answer key is frozen on main under docs/evals/review-skill-truth/, and
  // the runbook starts a manual run from the repository root. `run_in_fixture`
  // then `cd`s into the fixture, and bash exports the resulting `OLDPWD`: the
  // contestant process — `claude` and `codex` are both ordinary programs, not
  // shells — receives the source checkout's path in its environment. Reading
  // the truth files through it costs nothing and emits no PR number, reviewer
  // login or withheld SHA, so `leakSignals()` sees a clean transcript and the
  // paid score is a fiction. `PWD` must survive; it is the fixture under
  // review. The child here is the environment itself rather than a shell,
  // because bash and zsh both re-initialize `OLDPWD` at startup and would hide
  // the very variable this checks.
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-oldpwd-"));
  try {
    const fixture = path.join(dir, "fixture");
    mkdirSync(fixture, { recursive: true });
    const script = runEvalSourceSet();
    const cellEnv = script.match(
      /\nCELL_ENV=\(env\n[\s\S]*?PATH="\$CELL_PATH"\)\n/,
    )?.[0];
    assert.ok(cellEnv, "CELL_ENV was not found in run-eval.sh");
    const harness = [
      "set -uo pipefail",
      `SHIM=${JSON.stringify(dir)}`,
      `REPO=${JSON.stringify(repoRoot)}`,
      `fail() { printf 'FATAL: %s\\n' "$*" >&2; exit 1; }`,
      // pnpm prepends the checkout's bin directory to PATH before running a
      // script, so the cell PATH rebuild has to have something to drop.
      `export PATH=${JSON.stringify(`${path.join(repoRoot, "node_modules/.bin")}:${process.env.PATH}`)}`,
      // The documented invocation is `pnpm review:eval:run`, and pnpm exports
      // these into every script it runs; make them present so the dynamic
      // scrub is exercised whether or not this suite itself runs under pnpm.
      `export INIT_CWD=${JSON.stringify(repoRoot)}`,
      `export npm_package_json=${JSON.stringify(path.join(repoRoot, "package.json"))}`,
      `export PNPM_SCRIPT_SRC_DIR=${JSON.stringify(repoRoot)}`,
      cellEnv,
      shellFunction("run_in_fixture"),
      `run_in_fixture ${JSON.stringify(fixture)} env`,
    ].join("\n");
    const result = spawnSync("bash", ["-c", harness], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const cellVars = result.stdout.split("\n").filter(Boolean);
    assert.deepEqual(
      cellVars.filter((line) => line.startsWith("OLDPWD=")),
      [],
    );
    assert.ok(cellVars.includes(`PWD=${fixture}`), result.stdout);
    // Including PATH. It survives the scrub because a cell needs node, git and
    // the model CLIs, and under pnpm it carries `<checkout>/node_modules/.bin`
    // — the same route to the answer key the INIT_CWD scrub just removed, and
    // one a Bash-enabled contestant can walk with no leak signal to catch it.
    assert.deepEqual(
      cellVars.filter((line) => line.includes(repoRoot)),
      [],
    );
    const cellPath = cellVars
      .find((line) => line.startsWith("PATH="))
      ?.slice("PATH=".length);
    // The shim stays first, so the refusing `gh` still shadows the real one,
    // and the system directories a cell needs are still there.
    assert.equal(cellPath.split(":")[0], dir);
    assert.ok(cellPath.split(":").includes("/usr/bin"), cellPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the orchestrator keeps its resume cache outside the spec worktree", () => {
  const script = runEvalSourceSet();
  // The spec worktree is a temporary directory the EXIT trap removes, so a
  // plan directory inside it takes every completed cell down with it.
  assert.match(script, /RUN_DIR="\$REPO\/\$DETAIL_DIR"/);
  assert.match(script, /--out "\$RUN_DIR"/);
});

test("the spec worktree is not created where a cell can list it", () => {
  // The spec is a second checkout of origin/main, so it carries the whole
  // frozen answer key. Under `$TMPROOT` a Bash-enabled contestant finds it by
  // listing the TMPDIR it inherits and copies the defect bodies out, emitting
  // no PR number, reviewer login or withheld SHA for `leakSignals()` to catch.
  // Permissions cannot help — a cell runs as the same user — so it goes under
  // the git directory, which nothing hands a cell a path to.
  const script = runEvalSourceSet();
  assert.match(script, /SPEC="\$\(mktemp -d "\$LOCK_ROOT\/review-eval-spec/);
  assert.equal(/mktemp -d "\$TMPROOT\/review-eval-spec/.test(script), false);
  // `$TMPDIR` is swept by the OS and the git directory is not, so a removal
  // that did not land must not leave a checkout of main sitting in `.git`.
  const cleanup = shellFunction("cleanup");
  assert.match(cleanup, /worktree remove --force "\$SPEC"/);
  assert.match(cleanup, /rm -rf "\$SPEC"/);
});

test("a failed run publishes no partial scoring artifacts", () => {
  // `--score` writes calibration.json before the first cell and one result
  // file per cell it scores. A judge that dies mid-pass, or a scored row that
  // fails `--validate`, leaves those beside the zero placeholders `failedRow`
  // publishes, and `--revalidate-appended` recomputes the row from exactly
  // those files and rejects the failure PR. The paid `cells/` cache stays.
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-partial-"));
  try {
    const run = path.join(dir, "run");
    mkdirSync(path.join(run, "cells", "pr-1990-pipeline-draw1"), {
      recursive: true,
    });
    for (const file of [
      "calibration.json",
      "result-1990-pipeline-1.json",
      "result-1999-control-1.json",
    ]) {
      writeFileSync(path.join(run, file), "{}\n");
    }
    writeFileSync(
      path.join(run, "cells", "pr-1990-pipeline-draw1", "result.json"),
      "{}\n",
    );
    writeFileSync(path.join(run, "plan.json"), "{}\n");
    const harness = [
      "set -uo pipefail",
      `RUN_DIR=${JSON.stringify(run)}`,
      shellFunction("clear_scoring_artifacts"),
      "clear_scoring_artifacts",
    ].join("\n");
    const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(run).sort(), ["cells", "plan.json"]);
    assert.equal(
      existsSync(path.join(run, "cells", "pr-1990-pipeline-draw1/result.json")),
      true,
      "the paid resume cache was deleted",
    );
    // And the failed-row writer is what calls it, so no abort path publishes
    // a row whose detail disagrees with it.
    assert.match(shellFunction("write_failed_row"), /clear_scoring_artifacts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Extract one shell function from the run-eval source that owns it. */
function shellFunction(name) {
  const script = runEvalSourceSet();
  const source = script.match(
    new RegExp(`\\n${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`),
  )?.[0];
  assert.ok(source, `${name} was not found in the run-eval source set`);
  return source;
}

test("publishing a failed run keeps the cells a retry would reuse", () => {
  // The run directory IS the resume cache and is normally the very directory
  // being published, so an unconditional `rm -rf $detail/cells` made a retry
  // re-spend the whole paid matrix. The cells stay out of the commit through an
  // exclude pathspec instead.
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-publish-"));
  try {
    const detail = "docs/evals/review-skill-runs/2026-09-08-dead-full-beef";
    const run = (keepCells) => {
      const repo = path.join(dir, `repo-${keepCells}`);
      mkdirSync(path.join(repo, detail, "cells", "c1"), { recursive: true });
      writeFileSync(
        path.join(repo, detail, "cells", "c1", "result.json"),
        "{}",
      );
      const harness = [
        "set -uo pipefail",
        `REPO=${JSON.stringify(repo)}`,
        `RUN_DIR=${JSON.stringify(path.join(repo, detail))}`,
        "OPEN_PR=0",
        `KEEP_CELLS=${keepCells}`,
        `json_field() { printf '%s' ${JSON.stringify(detail)}; }`,
        "require_safe_detail() { :; }",
        `log() { printf '%s\\n' "$*"; }`,
        shellFunction("publish_row"),
        "publish_row INCOMPLETE failure.md",
      ].join("\n");
      const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return {
        stdout: result.stdout,
        cells: existsSync(
          path.join(repo, detail, "cells", "c1", "result.json"),
        ),
      };
    };
    const failed = run(1);
    assert.equal(failed.cells, true, "a failed run lost its resume cache");
    assert.match(failed.stdout, /keeping the resume cache/);
    // A scored run has nothing left to resume, so its cells still go.
    assert.equal(run(0).cells, false);
    // Either way the commit excludes them.
    assert.match(
      failed.stdout,
      new RegExp(`git -C \\S+ add \\S+ \\S*${detail}\\S* \\S*exclude\\S*cells`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger commit leaves the operator's other staged work alone", () => {
  // The pre-flight only asks whether the ledger file is dirty, and a
  // --skill-ref candidate run skips even that, so unrelated staged changes can
  // be sitting in the operator's index when a --pr run publishes hours later. A
  // pathless `git commit` swept all of it into the ledger PR.
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-commit-"));
  try {
    const detail = "docs/evals/review-skill-runs/2026-09-08-dead-full-beef";
    const repo = path.join(dir, "repo");
    const git = (...args) =>
      spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    mkdirSync(path.join(repo, "docs/evals"), { recursive: true });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    writeFileSync(path.join(repo, "docs/evals/review-skill-ledger.jsonl"), "");
    writeFileSync(path.join(repo, "unrelated.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    // What the operator staged and did not mean to publish.
    writeFileSync(path.join(repo, "unrelated.ts"), "export const a = 2;\n");
    git("add", "unrelated.ts");
    // What the run produced.
    mkdirSync(path.join(repo, detail, "cells"), { recursive: true });
    writeFileSync(path.join(repo, detail, "report.md"), "# report\n");
    writeFileSync(path.join(repo, detail, "cells", "c1.json"), "{}");
    writeFileSync(
      path.join(repo, "docs/evals/review-skill-ledger.jsonl"),
      '{"executed_at":"2026-09-08T00:00:00Z"}\n',
    );

    // `push` fails with no remote, which is exactly the boundary this test
    // wants: the commit has already happened, and nothing was published.
    const harness = [
      "set -uo pipefail",
      `REPO=${JSON.stringify(repo)}`,
      `RUN_DIR=${JSON.stringify(path.join(repo, detail))}`,
      "OPEN_PR=1",
      "KEEP_CELLS=0",
      "PUBLISHED=0",
      `json_field() { printf '%s' ${JSON.stringify(detail)}; }`,
      "require_safe_detail() { :; }",
      "keep_baseline_copy() { :; }",
      `log() { printf '%s\\n' "$*"; }`,
      shellFunction("publish_row"),
      "publish_row GREEN report.md",
    ].join("\n");
    const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const committed = git("show", "--name-only", "--format=", "HEAD")
      .stdout.split("\n")
      .filter(Boolean);
    assert.deepEqual(committed.sort(), [
      "docs/evals/review-skill-ledger.jsonl",
      `${detail}/report.md`,
    ]);
    // Still the operator's to deal with, still not in the PR.
    assert.equal(
      git("diff", "--cached", "--name-only").stdout.trim(),
      "unrelated.ts",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one review eval at a time may hold the shared run state", async () => {
  // Every cell resets and cleans the shared per-PR checkout and stages `.skill`
  // in it, and every run appends to the checkout's ledger. Two overlapping
  // runs — the launchd job starting under a manual run, or two manual runs —
  // take turns rewriting the tree the other is reviewing and race the ledger.
  // The two shared roots move independently, so both are locked: a manual run
  // that passes its own `--cache-dir` still contends for the checkout.
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-lock-"));
  try {
    const lockRoot = path.join(dir, "git");
    const harness = (cacheDir, tail = "") =>
      [
        "set -uo pipefail",
        `LOCK_ROOT=${JSON.stringify(lockRoot)}`,
        `CACHE_DIR=${JSON.stringify(cacheDir)}`,
        "LOCK_DIRS=()",
        `fail() { printf 'FATAL: %s\\n' "$*" >&2; exit 1; }`,
        `log() { printf '%s\\n' "$*"; }`,
        shellFunction("acquire_one_lock"),
        shellFunction("acquire_run_lock"),
        'acquire_run_lock; printf "held %s\\n" "${LOCK_DIRS[@]}"',
        tail,
      ].join("\n");
    const cache = path.join(dir, "cache");
    const lock = path.join(lockRoot, "run.lock");
    const cacheLock = path.join(cache, "run.lock");
    const lockFunction = shellFunction("acquire_one_lock");
    assertBefore(
      lockFunction,
      '"$claim_ticket" "$claim_file"',
      'rm -rf "$lock"',
      "a stale lock is deleted before this process claims it",
    );

    const free = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(free.status, 0, free.stderr);
    assert.match(free.stdout, new RegExp(`held ${lock}`));
    assert.match(free.stdout, new RegExp(`held ${cacheLock}`));
    assert.equal(readFileSync(lock, "utf8").trim().length > 0, true);

    // The owner record is complete before its hard link makes the lock path
    // visible. A suspended owner therefore exposes no pid-less lock that a
    // contender can mistake for stale state.
    const ownerWrites = sourceIndexes(
      lockFunction,
      `printf '%s\\n' "$$" >"$owner_ticket"`,
    );
    const ownerPublications = sourceIndexes(
      lockFunction,
      '"$owner_ticket" "$lock" 2>/dev/null',
    );
    assert.equal(ownerWrites.length, 2, "expected two owner-record writes");
    assert.equal(
      ownerPublications.length,
      2,
      "expected two owner-record publications",
    );
    for (let index = 0; index < ownerWrites.length; index += 1) {
      assert.ok(
        ownerWrites[index] < ownerPublications[index],
        `owner record ${index + 1} is published before it is complete`,
      );
      if (index + 1 < ownerWrites.length) {
        assert.ok(
          ownerPublications[index] < ownerWrites[index + 1],
          `owner publication ${index + 1} crosses into the next owner path`,
        );
      }
    }
    assert.match(
      lockFunction,
      /linkSync\(process\.argv\[1\], process\.argv\[2\]\)/,
      "lock publication must name the exact destination path",
    );

    // A reclaimer can die after it removes the old lock but before it publishes
    // a replacement. The next direct lock owner must retire that abandoned
    // claim, even when its ticket pid now belongs to a live process.
    rmSync(lock, { force: true });
    rmSync(cacheLock, { force: true });
    mkdirSync(`${lock}.reclaim`, { recursive: true });
    writeFileSync(path.join(`${lock}.reclaim`, "0"), `${process.pid}\n`);
    const abandonedClaim = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(abandonedClaim.status, 0, abandonedClaim.stderr);
    assert.equal(existsSync(`${lock}.reclaim`), false);

    // A live holder is a real conflict, and the run refuses before it spends.
    writeFileSync(lock, `${process.pid}\n`);
    const busy = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /another review eval \(pid \d+\) holds/);

    // And it refuses even when the second run picks its own `--cache-dir`: the
    // ledger and the detail directory are shared no matter what the cache is.
    const elsewhere = spawnSync(
      "bash",
      ["-c", harness(path.join(dir, "other-cache"))],
      { encoding: "utf8" },
    );
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stderr, new RegExp(`holds ${lock}`));

    // A live directory-form lock from an older checkout remains a conflict.
    // Exact link publication must not create an owner ticket inside it.
    rmSync(lock, { force: true });
    mkdirSync(lock);
    writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
    const legacyBusy = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(legacyBusy.status, 1);
    assert.match(legacyBusy.stderr, /another review eval \(pid \d+\) holds/);

    // An old owner can be suspended between mkdir and writing pid. Treat that
    // directory as occupied because its liveness cannot be proved safely.
    unlinkSync(path.join(lock, "pid"));
    const legacyUnidentified = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(legacyUnidentified.status, 1);
    assert.match(
      legacyUnidentified.stderr,
      /cannot identify the run lock owner/,
    );
    assert.equal(existsSync(lock), true);

    // A dead directory-form lock is reclaimed and replaced by the atomic
    // owner-record file, so upgrades do not wedge scheduled runs.
    const dead = spawnSync("bash", ["-c", "exit 0"]);
    writeFileSync(path.join(lock, "pid"), `${dead.pid}\n`);
    writeFileSync(cacheLock, `${dead.pid}\n`);
    const legacyReclaimed = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(legacyReclaimed.status, 0, legacyReclaimed.stderr);
    assert.match(legacyReclaimed.stdout, /reclaiming a run lock/);
    assert.equal(readFileSync(lock, "utf8").trim().length > 0, true);

    // A lock left behind by a SIGKILL is reclaimed rather than wedging the job.
    writeFileSync(lock, `${dead.pid}\n`);
    writeFileSync(cacheLock, `${dead.pid}\n`);
    const reclaimed = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
    assert.match(reclaimed.stdout, /reclaiming a run lock/);

    // A killed stale-lock reclaimer leaves its own marker. Its dead pid makes
    // that marker recoverable, so it cannot wedge every later scheduled run.
    writeFileSync(lock, `${dead.pid}\n`);
    mkdirSync(`${lock}.reclaim`, { recursive: true });
    writeFileSync(path.join(`${lock}.reclaim`, "0"), `${dead.pid}\n`);
    writeFileSync(cacheLock, `${dead.pid}\n`);
    const staleReclaimer = spawnSync("bash", ["-c", harness(cache)], {
      encoding: "utf8",
    });
    assert.equal(staleReclaimer.status, 0, staleReclaimer.stderr);
    assert.match(staleReclaimer.stdout, /reclaiming a run lock/);
    assert.equal(existsSync(`${lock}.reclaim`), false);

    // Two contenders that observe the same dead reclaimer cannot both take
    // the next generation. Keep the winner alive long enough for the loser to
    // see its pid rather than treating the new run lock as stale again.
    for (const target of [lock, cacheLock]) {
      writeFileSync(target, `${dead.pid}\n`);
      mkdirSync(`${target}.reclaim`, { recursive: true });
      writeFileSync(path.join(`${target}.reclaim`, "0"), `${dead.pid}\n`);
    }
    const runContender = () =>
      new Promise((resolve) => {
        const child = spawn("bash", ["-c", harness(cache, "sleep 0.5")], {
          encoding: "utf8",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    const contenders = await Promise.all([runContender(), runContender()]);
    assert.deepEqual(
      contenders.map(({ status }) => status).sort(),
      [0, 1],
      JSON.stringify(contenders),
    );
    assert.equal(existsSync(`${lock}.reclaim`), false);
    assert.equal(existsSync(`${cacheLock}.reclaim`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the run lock is taken before anything touches the fixtures", () => {
  const script = reconstructLegacyOrchestrator();
  const lifecycle = runEvalSource("lifecycle");
  // Taken before the spec worktree, the plan and the matrix, and released by
  // the EXIT trap so an interrupted run does not wedge the next one.
  assertBefore(
    script,
    "\nacquire_run_lock\n",
    "# --- the spec worktree",
    "the run lock is taken after the spec worktree is added",
  );
  assert.match(lifecycle, /\nacquire_run_lock\n/);
  assert.match(
    lifecycle,
    /for lock_dir in \$\{LOCK_DIRS\[@\]\+"\$\{LOCK_DIRS\[@\]\}"\}; do\n\s*rm -rf "\$lock_dir"/,
  );
  // The checkout half is anchored to the git directory, which no option moves,
  // and it is taken first so the ordering between the two roots is fixed.
  assert.match(
    lifecycle,
    /LOCK_ROOT="\$\(git -C "\$REPO" rev-parse --absolute-git-dir/,
  );
  assertBefore(
    lifecycle,
    'acquire_one_lock "$LOCK_ROOT"',
    'acquire_one_lock "$CACHE_DIR"',
    "the cache lock is taken before the checkout lock",
  );
});

test("the orchestrator rejects a cell whose finder or report failed", () => {
  const script = runEvalSourceSet();
  // A finder that writes a partial report and then exits non-zero — a session
  // limit, a killed process — produces output that is not empty and is not a
  // review. Cached, it would score forever as a finder that missed those
  // defects, so the cell fails on the finder's own status.
  assert.match(script, /\|\| finder_status=\$\?/);
  assert.match(script, /if \[\[ \$finder_status -ne 0 \]\]; then/);
  assert.doesNotMatch(
    script,
    /"\$\{FINDER_ARGV\[@\]\}" 2>\/dev\/null \| tail -c 30000\)" \|\| true/,
  );
  // The replay condition's whole treatment is the frozen report; an empty one
  // would hand the model an empty handoff and score that as a review.
  assert.match(script, /frozen finder report \$finder_report is unreadable/);
});

test("the orchestrator carries one baseline through plan, score, validate and report", () => {
  const script = runEvalSourceSet();
  // The candidate procedure runs the installed skill and the candidate in one
  // sitting. Without a baseline argument the candidate resolves the ledger's
  // stored anchor instead, which is the model drift the procedure exists to
  // exclude. The same argument reaches both plans and all three later commands
  // so the plan, row, revalidation and PR body cannot disagree about what it
  // was ranked on.
  assert.equal(
    script.match(/PLAN_ARGS\+=\(--against "\$AGAINST"\)/g)?.length,
    2,
  );
  assert.match(script, /AGAINST_ARGS=\(--against "\$AGAINST"\)/);
  const expansion = /"\$\{AGAINST_ARGS\[@\]\+"\$\{AGAINST_ARGS\[@\]\}"\}"/g;
  assert.equal(script.match(expansion)?.length, 3);
  for (const mode of ["--score", "--validate", "--report"]) {
    assert.ok(
      new RegExp(`${mode}[^\\n]*(\\n[^\\n]*)?\\$\\{AGAINST_ARGS`).test(script),
      `${mode} does not receive the baseline`,
    );
  }
});

test("the orchestrator rejects an ineligible baseline before paid work", () => {
  const script = reconstructLegacyOrchestrator();
  assert.equal(script.match(/baselineEligibility\(row\)/g)?.length, 2);
  assertBefore(
    script,
    "baselineEligibility(row)",
    "# --- the run deadline",
    "baseline eligibility is checked after the run deadline starts",
  );
  assert.ok(
    script.lastIndexOf("baselineEligibility(row)") <
      script.indexOf("writeFileSync(snapshot"),
  );
  assert.match(script, /baselinePreflightProblems\(\{/);
  assert.match(script, /planComparabilityKey: plan\.comparability_key/);
  assert.match(script, /baselinePlanIdentity\(row\)/);
  assert.match(
    script,
    /JSON\.stringify\(plannedBaseline\) !== JSON\.stringify\(currentBaseline\)/,
  );
  assertBefore(
    script,
    "baselinePreflightProblems({",
    "# --- the run deadline",
    "baseline preflight runs after the run deadline starts",
  );
  assertBefore(
    script,
    "baselinePlanIdentity(row)",
    "# --- the run deadline",
    "baseline identity is checked after the run deadline starts",
  );
  assert.match(
    script,
    /writeFileSync\(snapshot, `\$\{JSON\.stringify\(row\)\}\\n`\)/,
  );
  assert.match(
    script,
    /BASELINE_SNAPSHOT="\$\(mktemp "\$LOCK_ROOT\/review-eval-baseline/,
  );
  assert.equal(
    /BASELINE_SNAPSHOT="\$\(mktemp "\$TMPROOT\/review-eval-baseline/.test(
      script,
    ),
    false,
  );
  assert.match(script, /AGAINST="\$BASELINE_SNAPSHOT"/);
  assertBefore(
    script,
    'AGAINST="$BASELINE_SNAPSHOT"',
    "# --- the run deadline",
    "the baseline snapshot is selected after the run deadline starts",
  );
  assert.match(script, /rm -f "\$BASELINE_SNAPSHOT"/);
  assert.match(script, /eligible complete full baseline row/);
  assert.match(script, /malformed or incompatible with the generated plan/);
});

test("the installed baseline survives the checkout the candidate needs", () => {
  const script = runEvalSourceSet();
  const doc = readFileSync(
    path.join(repoRoot, "docs/evals/review-skill.md"),
    "utf8",
  );
  // Publishing commits the row and its detail on the new eval branch and
  // leaves the checkout there. The candidate run must branch from main, and
  // `git checkout main` deletes both, so an --against naming the row's
  // executed_at resolves against a ledger that no longer holds it and the
  // candidate's pre-flight aborts on a run the installed one already paid for.
  // One copy outside the checkout is what makes the documented same-sitting
  // comparison run at all.
  const kept = "review-eval-installed-row.json";
  assert.match(script, new RegExp(`local kept="\\$TMPROOT/${kept}"`));
  assert.match(script, /PUBLISHED=1\n\s+keep_baseline_copy/);
  // A candidate run publishes too, and a failed run publishes an INCOMPLETE
  // row; neither is ever the baseline.
  assert.match(script, /if \[\[ -n \$SKILL_REF \]\] \|\|/);
  assert.match(
    script,
    /json_field "\$RUN_DIR\/row\.json" status\) != "complete"/,
  );
  // The runbook's own command block passes that file, not a timestamp.
  assert.match(doc, new RegExp(`--against "\\$\\{TMPDIR:-/tmp\\}/${kept}"`));
});

test("the ledger branch names one run, not one day", () => {
  const script = runEvalSourceSet();
  // Two runs finishing on the same UTC day — the installed and candidate pair
  // the runbook asks for — collided on a date-only branch at `git checkout -b`
  // or at the push, after the paid run and the ledger append were both done.
  // The detail directory basename carries date, key, kind and skill digest.
  assert.match(script, /branch="eval\/review-skill-\$\(basename "\$detail"\)"/);
  assert.doesNotMatch(script, /branch="eval\/review-skill-\$\(date/);
});

test("the orchestrator snapshots the skill once and refuses a mid-run edit", () => {
  const script = runEvalSourceSet();
  // The plan records one skill digest for the whole matrix and every cached
  // cell's fingerprint carries it, so cells must all stage the same bytes.
  assert.match(script, /SKILL_DIR="\$SKILL_SNAPSHOT"/);
  assert.match(script, /cp -R "\$SKILL_DIR" "\$fixture\/\.skill"/);
  assert.match(
    script,
    /\[\[ \$SNAPSHOT_SKILL_DIGEST == "\$PLANNED_SKILL_DIGEST" \]\]/,
  );
  assert.match(script, /rm -rf "\$SKILL_SNAPSHOT"/);
});

test("a failed run records its failure, publishes it, or exits non-zero", () => {
  const script = runEvalSourceSet();
  // A run that leaves no trace is indistinguishable from one that never ran,
  // and the freshness guard cannot tell those apart either.
  assert.match(
    script,
    /write_failed_row "\$1" \|\|\n {4}fail "the run failed and the failure row could not be appended: \$1"/,
  );
  // The failed row goes into the checkout's ledger, so `abort` may not simply
  // leave it there and exit zero: the next run refuses to start against a
  // ledger with uncommitted changes, and nothing reaches a PR or the freshness
  // workflow. Publish it, and exit zero only when a PR carries it.
  assert.match(script, /publish_row INCOMPLETE failure\.md/);
  assert.match(
    script,
    /if \[\[ \$PUBLISHED -eq 1 \]\]; then\n {4}exit 0\n {2}fi\n {2}fail "the run failed, the row was appended/,
  );
  // The success path publishes through the same function, so a failure row is
  // committed exactly the way a scored one is.
  assert.match(script, /publish_row "\$VERDICT" report\.md/);
  assert.match(script, /PUBLISHED=1/);
});

test("the run deadline bounds the cell subprocesses and the judge pass", () => {
  const script = runEvalSourceSet();
  // Checked only between cells, the deadline bounded nothing: a finder or a
  // contestant that stalls never returns to the check, and the judge pass ran
  // outside the budget entirely. Every one of the three is now started through
  // the bounded runner, with the matrix keeping a quarter of the budget back
  // for scoring.
  assert.match(script, /MATRIX_DEADLINE=\$\(\(DEADLINE - DEADLINE \/ 4\)\)/);
  assert.match(
    script,
    /run_bounded "\$finder_out" "\$\(remaining_seconds "\$MATRIX_DEADLINE"\)"/,
  );
  assert.match(
    script,
    /run_bounded "\$raw" "\$\(remaining_seconds "\$MATRIX_DEADLINE"\)"/,
  );
  assert.match(
    script,
    /run_bounded "\$SCORE_OUT" "\$\(remaining_seconds "\$DEADLINE"\)"/,
  );
  // The watchdog escalates: a child that ignores TERM is killed.
  assert.match(script, /kill -TERM "\$target"/);
  assert.match(script, /kill -KILL "\$target"/);
  // A cell that hit the bound fails the cell; it is never cached as a review.
  assert.match(script, /the finder hit the run deadline; not cached/);
  assert.match(script, /claude hit the run deadline; not cached/);
});

test("the deadline terminates the whole subprocess tree, not only its parent", () => {
  // Every command the bounded runner starts spends quota through
  // grandchildren: the scoring pass is `node review-eval.mjs`, which spawns up
  // to four `claude` judges, and a cell is a shell function that spawns the
  // finder or the contestant. Signalling the direct child alone left those
  // running against their own one-hour timeouts, billing long after the run
  // reported failure and removed the worktrees they were reading.
  //
  // Run the committed function itself rather than grepping it: whether a
  // grandchild dies is a property of the process group, which no pattern in the
  // source can assert.
  const script = runEvalSourceSet();
  const definition = script.match(/^run_bounded\(\) \{\n[\s\S]*?^\}$/m);
  assert.ok(definition, "run_bounded is not defined at column zero");
  const fastDefinition = definition[0].replace("sleep 10", "sleep 1");
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-bounded-"));
  let grandchild = null;
  try {
    const harness = path.join(dir, "harness.sh");
    const outFile = path.join(dir, "out");
    const heartbeat = path.join(dir, "heartbeat");
    const child = [
      'trap "exit 0" TERM',
      `(trap "" TERM; while :; do printf . >> ${JSON.stringify(heartbeat)}; sleep 0.2; done) &`,
      'echo "$!"',
      "while :; do sleep 120; done",
    ].join("\n");
    const childArg = `'${child.replaceAll("'", `'"'"'`)}'`;
    writeFileSync(
      harness,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        fastDefinition,
        "status=0",
        // The direct child exits when TERM reaches it. Its descendant ignores
        // TERM, so only the watchdog's later group-wide KILL can stop it.
        `run_bounded ${JSON.stringify(outFile)} 3 bash -c ${childArg} || status=$?`,
        'echo "status=$status"',
      ].join("\n"),
    );
    const result = spawnSync("bash", [harness], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status=124/);
    grandchild = Number(readFileSync(outFile, "utf8").trim());
    assert.ok(Number.isInteger(grandchild) && grandchild > 1);
    // The group signal is delivered with the parent's; give the kernel a beat
    // before asking whether the grandchild is gone.
    spawnSync("sleep", ["1"]);
    const stoppedAt = readFileSync(heartbeat, "utf8").length;
    spawnSync("sleep", ["1"]);
    assert.equal(
      readFileSync(heartbeat, "utf8").length,
      stoppedAt,
      `grandchild ${grandchild} kept running after the deadline`,
    );
    grandchild = null;
  } finally {
    if (grandchild !== null) {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // Already gone; nothing to clean up.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the orchestrator refuses to run bytes the row would not record", () => {
  const wrapper = runEvalSource("wrapper");
  const lifecycle = runEvalSource("lifecycle");
  // `orchestrator_digest` is taken from the spec worktree, which is where the
  // harness reads every other input. Running an edited copy against a clean
  // spec would record the spec's bytes for a matrix these files actually
  // shaped. Resolve both helpers from the wrapper path and compare all three.
  assert.match(
    wrapper,
    /RUN_EVAL_SCRIPT_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"/,
  );
  for (const helper of ["run-eval-lifecycle.sh", "run-eval-runtime.sh"]) {
    assert.match(
      wrapper,
      new RegExp(
        `source "\\$RUN_EVAL_SCRIPT_DIR/${helper.replace(".", "\\.")}"`,
      ),
    );
  }

  const verify = lifecycle.match(
    /\n {2}verify\)\n([\s\S]*?)\n {4};;\n {2}support\)/,
  )?.[1];
  assert.ok(verify, "the lifecycle verify stage is missing");
  for (const source of [
    "run-eval.sh",
    "run-eval-lifecycle.sh",
    "run-eval-runtime.sh",
  ]) {
    assert.match(
      verify,
      new RegExp(`\\n      ${source.replace(".", "\\.")}\\n`),
    );
  }
  assert.match(
    verify,
    /cmp -s "\$RUN_EVAL_RUNNING_SOURCE" "\$RUN_EVAL_SPEC_SOURCE"/,
  );
  assert.doesNotMatch(verify, /\$\{BASH_SOURCE\[0\]\}/);
  assert.match(
    lifecycle,
    /: <<'RUN_EVAL_ORIGINAL_LIFECYCLE_VERIFY'[\s\S]*# RUN-EVAL-ORIGINAL-BEGIN lifecycle-verify/,
  );
  assert.doesNotMatch(lifecycle, /\n {2}original-verify\)/);
});

test("the cell reader emits nothing when the plan carries a forged field", () => {
  // The loop that spends money reads this program through a process
  // substitution and cannot see the writer die. Emitting rows as it goes would
  // run every cell before the offending one and then score that truncated
  // matrix as merely partial, which is what the tab check exists to prevent.
  const shell = runEvalSourceSet();
  const program = shell.match(
    /cell_rows\(\) \{\n[\s\S]*?node -e '\n([\s\S]*?)\n {2}' "\$PLAN_JSON"/,
  )?.[1];
  assert.ok(program, "the cell row node program was not found");
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-cellrows-"));
  try {
    const planPath = path.join(dir, "plan.json");
    const cell = (cellId, extra = {}) => ({
      cell_id: cellId,
      pr: 1982,
      condition: "pipeline",
      draw: 1,
      model: "claude-opus-5",
      effort: "high",
      finder: "gpt-5.6-sol@high",
      prompt: "handoff",
      ...extra,
    });
    writeFileSync(
      planPath,
      JSON.stringify({ cells: [cell("first"), cell("second")] }),
    );
    const good = spawnSync(process.execPath, ["-e", program, planPath], {
      encoding: "utf8",
    });
    assert.equal(good.status, 0);
    assert.equal(good.stdout.split("\n").filter(Boolean).length, 2);

    writeFileSync(
      planPath,
      JSON.stringify({
        cells: [cell("first"), cell("second", { model: "opus\thandoff" })],
      }),
    );
    const forged = spawnSync(process.execPath, ["-e", program, planPath], {
      encoding: "utf8",
    });
    assert.notEqual(forged.status, 0);
    assert.equal(forged.stdout, "");
    assert.match(forged.stderr, /carries a tab or a newline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the freshness workflow watches the frozen input directories", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/review-eval-freshness.yml"),
    "utf8",
  );
  // `*` stops at a path separator in a GitHub path filter, so the recursive
  // form is what reaches docs/evals/review-skill-truth/ and its siblings.
  assert.match(workflow, /- docs\/evals\/review-skill\*\*/);
  assert.doesNotMatch(workflow, /- docs\/evals\/review-skill\*$/m);
  // Every step of the job runs a `review:eval*` alias, so a PR that renames or
  // removes one has to run this workflow.
  assert.match(workflow, /^ {6}- package\.json$/m);
  const aliases = [
    ...new Set(
      [...workflow.matchAll(/pnpm (review:eval[\w:]*)/g)].map((m) => m[1]),
    ),
  ];
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  for (const alias of aliases) {
    assert.ok(scripts[alias], `package.json has no ${alias} script`);
  }
});

test("required CI routes the nested frozen inputs to the scripts job", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  // The freshness workflow above is advisory by design, so the only required
  // check over the frozen inputs is the `scripts` job, reached through the
  // `rootScripts` path filter. dorny/paths-filter matches with picomatch,
  // where `docs/evals/review-skill*` stops at the path separator and a `**`
  // glued to that prefix is no better: a PR editing only
  // docs/evals/review-skill-truth/pr-1990.json left the filter false and the
  // required `ci` sentinel allowed the job to skip, so a broken digest or
  // scorable set could merge with no required contract check at all.
  assert.match(workflow, /^ {14}- docs\/evals\/review-skill\*\/\*\*$/m);
  // The flat inputs — review-skill.md, the fixtures, the ledger — still need
  // the non-recursive form, which `*/**` does not match on its own.
  assert.match(workflow, /^ {14}- docs\/evals\/review-skill\*$/m);
});

test("the ledger PR workflow recomputes the rows it appends", () => {
  const advisory = readFileSync(
    path.join(repoRoot, ".github/workflows/review-eval-freshness.yml"),
    "utf8",
  );
  const required = readFileSync(
    path.join(repoRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  // Schema, id coverage and append-only history all stay satisfied when a
  // ledger PR edits its own row's verdict, counters or per_defect bits after
  // the local `--validate --append`. The only PR workflow there is has to
  // recompute the row from the detail the same branch commits, or the committed
  // report is backed by nothing a reader can check.
  for (const workflow of [advisory, required]) {
    assert.match(
      workflow,
      /--check-ledger --require-base --revalidate-appended/,
    );
  }
  // The recompute reads committed JSON. This job must stay credential-free.
  assert.doesNotMatch(advisory, /ANTHROPIC|OPENAI|api[_-]?key/i);
});

test("the Claude review exemption verifies scorecard-only paths", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/claude.yml"),
    "utf8",
  );
  assert.doesNotMatch(
    workflow,
    /!startsWith\(github\.event\.pull_request\.head\.ref, 'eval\/review-skill-'\)/,
  );
  assert.match(workflow, /Verify review-eval scorecard-only scope/);
  assert.match(workflow, /git merge-base "\$BASE_SHA" "\$HEAD_SHA"/);
  assert.match(workflow, /git diff --quiet "\$merge_base" "\$HEAD_SHA"/);
  assert.match(workflow, /docs\/evals\/review-skill-ledger\.jsonl/);
  assert.match(workflow, /docs\/evals\/review-skill-runs\/\*\*/);
  assert.match(workflow, /if: steps\.review-scope\.outputs\.skip != 'true'/);
});

test("--check-ledger --revalidate-appended catches an edited appended row", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    const flags = ["--base-ref", "HEAD", "--json"];

    // A row that passed `--validate --append` locally, with its detail
    // committed on the same branch, then had one bit edited before the PR was
    // opened. Its schema, its frozen ids and its append-only history are all
    // still intact afterwards.
    const rowPath = path.join(root, "row.json");
    const row = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    writeRowEvidence(root, row);
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    assert.equal(
      cli(["--validate", rowPath, "--append", "--json"], { root }).status,
      0,
    );
    const clean = cli(["--check-ledger", "--revalidate-appended", ...flags], {
      root,
    });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(JSON.parse(clean.stdout).revalidated_rows, 1);

    const ledgerPath = path.join(root, ledgerRelative);
    const [committed] = readLedger(ledgerPath);
    const target = Object.keys(committed.conditions.pipeline.per_defect)[0];
    // The vector keeps its length. Dropping a draw from one PR is a different
    // forgery, and `checkLedger` refuses that one without this flag.
    const vector = committed.conditions.pipeline.per_defect[target];
    committed.conditions.pipeline.per_defect[target] = [
      vector[0] === 1 ? 0 : 1,
      ...vector.slice(1),
    ];
    writeFileSync(ledgerPath, `${JSON.stringify(committed)}\n`);
    const dirty = cli(["--check-ledger", "--revalidate-appended", ...flags], {
      root,
    });
    assert.equal(dirty.status, 1);
    assert.match(
      JSON.parse(dirty.stdout).problems.join(" | "),
      /appended row [^|]*conditions\.pipeline\.recall\.matched/,
    );
    // Without the flag the same edited ledger reads as clean, which is the gap.
    assert.equal(cli(["--check-ledger", ...flags], { root }).status, 0);

    // The flag never silently checks nothing: without a base it cannot tell
    // which rows are new, and it says so instead of passing.
    const noBase = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "refs/heads/no-such-base",
        "--json",
      ],
      { root },
    );
    assert.equal(noBase.status, 1);
    assert.equal(JSON.parse(noBase.stdout).revalidated_rows, null);
    assert.match(
      JSON.parse(noBase.stdout).problems.join(" | "),
      /--revalidate-appended cannot tell which rows are new/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects reused and aliased detail directories", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const original = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    writeRowEvidence(root, original);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(original)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record original run");

    const alias = path.join(
      path.dirname(original.detail_dir),
      "original-evidence-alias",
    );
    symlinkSync(path.basename(original.detail_dir), path.join(root, alias));
    for (const detailDir of [
      original.detail_dir,
      path.join(
        path.dirname(original.detail_dir),
        "..",
        "review-skill-runs",
        path.basename(original.detail_dir),
      ),
      alias,
    ]) {
      const copied = {
        ...structuredClone(original),
        executed_at: "2026-10-08T10:41:07Z",
        detail_dir: detailDir,
      };
      writeFileSync(
        path.join(root, ledgerRelative),
        `${JSON.stringify(original)}\n${JSON.stringify(copied)}\n`,
      );
      const checked = cli(
        [
          "--check-ledger",
          "--revalidate-appended",
          "--base-ref",
          "HEAD",
          "--json",
        ],
        { root },
      );
      assert.equal(checked.status, 1, detailDir);
      assert.match(
        JSON.parse(checked.stdout).problems.join(" | "),
        /appended row .* reuses detail_dir .* from an earlier ledger row/,
        detailDir,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects copied evidence in a new directory", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const original = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const originalDetail = writeRowEvidence(root, original);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(original)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record original run");

    const copied = structuredClone(original);
    copied.executed_at = "2026-10-08T10:41:07Z";
    copied.detail_dir =
      "docs/evals/review-skill-runs/2026-10-08-copied-evidence";
    const copiedDetail = path.join(root, copied.detail_dir);
    cpSync(originalDetail, copiedDetail, { recursive: true });
    const copiedPlan = JSON.parse(
      readFileSync(path.join(copiedDetail, "plan.json"), "utf8"),
    );
    copiedPlan.detail_dir = copied.detail_dir;
    writeFileSync(
      path.join(copiedDetail, "plan.json"),
      JSON.stringify(copiedPlan),
    );
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(original)}\n${JSON.stringify(copied)}\n`,
    );

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /reuses scored result and calibration evidence from base row/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects edits to base-row evidence", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const baseRow = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, baseRow);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseRow)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record base run");

    const resultFile = path.join(detail, "result-1990-pipeline-1.json");
    const edited = JSON.parse(readFileSync(resultFile, "utf8"));
    edited.claims = ["replacement claim"];
    writeFileSync(resultFile, JSON.stringify(edited));

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.equal(JSON.parse(checked.stdout).revalidated_rows, 0);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /base row .* evidence changed at .*result-1990-pipeline-1\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects edits through a base-row detail symlink", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const baseRow = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, baseRow);
    const alias = path.join(
      path.dirname(baseRow.detail_dir),
      "base-evidence-alias",
    );
    symlinkSync(path.basename(baseRow.detail_dir), path.join(root, alias));
    baseRow.detail_dir = alias;
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseRow)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record symlinked base run");

    const resultFile = path.join(detail, "result-1990-pipeline-1.json");
    const edited = JSON.parse(readFileSync(resultFile, "utf8"));
    edited.claims = ["replacement claim"];
    writeFileSync(resultFile, JSON.stringify(edited));

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /base row .* evidence changed at .*result-1990-pipeline-1\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects a detail directory normalized to the repo root", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const baseRow = makeRow({ fullMatrix: true });
    baseRow.detail_dir = "docs/..";
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseRow)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record root detail path");

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /base row .* names the repository root as detail_dir/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects a retargeted parent detail symlink", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const baseRow = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const runs = path.dirname(baseRow.detail_dir);
    baseRow.detail_dir = path.join(runs, "target-one", "run");
    const firstDetail = writeRowEvidence(root, baseRow);
    const secondDetail = path.join(root, runs, "target-two", "run");
    cpSync(firstDetail, secondDetail, { recursive: true });
    const alias = path.join(root, runs, "alias");
    symlinkSync("target-one", alias);
    baseRow.detail_dir = path.join(runs, "alias", "run");
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseRow)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record parent detail symlink");

    unlinkSync(alias);
    symlinkSync("target-two", alias);

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /base row .* evidence changed at .*\/alias/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects a symlinked base evidence file", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const baseRow = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, baseRow);
    const resultFile = path.join(detail, "result-1990-pipeline-1.json");
    const target = path.join(root, "docs/evals/base-result-target.json");
    writeFileSync(target, readFileSync(resultFile));
    unlinkSync(resultFile);
    symlinkSync(path.relative(detail, target), resultFile);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseRow)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record linked base evidence");

    const edited = JSON.parse(readFileSync(target, "utf8"));
    edited.claims = ["replacement claim"];
    writeFileSync(target, JSON.stringify(edited));

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /base row .*result-1990-pipeline-1\.json must be a regular evidence file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects a symlinked base plan", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const baseRow = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, baseRow);
    const planFile = path.join(detail, "plan.json");
    const target = path.join(root, "docs/evals/base-plan-target.json");
    writeFileSync(target, readFileSync(planFile));
    unlinkSync(planFile);
    symlinkSync(path.relative(detail, target), planFile);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseRow)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record linked base plan");

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /base row .*plan\.json must be a regular evidence file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended requires every planned cell of a complete row", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const row = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, row);
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    for (const file of readdirSync(detail)) {
      if (file.includes("-control-")) rmSync(path.join(detail, file));
    }

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /carries no result-.*-control-1\.json for planned cell/,
    );

    delete row.conditions.control;
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    const omitted = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(omitted.status, 1);
    assert.match(
      JSON.parse(omitted.stdout).problems.join(" | "),
      /planned condition control, but the complete row omits it/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended treats a base without a ledger as all-appended", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    // The bootstrap PR: the base commit predates the ledger file entirely, so
    // every row on the branch is appended — zero rows included. This is the
    // state the suite's first CI run sees, and it must pass, not error.
    rmSync(path.join(root, ledgerRelative));
    git("add", "-A");
    git("commit", "--quiet", "-m", "pre-ledger base");
    writeFileSync(path.join(root, ledgerRelative), "");
    const flags = ["--base-ref", "HEAD", "--require-base", "--json"];
    const boot = cli(["--check-ledger", "--revalidate-appended", ...flags], {
      root,
    });
    assert.equal(boot.status, 0, boot.stdout + boot.stderr);
    assert.equal(JSON.parse(boot.stdout).revalidated_rows, 0);

    const row = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    writeRowEvidence(root, row);
    const rowPath = path.join(root, "row.json");
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    assert.equal(
      cli(["--validate", rowPath, "--append", "--json"], { root }).status,
      0,
    );
    const one = cli(["--check-ledger", "--revalidate-appended", ...flags], {
      root,
    });
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.equal(JSON.parse(one.stdout).revalidated_rows, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scheduled run refuses a checkout that is not at origin/main", () => {
  const script = runEvalSourceSet();
  // The spec worktree pins the contract, but the ledger, the baseline it
  // resolves and the PR commands come from the checkout launchd fires in. A
  // feature branch there would score against the wrong anchor and offer to
  // commit the row on top of unrelated work.
  assert.match(script, /rev-parse origin\/main/);
  assert.match(script, /not origin\/main/);
  assert.match(script, /has uncommitted changes/);
});

test("the launchd template carries placeholders the runbook install step rewrites", () => {
  const plist = readFileSync(
    path.join(repoRoot, "scripts/review/launchd/org.mento.review-eval.plist"),
    "utf8",
  );
  const runbook = readFileSync(
    path.join(repoRoot, "docs/evals/review-skill.md"),
    "utf8",
  );
  // The managed-context rule: no author-account path may survive in either file.
  assert.doesNotMatch(plist, /\/Users\//);
  assert.doesNotMatch(runbook, /\/Users\//);
  const tokens = [
    ...new Set([...plist.matchAll(/__[A-Z_]+__/g)].map((match) => match[0])),
  ].sort();
  assert.deepEqual(tokens, ["__REPO_CHECKOUT__", "__USER_HOME__"]);
  for (const token of tokens) {
    assert.ok(
      runbook.includes(`s|${token}|`),
      `${token} is not rewritten by the documented install step`,
    );
  }
});

test("--revalidate-appended leaves an unpaired row's verdict alone", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    const flags = [
      "--check-ledger",
      "--revalidate-appended",
      "--base-ref",
      "HEAD",
      "--json",
    ];

    // The documented same-sitting candidate: scored against an installed
    // baseline whose own ledger PR has not merged, so this branch does not
    // carry the row it names. Its verdict came out of the flip counts against
    // that baseline; recomputing it here without one gives GREEN and would
    // fail the PR over a row the runbook only counts as unpaired.
    const row = makeRow({
      matchedIds: scorableIdsFor([1990, 1995]),
      fullMatrix: true,
      verdict: "PROMOTE",
    });
    row.inputs = {
      ...row.inputs,
      skill_ref: "/tmp/review-candidate",
      dirty: true,
    };
    row.vs_baseline = {
      baseline_executed_at: "2026-08-01T09:00:00Z",
      selection: "explicit",
      baseline_comparability_key: row.comparability_key,
      mcnemar: { b: 0, c: 6, delta: -6 },
    };
    writeRowEvidence(root, row);
    const ledgerPath = path.join(root, ledgerRelative);
    writeFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
    const unpaired = cli(flags, { root });
    assert.equal(unpaired.status, 0, unpaired.stdout + unpaired.stderr);
    const report = JSON.parse(unpaired.stdout);
    assert.equal(report.unpaired_baselines, 1);
    assert.equal(report.revalidated_rows, 1);

    // Automatic selection cannot waive a missing row. An automatic baseline
    // must resolve from this ledger's append order.
    row.vs_baseline.selection = "automatic";
    writeRowEvidence(root, row);
    writeFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
    const missingAutomatic = cli(flags, { root });
    assert.equal(missingAutomatic.status, 1);
    assert.match(
      JSON.parse(missingAutomatic.stdout).problems.join(" | "),
      /only a dirty --skill-ref candidate row with explicit selection/,
    );

    // The suppression is only for the row whose recorded baseline is missing.
    // A row that records no pairing at all is still recomputed, so a forged
    // verdict on it fails exactly as before.
    const forged = makeRow({
      matchedIds: scorableIdsFor(contract.fixtures.map((f) => f.pr)),
      fullMatrix: true,
      verdict: "RED",
    });
    writeFileSync(ledgerPath, `${JSON.stringify(forged)}\n`);
    const failed = cli(flags, { root });
    assert.equal(failed.status, 1);
    assert.match(
      JSON.parse(failed.stdout).problems.join(" | "),
      /row\.verdict is RED; the row's own numbers give GREEN/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended accepts a failed trace after an eligible baseline", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");

    const baseline = makeRow({ fullMatrix: true });
    writeRowEvidence(root, baseline);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseline)}\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "record baseline");

    const failed = makeRow({
      executedAt: "2026-10-08T10:41:07Z",
      status: "failed",
      verdict: "INCOMPLETE",
    });
    failed.detail_dir = "docs/evals/review-skill-runs/2026-10-08-failed";
    failed.notes = "run failed: model process exited 1";
    writeRowEvidence(root, failed);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseline)}\n${JSON.stringify(failed)}\n`,
    );

    const flags = [
      "--check-ledger",
      "--revalidate-appended",
      "--base-ref",
      "HEAD",
      "--json",
    ];
    const concealedScore = cli(flags, { root });
    assert.equal(concealedScore.status, 1);
    const concealedProblems = JSON.parse(concealedScore.stdout).problems.join(
      " | ",
    );
    assert.match(
      concealedProblems,
      /failed row retains scoring artifact calibration\.json/,
    );
    assert.match(
      concealedProblems,
      /failed row retains scoring artifact result-1990-pipeline-1\.json/,
    );

    const failedDetail = path.join(root, failed.detail_dir);
    unlinkSync(path.join(failedDetail, "calibration.json"));
    for (const name of readdirSync(failedDetail)) {
      if (name.startsWith("result-") && name.endsWith(".json")) {
        unlinkSync(path.join(failedDetail, name));
      }
    }
    const checked = cli([...flags], { root });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.equal(JSON.parse(checked.stdout).revalidated_rows, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended refuses a missing baseline on an installed row", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    const row = makeRow({ fullMatrix: true });
    row.vs_baseline = {
      baseline_executed_at: "2026-08-01T09:00:00Z",
      selection: "automatic",
      baseline_comparability_key: row.comparability_key,
      mcnemar: { b: 0, c: 0, delta: 0 },
    };
    writeRowEvidence(root, row);
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    const output = JSON.parse(checked.stdout);
    assert.equal(output.unpaired_baselines, 0);
    assert.match(output.problems.join(" | "), /only a dirty --skill-ref/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended preserves an automatic candidate baseline", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    // Append order makes this the anchor even though its wall-clock timestamp
    // is later. Automatic selection must keep append-order semantics for a
    // candidate in the same way it does for an installed run.
    const anchor = makeRow({
      executedAt: "2026-10-08T10:00:00Z",
      fullMatrix: true,
    });
    const candidate = makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    candidate.detail_dir = "docs/evals/review-skill-runs/2026-09-08-candidate";
    candidate.inputs = {
      ...candidate.inputs,
      skill_ref: "/tmp/review-candidate",
      dirty: true,
    };
    candidate.vs_baseline = buildVsBaseline({
      row: candidate,
      baselineRow: anchor,
      selection: "automatic",
    });
    candidate.verdict = verdict({
      contract,
      row: candidate,
      baselineRow: anchor,
      baselineIsExplicit: false,
    }).verdict;
    writeRowEvidence(root, anchor);
    writeRowEvidence(root, candidate);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(anchor)}\n${JSON.stringify(candidate)}\n`,
    );

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.equal(JSON.parse(checked.stdout).revalidated_rows, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended refuses a later appended automatic baseline", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const first = makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      fullMatrix: true,
    });
    first.inputs = {
      ...first.inputs,
      skill_ref: "/tmp/review-candidate",
      dirty: true,
    };
    const later = makeRow({
      executedAt: "2026-10-08T10:00:00Z",
      fullMatrix: true,
    });
    later.detail_dir = "docs/evals/review-skill-runs/2026-10-08-deadbeef";
    first.vs_baseline = buildVsBaseline({
      row: first,
      baselineRow: later,
      selection: "automatic",
    });
    writeRowEvidence(root, first);
    writeRowEvidence(root, later);
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(first)}\n${JSON.stringify(later)}\n`,
    );

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /recorded baseline .* does not match the append-order baseline none/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects a self-selected explicit baseline", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const row = makeRow({ fullMatrix: true });
    const detail = writeRowEvidence(root, row);
    row.vs_baseline = buildVsBaseline({
      row,
      baselineRow: row,
      selection: "explicit",
    });
    const planFile = path.join(detail, "plan.json");
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    plan.baseline_selection = "explicit";
    plan.baseline = baselinePlanIdentity(row);
    writeFileSync(planFile, JSON.stringify(plan));
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      new RegExp(
        `explicit baseline ${row.executed_at} must precede candidate ${row.executed_at}`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects an ineligible explicit baseline", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const baseline = makeRow({
      executedAt: "2026-08-08T10:00:00Z",
      fullMatrix: true,
    });
    baseline.notes = "leak suspected: test fixture";
    baseline.verdict = verdict({ contract, row: baseline }).verdict;
    const candidate = makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      fullMatrix: true,
    });
    candidate.detail_dir = "docs/evals/review-skill-runs/2026-09-08-candidate";
    candidate.vs_baseline = buildVsBaseline({
      row: candidate,
      baselineRow: baseline,
      selection: "explicit",
    });
    writeRowEvidence(root, baseline);
    const candidateDetail = writeRowEvidence(root, candidate);
    const planFile = path.join(candidateDetail, "plan.json");
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    plan.baseline = baselinePlanIdentity(baseline);
    writeFileSync(planFile, JSON.stringify(plan));
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseline)}\n${JSON.stringify(candidate)}\n`,
    );

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /explicit baseline .* is not eligible: baseline notes record a suspected leak/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended rejects complete evidence relabelled partial", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const row = makeRow({ fullMatrix: true });
    writeRowEvidence(root, row);
    row.status = "partial";
    row.verdict = verdict({ contract, row }).verdict;
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      /records partial status but calibration\.json proves a complete matrix/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended binds partial rows to every scored PR", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const scoredFixtures = contract.fixtures.filter(
      (fixture) => fixture.scorable_ids.length > 0,
    );
    assert.ok(scoredFixtures.length > 1);
    const [retainedFixture, omittedFixture] = scoredFixtures;
    const row = makeRow({
      matchedIds: scorableIdsFor([retainedFixture.pr]),
      status: "partial",
    });
    writeRowEvidence(root, row);
    const condition = row.conditions.pipeline;
    for (const id of omittedFixture.scorable_ids.map(String)) {
      delete condition.per_defect[id];
    }
    const omittedP1 = p1IdsFor([omittedFixture.pr]).length;
    condition.recall.opportunities -=
      omittedFixture.scorable_ids.length * condition.draws;
    condition.recall.rate = Number(
      (condition.recall.matched / condition.recall.opportunities).toFixed(3),
    );
    condition.p1.opportunities -= omittedP1 * condition.draws;
    condition.p1.rate =
      condition.p1.opportunities === 0
        ? null
        : Number(
            (condition.p1.matched / condition.p1.opportunities).toFixed(3),
          );
    row.verdict = verdict({ contract, row }).verdict;
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    assert.match(
      JSON.parse(checked.stdout).problems.join(" | "),
      new RegExp(
        `row condition pipeline omits frozen defect .* for scored result PR ${omittedFixture.pr}`,
      ),
    );

    for (let draw = 1; draw <= condition.draws; draw += 1) {
      rmSync(
        path.join(
          root,
          row.detail_dir,
          `result-${omittedFixture.pr}-pipeline-${draw}.json`,
        ),
      );
    }
    const concealedCompletion = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(concealedCompletion.status, 1);
    assert.match(
      JSON.parse(concealedCompletion.stdout).problems.join(" | "),
      /result files do not match calibration\.json completed_cell_ids/,
    );

    const calibrationFile = path.join(root, row.detail_dir, "calibration.json");
    const calibration = JSON.parse(readFileSync(calibrationFile, "utf8"));
    calibration.completed_cell_ids = calibration.completed_cell_ids.filter(
      (cellId) => !cellId.startsWith(`pr-${omittedFixture.pr}-pipeline-`),
    );
    writeFileSync(calibrationFile, JSON.stringify(calibration));
    const legitimatePartial = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(
      legitimatePartial.status,
      0,
      legitimatePartial.stdout + legitimatePartial.stderr,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run evidence reports malformed fixture contracts without hiding result defects", () => {
  const root = makeRoot();
  try {
    const row = makeRow({ fullMatrix: true });
    const detail = writeRowEvidence(root, row);
    const resultFile = path.join(detail, "result-1990-pipeline-1.json");
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    result.claims = [null];
    writeFileSync(resultFile, JSON.stringify(result));

    for (const malformedContract of [
      null,
      {},
      { fixtures: {} },
      { fixtures: [null] },
      { fixtures: [{ pr: "1990", scorable_ids: [] }] },
      { fixtures: [{ pr: 1990, scorable_ids: null }] },
    ]) {
      const problems = runEvidenceProblems({
        dir: detail,
        row,
        contract: malformedContract,
      });
      assert.equal(
        problems.filter((problem) =>
          problem.includes("contract.fixtures must be an array"),
        ).length,
        1,
        problems.join(" | "),
      );
      assert.ok(
        problems.some((problem) =>
          /claims must contain only non-empty strings/.test(problem),
        ),
        problems.join(" | "),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run evidence handles malformed fixture contracts for partial rows", () => {
  const root = makeRoot();
  try {
    const row = makeRow({ status: "partial" });
    const detail = writeRowEvidence(root, row);
    row.conditions.replay = structuredClone(row.conditions.pipeline);
    const problems = runEvidenceProblems({
      dir: detail,
      row,
      contract: { fixtures: [null] },
    });
    assert.equal(
      problems.filter((problem) =>
        problem.includes("contract.fixtures must be an array"),
      ).length,
      1,
      problems.join(" | "),
    );
    assert.ok(
      problems.some((problem) =>
        /carries no scored result for row condition replay/.test(problem),
      ),
      problems.join(" | "),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended checks a row against its committed plan", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    const flags = [
      "--check-ledger",
      "--revalidate-appended",
      "--base-ref",
      "HEAD",
      "--json",
    ];

    const row = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const detail = writeRowEvidence(root, row);
    const rowPath = path.join(root, "row.json");
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    assert.equal(
      cli(["--validate", rowPath, "--append", "--json"], { root }).status,
      0,
    );
    const clean = cli(flags, { root });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);

    writeFileSync(
      path.join(detail, "result-9999-pipeline-1.json"),
      JSON.stringify({
        cell_id: "pr-9999-pipeline-draw1",
        pr: 9999,
        condition: "pipeline",
        draw: 1,
        matched_ids: [],
      }),
    );
    const unplanned = cli(flags, { root });
    assert.equal(unplanned.status, 1);
    assert.match(
      JSON.parse(unplanned.stdout).problems.join(" | "),
      /carries unplanned result file result-9999-pipeline-1\.json/,
    );
    unlinkSync(path.join(detail, "result-9999-pipeline-1.json"));
    writeRowEvidence(root, row);

    const plannedResult = path.join(detail, "result-1990-pipeline-1.json");
    const originalVerdict = row.verdict;
    const misidentified = JSON.parse(readFileSync(plannedResult, "utf8"));
    misidentified.cell_id = "pr-1990-pipeline-draw2";
    writeFileSync(plannedResult, JSON.stringify(misidentified));
    const wrongIdentity = cli(flags, { root });
    assert.equal(wrongIdentity.status, 1);
    assert.match(
      JSON.parse(wrongIdentity.stdout).problems.join(" | "),
      /result-1990-pipeline-1\.json cell_id is .*plan\.json recorded "pr-1990-pipeline-draw1"/,
    );
    writeRowEvidence(root, row);

    const foreignFixture = contract.fixtures.find(
      (fixture) => fixture.pr !== 1990 && fixture.scorable_ids.length > 0,
    );
    assert.ok(foreignFixture);
    const foreignMatch = JSON.parse(readFileSync(plannedResult, "utf8"));
    foreignMatch.matched_ids.push(foreignFixture.scorable_ids[0]);
    writeFileSync(plannedResult, JSON.stringify(foreignMatch));
    const crossFixtureMatch = cli(flags, { root });
    assert.equal(crossFixtureMatch.status, 1);
    assert.match(
      JSON.parse(crossFixtureMatch.stdout).problems.join(" | "),
      /result-1990-pipeline-1\.json matched_ids contains .*fixture PR 1990 does not score/,
    );
    writeRowEvidence(root, row);

    for (const malformed of [undefined, null, ""]) {
      const malformedMatches = JSON.parse(readFileSync(plannedResult, "utf8"));
      if (malformed === undefined) {
        delete malformedMatches.matched_ids;
      } else {
        malformedMatches.matched_ids = malformed;
      }
      writeFileSync(plannedResult, JSON.stringify(malformedMatches));
      const malformedResult = cli(flags, { root });
      assert.equal(malformedResult.status, 1);
      assert.match(
        JSON.parse(malformedResult.stdout).problems.join(" | "),
        /result-1990-pipeline-1\.json matched_ids must be an array/,
      );
      writeRowEvidence(root, row);
    }

    const nestedMatch = JSON.parse(readFileSync(plannedResult, "utf8"));
    nestedMatch.matched_ids = [
      [
        contract.fixtures.find((fixture) => fixture.pr === 1990)
          .scorable_ids[0],
      ],
    ];
    writeFileSync(plannedResult, JSON.stringify(nestedMatch));
    const nestedResult = cli(flags, { root });
    assert.equal(nestedResult.status, 1);
    assert.match(
      JSON.parse(nestedResult.stdout).problems.join(" | "),
      /result-1990-pipeline-1\.json matched_ids contains non-scalar/,
    );
    writeRowEvidence(root, row);

    const negativeCounter = JSON.parse(readFileSync(plannedResult, "utf8"));
    negativeCounter.novel.novelWrong = -1;
    writeFileSync(plannedResult, JSON.stringify(negativeCounter));
    const negativeResult = cli(flags, { root });
    assert.equal(negativeResult.status, 1);
    assert.match(
      JSON.parse(negativeResult.stdout).problems.join(" | "),
      /result-1990-pipeline-1\.json novel\.novelWrong must be a nonnegative safe integer/,
    );
    writeRowEvidence(root, row);

    const invalidClaim = JSON.parse(readFileSync(plannedResult, "utf8"));
    invalidClaim.claims = [{}];
    writeFileSync(plannedResult, JSON.stringify(invalidClaim));
    const invalidClaimResult = cli(flags, { root });
    assert.equal(invalidClaimResult.status, 1);
    assert.match(
      JSON.parse(invalidClaimResult.stdout).problems.join(" | "),
      /result-1990-pipeline-1\.json claims must contain only non-empty strings/,
    );
    writeRowEvidence(root, row);

    const falseNovelSummary = JSON.parse(readFileSync(plannedResult, "utf8"));
    falseNovelSummary.novel.novelVague += 1;
    writeFileSync(plannedResult, JSON.stringify(falseNovelSummary));
    const falseNovelResult = cli(flags, { root });
    assert.equal(falseNovelResult.status, 1);
    assert.match(
      JSON.parse(falseNovelResult.stdout).problems.join(" | "),
      /result-1990-pipeline-1\.json novel\.novelVague does not match novel\.verdicts/,
    );
    writeRowEvidence(root, row);

    const missingRequiredEvidence = JSON.parse(
      readFileSync(plannedResult, "utf8"),
    );
    delete missingRequiredEvidence.scoring_usd;
    delete missingRequiredEvidence.leak;
    writeFileSync(plannedResult, JSON.stringify(missingRequiredEvidence));
    delete row.scoring_usd;
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const calibrationFile = path.join(detail, "calibration.json");
    const missingCalibrationCost = JSON.parse(
      readFileSync(calibrationFile, "utf8"),
    );
    delete missingCalibrationCost.scoring_usd;
    writeFileSync(calibrationFile, JSON.stringify(missingCalibrationCost));
    const missingRequiredResult = cli(flags, { root });
    assert.equal(missingRequiredResult.status, 1);
    const missingRequiredProblems = JSON.parse(
      missingRequiredResult.stdout,
    ).problems.join(" | ");
    assert.match(
      missingRequiredProblems,
      /result-1990-pipeline-1\.json scoring_usd must be a nonnegative finite number/,
    );
    assert.match(
      missingRequiredProblems,
      /result-1990-pipeline-1\.json leak must carry a hard array and suspected boolean/,
    );
    assert.match(
      missingRequiredProblems,
      /calibration\.json scoring_usd must be a nonnegative finite number/,
    );
    assert.match(
      missingRequiredProblems,
      /row\.scoring_usd must be a nonnegative finite number for scored evidence/,
    );
    const localMissingTotal = cli(
      ["--validate", rowPath, "--append", "--detail-dir", detail, "--json"],
      { root },
    );
    assert.equal(localMissingTotal.status, 1);
    assert.match(
      JSON.parse(localMissingTotal.stdout).problems.join(" | "),
      /row\.scoring_usd is missing; scored run detail requires a recorded judge cost total/,
    );
    row.scoring_usd = 0;
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    writeRowEvidence(root, row);

    const invalidResultCost = JSON.parse(readFileSync(plannedResult, "utf8"));
    invalidResultCost.scoring_usd = null;
    writeFileSync(plannedResult, JSON.stringify(invalidResultCost));
    const invalidCalibrationCost = JSON.parse(
      readFileSync(calibrationFile, "utf8"),
    );
    invalidCalibrationCost.scoring_usd = "1.25";
    writeFileSync(calibrationFile, JSON.stringify(invalidCalibrationCost));
    const invalidCostResult = cli(flags, { root });
    assert.equal(invalidCostResult.status, 1);
    const invalidCostProblems = JSON.parse(
      invalidCostResult.stdout,
    ).problems.join(" | ");
    assert.match(
      invalidCostProblems,
      /result-1990-pipeline-1\.json scoring_usd must be a nonnegative finite number/,
    );
    assert.match(
      invalidCostProblems,
      /calibration\.json scoring_usd must be a nonnegative finite number/,
    );
    writeRowEvidence(root, row);

    const invalidCellCost = JSON.parse(readFileSync(plannedResult, "utf8"));
    invalidCellCost.usd = null;
    invalidCellCost.seconds = "600";
    writeFileSync(plannedResult, JSON.stringify(invalidCellCost));
    const invalidCellCostResult = cli(flags, { root });
    assert.equal(invalidCellCostResult.status, 1);
    const invalidCellCostProblems = JSON.parse(
      invalidCellCostResult.stdout,
    ).problems.join(" | ");
    assert.match(
      invalidCellCostProblems,
      /result-1990-pipeline-1\.json usd must be a nonnegative finite number/,
    );
    assert.match(
      invalidCellCostProblems,
      /result-1990-pipeline-1\.json seconds must be a nonnegative finite number/,
    );
    writeRowEvidence(root, row);

    const leakedResult = JSON.parse(readFileSync(plannedResult, "utf8"));
    leakedResult.leak = { suspected: false, hard: ["answer key path"] };
    writeFileSync(plannedResult, JSON.stringify(leakedResult));
    const hiddenLeak = cli(flags, { root });
    assert.equal(hiddenLeak.status, 1);
    const leakProblems = JSON.parse(hiddenLeak.stdout).problems.join(" | ");
    assert.match(
      leakProblems,
      /leak\.suspected must equal whether leak\.hard is non-empty/,
    );
    assert.match(
      leakProblems,
      /row notes omit leak suspected.*row verdict is .* instead of AMBER/,
    );
    leakedResult.leak.suspected = true;
    writeFileSync(plannedResult, JSON.stringify(leakedResult));
    row.notes = "leak suspected: answer key path";
    row.verdict = "AMBER";
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    const preservedLeak = cli(flags, { root });
    assert.equal(
      preservedLeak.status,
      0,
      preservedLeak.stdout + preservedLeak.stderr,
    );
    row.notes = "";
    row.verdict = originalVerdict;
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    writeRowEvidence(root, row);

    // A scored explicit plan must retain its pairing. Removing vs_baseline and
    // changing the verdict to the unpaired result cannot erase that evidence.
    const planFile = path.join(detail, "plan.json");
    const explicitPlan = JSON.parse(readFileSync(planFile, "utf8"));
    explicitPlan.baseline_selection = "explicit";
    explicitPlan.baseline = {
      executed_at: "2026-08-08T10:00:00Z",
      contract_digest: row.contract_digest,
      comparability_key: row.comparability_key,
      detail_dir: "docs/evals/review-skill-runs/baseline",
      row_digest: "0".repeat(64),
    };
    writeFileSync(planFile, JSON.stringify(explicitPlan));
    const lostPairing = cli(flags, { root });
    assert.equal(lostPairing.status, 1);
    assert.match(
      JSON.parse(lostPairing.stdout).problems.join(" | "),
      /row has no vs_baseline; plan\.json in .* planned an explicit baseline/,
    );
    writeRowEvidence(root, row);

    // plan.json is branch-editable evidence. Removing one planned cell and its
    // result cannot make that cell disappear from the frozen contract matrix.
    const thinnedPlan = JSON.parse(readFileSync(planFile, "utf8"));
    const removedCell = thinnedPlan.cells.pop();
    writeFileSync(planFile, JSON.stringify(thinnedPlan));
    rmSync(
      path.join(
        detail,
        `result-${removedCell.pr}-${removedCell.condition}-${removedCell.draw}.json`,
      ),
    );
    const thinned = cli(flags, { root });
    assert.equal(thinned.status, 1);
    assert.match(
      JSON.parse(thinned.stdout).problems.join(" | "),
      /plan\.json in .* cells do not match the frozen full matrix/,
    );
    writeRowEvidence(root, row);

    // Re-keying a first full row after the local append leaves its no-baseline
    // GREEN verdict, its bits and its counters all intact, and opens a lineage
    // no run produced — which `resolveBaseline` would then anchor on.
    const ledgerPath = path.join(root, ledgerRelative);
    const [committed] = readLedger(ledgerPath);
    committed.comparability_key = "9".repeat(64);
    writeFileSync(ledgerPath, `${JSON.stringify(committed)}\n`);
    const rekeyed = cli(flags, { root });
    assert.equal(rekeyed.status, 1);
    assert.match(
      JSON.parse(rekeyed.stdout).problems.join(" | "),
      /row comparability_key is "9+"; plan\.json in .* planned/,
    );

    const rekeyedPlan = JSON.parse(readFileSync(planFile, "utf8"));
    rekeyedPlan.comparability_key = committed.comparability_key;
    writeFileSync(planFile, JSON.stringify(rekeyedPlan));
    const jointlyRekeyed = cli(flags, { root });
    assert.equal(jointlyRekeyed.status, 1);
    assert.match(
      JSON.parse(jointlyRekeyed.stdout).problems.join(" | "),
      /current frozen inputs derive/,
    );
    writeRowEvidence(root, row);

    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        ...row,
        conditions: {
          ...row.conditions,
          pipeline: { ...row.conditions.pipeline, model: "forged-model" },
        },
      })}\n`,
    );
    const reprovenanced = cli(flags, { root });
    assert.equal(reprovenanced.status, 1);
    assert.match(
      JSON.parse(reprovenanced.stdout).problems.join(" | "),
      /row condition pipeline\.model is "forged-model"/,
    );

    writeFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
    for (const file of readdirSync(detail)) {
      if (file === "calibration.json" || file.startsWith("result-")) {
        rmSync(path.join(detail, file));
      }
    }
    const evidenceFree = cli(flags, { root });
    assert.equal(evidenceFree.status, 1);
    assert.match(
      JSON.parse(evidenceFree.stdout).problems.join(" | "),
      /carries no scored result-\*\.json files.*carries no calibration\.json/,
    );
    writeRowEvidence(root, row);

    // Deleting the plan does not buy the check back: a directory that holds
    // cell results must hold the plan that produced them.
    writeFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
    rmSync(path.join(detail, "plan.json"));
    writeFileSync(
      path.join(detail, "result-x.json"),
      JSON.stringify({ pr: 1990, draw: 1, matched_ids: [], claims: [] }),
    );
    const deleted = cli(flags, { root });
    assert.equal(deleted.status, 1);
    assert.match(
      JSON.parse(deleted.stdout).problems.join(" | "),
      /carries no plan\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--revalidate-appended binds candidate status to execution evidence", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const row = makeRow({ fullMatrix: true });
    row.inputs = {
      ...row.inputs,
      skill_ref: "/tmp/review-candidate",
      dirty: true,
    };
    const detail = writeRowEvidence(root, row);

    row.inputs = { ...row.inputs, skill_ref: "installed" };
    delete row.inputs.dirty;
    const planFile = path.join(detail, "plan.json");
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    plan.inputs = row.inputs;
    writeFileSync(planFile, JSON.stringify(plan));
    const rowPath = path.join(detail, "row.json");
    writeFileSync(rowPath, JSON.stringify(row));
    const validated = cli(["--validate", rowPath, "--json"], { root });
    assert.equal(validated.status, 1);
    const validationProblems = JSON.parse(validated.stdout).problems.join(
      " | ",
    );
    assert.match(
      validationProblems,
      /result-.* treatment does not match the plan execution inputs/,
    );
    assert.match(
      validationProblems,
      /calibration\.json treatment does not match the plan execution inputs/,
    );

    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);

    const checked = cli(
      [
        "--check-ledger",
        "--revalidate-appended",
        "--base-ref",
        "HEAD",
        "--json",
      ],
      { root },
    );
    assert.equal(checked.status, 1);
    const problems = JSON.parse(checked.stdout).problems.join(" | ");
    assert.match(
      problems,
      /result-.* treatment does not match the plan execution inputs/,
    );
    assert.match(
      problems,
      /calibration\.json treatment does not match the plan execution inputs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hand-assembled bridge row keeps the full run's plan", () => {
  // Model retirement (docs/evals/review-skill.md) copies the newer full run's
  // row.json, changes `kind` to "bridge", and validates it against that run's
  // own detail directory — the only way to get a bridge row, because no CLI
  // mode plans one. Demanding plan parity on `kind` therefore failed the
  // required `--revalidate-appended` step for every legitimate bridge row.
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-bridge-"));
  try {
    const row = makeRow({
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    const plan = {
      contract_digest: row.contract_digest,
      comparability_key: row.comparability_key,
      kind: "full",
      detail_dir: row.detail_dir,
      baseline_selection: "automatic",
      baseline: null,
      inputs: row.inputs,
      cells: planCells({ contract, kind: "full" }),
    };
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
    assert.deepEqual(planProvenanceProblems({ dir, row, contract }), []);
    assert.deepEqual(
      planProvenanceProblems({
        dir,
        row: { ...row, kind: "bridge" },
        contract,
      }),
      [],
    );

    // Nothing else about a bridge row is waived. Re-keying it after the append
    // still opens a lineage no run produced.
    assert.match(
      planProvenanceProblems({
        dir,
        row: { ...row, kind: "bridge", comparability_key: "9".repeat(64) },
        contract,
      }).join(" | "),
      /row comparability_key is "9+"; plan\.json in .* planned/,
    );

    // And the waiver is only the documented transition: a canary plan relabeled
    // as a bridge is still an edit, as is a canary row over a full plan.
    writeFileSync(
      path.join(dir, "plan.json"),
      JSON.stringify({ ...plan, kind: "canary" }),
    );
    assert.match(
      planProvenanceProblems({
        dir,
        row: { ...row, kind: "bridge" },
        contract,
      }).join(" | "),
      /row kind is "bridge"; plan\.json in .* planned "canary"/,
    );
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
    assert.match(
      planProvenanceProblems({
        dir,
        row: { ...row, kind: "canary" },
        contract,
      }).join(" | "),
      /row kind is "canary"; plan\.json in .* planned "full"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--revalidate-appended accepts an explicit bridge pairing", () => {
  const root = makeRoot();
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");

    const retiring = makeRow({
      executedAt: "2026-08-08T10:00:00Z",
      fullMatrix: true,
    });
    const newer = makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      fullMatrix: true,
    });
    newer.detail_dir = "docs/evals/review-skill-runs/2026-09-08-new-model";
    const bridge = JSON.parse(JSON.stringify(newer));
    bridge.kind = "bridge";
    bridge.vs_baseline = buildVsBaseline({
      row: bridge,
      baselineRow: retiring,
      selection: "explicit",
    });
    bridge.verdict = verdict({
      contract,
      row: bridge,
      baselineRow: retiring,
      baselineIsExplicit: true,
    }).verdict;
    writeRowEvidence(root, retiring);
    writeRowEvidence(root, newer);
    const ledgerPath = path.join(root, ledgerRelative);
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(retiring)}\n${JSON.stringify(bridge)}\n`,
    );
    const flags = [
      "--check-ledger",
      "--revalidate-appended",
      "--base-ref",
      "HEAD",
      "--json",
    ];
    const checked = cli(flags, { root });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);

    rmSync(path.join(root, newer.detail_dir), {
      recursive: true,
      force: true,
    });
    mkdirSync(path.join(root, newer.detail_dir), { recursive: true });
    const missingBridgeEvidence = cli(flags, { root });
    assert.equal(missingBridgeEvidence.status, 1);
    const missingBridgeProblems = JSON.parse(
      missingBridgeEvidence.stdout,
    ).problems.join(" | ");
    assert.match(missingBridgeProblems, /carries no plan\.json/);
    assert.match(
      missingBridgeProblems,
      /carries no scored result-\*\.json files/,
    );
    writeRowEvidence(root, newer);

    const retiringVerdict = retiring.verdict;
    retiring.notes = "leak suspected: test fixture";
    retiring.verdict = verdict({ contract, row: retiring }).verdict;
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(retiring)}\n${JSON.stringify(bridge)}\n`,
    );
    const ineligibleBridgeBaseline = cli(flags, { root });
    assert.equal(ineligibleBridgeBaseline.status, 1);
    assert.match(
      JSON.parse(ineligibleBridgeBaseline.stdout).problems.join(" | "),
      /explicit baseline .* is not eligible: baseline notes record a suspected leak/,
    );
    retiring.notes = "";
    retiring.verdict = retiringVerdict;
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(retiring)}\n${JSON.stringify(bridge)}\n`,
    );
    writeRowEvidence(root, newer);

    const bridgeVerdict = bridge.verdict;
    const bridgeResult = path.join(
      root,
      newer.detail_dir,
      "result-1990-pipeline-1.json",
    );
    const leakedResult = JSON.parse(readFileSync(bridgeResult, "utf8"));
    leakedResult.leak = { suspected: true, hard: ["answer key path"] };
    writeFileSync(bridgeResult, JSON.stringify(leakedResult));
    const hiddenBridgeLeak = cli(flags, { root });
    assert.equal(hiddenBridgeLeak.status, 1);
    assert.match(
      JSON.parse(hiddenBridgeLeak.stdout).problems.join(" | "),
      /row notes omit leak suspected.*row verdict is .* instead of AMBER/,
    );
    bridge.notes = "leak suspected: answer key path";
    bridge.verdict = "AMBER";
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(retiring)}\n${JSON.stringify(bridge)}\n`,
    );
    const preservedBridgeLeak = cli(flags, { root });
    assert.equal(
      preservedBridgeLeak.status,
      0,
      preservedBridgeLeak.stdout + preservedBridgeLeak.stderr,
    );
    bridge.notes = "";
    bridge.verdict = bridgeVerdict;
    writeRowEvidence(root, newer);

    delete bridge.vs_baseline.selection;
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(retiring)}\n${JSON.stringify(bridge)}\n`,
    );
    const missingSelection = cli(flags, { root });
    assert.equal(missingSelection.status, 1);
    assert.match(
      JSON.parse(missingSelection.stdout).problems.join(" | "),
      /vs_baseline\.selection must record automatic or explicit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scheduler ages the ledger at the instant it runs", () => {
  const root = makeRoot();
  try {
    // A row merged at 09:00 UTC on the day the 09:23 workflow fires. Aged from
    // midnight it is future-dated, which `freshness()` refuses to let run any
    // clock: the workflow goes red and files a staleness issue over a run that
    // is already committed. `parseArgs` records the actual instant instead, and
    // reserves midnight for an explicitly dated `--date`.
    const row = makeRow({
      executedAt: "2027-06-01T09:00:00Z",
      matchedIds: scorableIdsFor([1990]),
      fullMatrix: true,
    });
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    const options = {
      ledgerPath: ledgerRelative,
      repo: "mento-protocol/monitoring-monorepo",
      date: "2027-06-01",
      dryRun: false,
    };
    const context = { repoRoot: root, contract, contractDigest };
    const deps = {
      listIssues: async () => [],
      authorize: async () => {},
      ensureLabels: async () => {},
      createIssue: async () => {},
    };
    return Promise.all([
      runScheduleIssue(
        { ...options, now: "2027-06-01T09:23:00Z" },
        context,
        deps,
      ),
      runScheduleIssue(options, context, deps),
    ]).then(([atRunTime, atMidnight]) => {
      assert.equal(atRunTime.action, "skip-fresh");
      assert.equal(atRunTime.level, "green");
      // The bug, pinned: the same ledger aged from midnight ignores the row.
      assert.equal(atMidnight.level, "red");
      assert.match(
        atMidnight.reasons.join(" | "),
        /dated after the evaluation/,
      );
      // The CLI takes the current instant unless --date names a day.
      assert.equal(
        parseArgs(["--schedule-issue", "--date", "2027-06-01"]).now,
        "2027-06-01T00:00:00Z",
      );
      const live = parseArgs(["--schedule-issue"]);
      assert.match(live.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(new Date(live.now).valueOf() > Date.now() - 60_000);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-eval.sh resets a fixture to the commit the contract pins", () => {
  // Cells run with bypassPermissions and a real Bash tool. An argument-free
  // `git reset --hard` restores whatever HEAD names now, so a contestant that
  // committed its own edits — or a prompt-injected commit out of the diff under
  // review — makes that commit the fixture for every later cell of the PR, for
  // the novelty judge and for the pre-judge login snapshot.
  const shell = runEvalSourceSet();
  const reset = shell.match(/\nreset_fixture\(\) \{\n[\s\S]*?\n\}\n/)?.[0];
  assert.ok(reset, "reset_fixture was not found in run-eval.sh");
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-reset-"));
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    writeFileSync(path.join(dir, "reviewed.txt"), "the change under review\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "first head");
    const pinned = git("rev-parse", "HEAD").stdout.trim();

    // What a cell can do to the checkout: edit the tree, drop an untracked
    // file, and commit the result so HEAD no longer names the pinned commit.
    writeFileSync(path.join(dir, "reviewed.txt"), "rewritten by a cell\n");
    writeFileSync(path.join(dir, "scratch.txt"), "left behind\n");
    git("add", "reviewed.txt");
    git("commit", "--quiet", "-m", "a contestant commit");
    assert.notEqual(git("rev-parse", "HEAD").stdout.trim(), pinned);

    const harness = [
      "set -euo pipefail",
      reset,
      'reset_fixture "$1" "$2"',
    ].join("\n");
    const run = spawnSync("bash", ["-c", harness, "bash", dir, pinned], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(git("rev-parse", "HEAD").stdout.trim(), pinned);
    assert.equal(
      readFileSync(path.join(dir, "reviewed.txt"), "utf8"),
      "the change under review\n",
    );
    assert.equal(existsSync(path.join(dir, "scratch.txt")), false);

    // A commit the fixture does not carry fails the cell instead of leaving it
    // to review whatever tree happened to be there.
    const missing = spawnSync(
      "bash",
      ["-c", harness, "bash", dir, "0".repeat(40)],
      { encoding: "utf8" },
    );
    assert.notEqual(missing.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every cell resets its fixture through reset_fixture", () => {
  const shell = runEvalSourceSet();
  // The pinned head travels beside the path, and no bare reset survives: an
  // argument-free one is the whole defect.
  assert.match(shell, /reset_fixture "\$fixture" "\$fixture_head"/);
  assert.doesNotMatch(shell, /reset --hard --quiet\n/);
  assert.match(shell, /FIXTURE_HEAD="\$\{FIXTURE_HEADS\[\$index\]\}"/);
});
