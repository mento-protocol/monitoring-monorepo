// Cell scoring, condition folding, row assembly, and freshness planning.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  defaultRunGit,
  fixtureForPr,
  forbiddenShasForFixture,
} from "./review-eval-fixtures.mjs";
import { baselinePreflightProblems } from "./review-eval-ledger.mjs";
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
} from "./review-eval-score.mjs";
import {
  cellFingerprint,
  cellReuseDecision,
  leakSignals,
  loginsInFixtureTree,
  reviewerLogins,
  treatmentIdentity,
} from "./review-eval-run-cell.mjs";
import { resetFixture } from "./review-eval-run-execution.mjs";
import { baselinePlanIdentity, planCells } from "./review-eval-run-plan.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

/** Read, verify, and parse the same truth bytes that scoring will retain. */
function readPinnedTruth(repoRoot, fixture) {
  const file = path.join(repoRoot, fixture.truth_file);
  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== fixture.truth_sha256) {
    throw new Error(
      `truth ${fixture.truth_file} changed after frozen-input verification; expected ${fixture.truth_sha256}, got ${digest}`,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
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
async function scoreOneCell({
  cell,
  cellResult,
  fingerprint,
  treatment,
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
  const judgeEffort = contract.judge.effort;
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
  const claims = await extractClaims({
    transcript,
    exec,
    model,
    effort: judgeEffort,
  });
  const matched = await matchClaims({
    effort: judgeEffort,
    claims,
    truthFindings: truth.findings,
    scorableIds: fixture.scorable_ids,
    transcript,
    exec,
    model,
  });
  const novel = await classifyNovel({
    effort: judgeEffort,
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
    treatment,
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
  if (plan.contract_digest !== contractDigest) {
    throw new Error("plan contract digest does not match the scoring contract");
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
  const treatment = treatmentIdentity({ plan });
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
      return [pr, readPinnedTruth(repoRoot, fixture)];
    }),
  );
  const scoringCost = { usd: 0 };
  const metered = meterExec(exec, scoringCost);
  const calibrationCost = { usd: 0 };
  const calibration = await runCalibration({
    calibrationSet,
    exec: meterExec(metered, calibrationCost),
    model: contract.judge.model,
    effort: contract.judge.effort,
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
          treatment,
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
      treatment,
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
