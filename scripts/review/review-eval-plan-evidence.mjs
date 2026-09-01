import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseInstant } from "./review-eval-ledger.mjs";
import { baselineEligibility, leakSuspected } from "./review-eval-report.mjs";
import {
  baselinePlanIdentity,
  cellFingerprint,
  planCells,
  treatmentIdentity,
} from "./review-eval-run.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

export function holdsCellResults(dir) {
  try {
    return readdirSync(dir).some(
      (name) => name.startsWith("result-") && name.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

/** Reject evidence links and special files before any JSON reader follows them. */
export function nonRegularEvidenceProblems(dir) {
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
 * hand-assembled bridge reuses the source full run's plan and scored evidence,
 * so it must retain that plan too.
 */
export function planProvenanceProblems({
  dir,
  row,
  contract,
  baselineRow = null,
  expectedComparabilityKey = null,
  requirePortablePlanDir = false,
}) {
  const problems = [];
  const checkBaselineStanding = () => {
    if (baselineRow === null) return;
    const eligibility = baselineEligibility(baselineRow);
    if (!eligibility.usable) {
      problems.push(
        `explicit baseline ${baselineRow.executed_at} is not eligible: ${eligibility.reason}`,
      );
    }
    if (!(baselineRow.executed_at < row.executed_at)) {
      problems.push(
        `explicit baseline ${baselineRow.executed_at} must precede candidate ${row.executed_at}`,
      );
    }
  };
  if (row.kind === "bridge") checkBaselineStanding();
  const file = path.join(dir, "plan.json");
  if (!existsSync(file)) {
    problems.push(
      `${dir} carries no plan.json; the row's provenance cannot be checked against the run that produced it`,
    );
    return problems;
  }
  let plan;
  try {
    plan = readJson(file);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }
  if (
    requirePortablePlanDir &&
    (typeof plan.plan_dir !== "string" ||
      path.isAbsolute(plan.plan_dir) ||
      plan.plan_dir !== row.detail_dir)
  ) {
    problems.push(
      `plan.json in ${row.detail_dir} must carry the same repository-relative plan_dir as the row detail_dir before publication; found ${JSON.stringify(plan.plan_dir)}`,
    );
  }
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
  if (plan.baseline_selection === "explicit" && row.kind !== "bridge") {
    checkBaselineStanding();
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
export function resultEvidenceProblems({ dir, row }) {
  if (row.status === "failed" || !existsSync(dir)) return [];
  const regularityProblems = nonRegularEvidenceProblems(dir);
  if (regularityProblems.length > 0) return regularityProblems;
  const problems = [];
  let expectedFingerprint = null;
  let expectedTreatment = null;
  try {
    const plan = readJson(path.join(dir, "plan.json"));
    expectedFingerprint = cellFingerprint({ plan });
    expectedTreatment = treatmentIdentity({ plan });
  } catch {
    // planProvenanceProblems reports a missing or unreadable plan.
  }
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
      if (
        expectedFingerprint !== null &&
        JSON.stringify(record?.fingerprint) !==
          JSON.stringify(expectedFingerprint)
      ) {
        problems.push(
          `${dir}/${resultFile} fingerprint does not match the plan execution inputs`,
        );
      }
      if (
        expectedTreatment !== null &&
        JSON.stringify(record?.treatment) !== JSON.stringify(expectedTreatment)
      ) {
        problems.push(
          `${dir}/${resultFile} treatment does not match the plan execution inputs`,
        );
      }
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
      if (
        expectedFingerprint !== null &&
        JSON.stringify(calibration?.fingerprint) !==
          JSON.stringify(expectedFingerprint)
      ) {
        problems.push(
          `${dir}/calibration.json fingerprint does not match the plan execution inputs`,
        );
      }
      if (
        expectedTreatment !== null &&
        JSON.stringify(calibration?.treatment) !==
          JSON.stringify(expectedTreatment)
      ) {
        problems.push(
          `${dir}/calibration.json treatment does not match the plan execution inputs`,
        );
      }
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
