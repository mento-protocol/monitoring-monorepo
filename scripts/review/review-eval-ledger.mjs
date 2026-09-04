/**
 * Append-only score ledger for the recurring review-skill evaluation.
 *
 * `docs/evals/review-skill-ledger.jsonl` holds one JSON object per run. The
 * contract in `docs/evals/review-skill-fixtures.json` fixes what a run may
 * score against; `docs/evals/review-skill-result.schema.json` fixes the row
 * envelope. This module owns reading, appending, validating, and aging that
 * ledger. It never calls a model and never reads a file mtime: git does not
 * preserve mtimes, so run age comes from `executed_at` alone.
 *
 * The structural validator here mirrors the JSON Schema field for field so the
 * repository keeps its no-new-dependency rule. `review-eval-ledger.test.mjs`
 * cross-checks the two so they cannot drift apart silently.
 */

import { appendFileSync, readFileSync } from "node:fs";

import { plannedMatrix } from "./review-eval-fixtures.mjs";
import {
  installedSkillRun,
  judgeCalibrationPasses,
  leakSuspected,
} from "./review-eval-report.mjs";

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_KINDS = ["full", "canary", "bridge"];
export const LEDGER_STATUSES = ["complete", "partial", "failed"];
export const LEDGER_VERDICTS = [
  "GREEN",
  "AMBER",
  "RED",
  "PROMOTE",
  "INCOMPLETE",
];
export const CONDITION_NAMES = ["pipeline", "replay", "control"];

export const ROW_REQUIRED_KEYS = [
  "schema_version",
  "kind",
  "executed_at",
  "status",
  "verdict",
  "comparability_key",
  "contract_digest",
  "inputs",
  "conditions",
  "judge_calibration",
  "vs_baseline",
  "detail_dir",
  "notes",
];
export const ROW_OPTIONAL_KEYS = ["scoring_usd"];

export const INPUTS_REQUIRED_KEYS = [
  "skill_digest",
  "skill_ref",
  "finder_argv_digest",
  "orchestrator_digest",
  "claude_cli",
  "codex_cli",
  "host",
];
export const INPUTS_OPTIONAL_KEYS = ["dirty"];

export const CONDITION_REQUIRED_KEYS = [
  "model",
  "effort",
  "draws",
  "recall",
  "p1",
  "novel_real",
  "wrong_claims",
  "usd",
  "seconds",
  "per_defect",
];
export const CONDITION_OPTIONAL_KEYS = ["finder", "zero_finding_prs"];

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RATE_TOLERANCE = 0.001;
const MS_PER_DAY = 86_400_000;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value, label, required, optional, problems) {
  if (!isObject(value)) {
    problems.push(`${label} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) problems.push(`${label} is missing ${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      problems.push(`${label} has unexpected property ${key}`);
    }
  }
  return true;
}

function checkDigest(value, label, problems) {
  if (!DIGEST_PATTERN.test(value ?? "")) {
    problems.push(`${label} must be a lowercase sha256`);
  }
}

function checkNonEmptyString(value, label, problems) {
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${label} must be a non-empty string`);
  }
}

function checkInteger(value, label, problems, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    problems.push(`${label} must be an integer of at least ${min}`);
  }
}

function checkNumber(value, label, problems, { min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    problems.push(`${label} must be a number of at least ${min}`);
  }
}

// The one date-time shape every producer here writes: `toISOString()` with the
// millisecond field stripped. Anything else is refused rather than parsed.
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Parse a canonical UTC date-time; return null when it is not one.
 *
 * `new Date(value)` accepts far more than the schema promises — "0", "2026-9-8"
 * and RFC-style dates all parse — and baseline resolution orders rows by
 * `executed_at`. A row carrying any of those would pass validation and then
 * sort or filter against every canonical row incorrectly, so the format is
 * required, not merely parseable. The round-trip check is what
 * refuses a well-shaped impossible date such as `2026-02-31T00:00:00Z`, which
 * `Date` silently rolls forward into March.
 */
export function parseInstant(value) {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z") === value
    ? parsed
    : null;
}

/** Write one instant in the canonical shape, or null when there is none. */
export function canonicalInstant(instant) {
  return instant ? instant.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

function checkInstant(value, label, problems) {
  if (!parseInstant(value)) {
    problems.push(
      `${label} must be a canonical UTC date-time (YYYY-MM-DDTHH:MM:SSZ)`,
    );
  }
}

function validateCount(count, label, problems) {
  if (
    !checkKeys(
      count,
      label,
      ["matched", "opportunities", "rate"],
      [],
      problems,
    ) ||
    !isObject(count)
  ) {
    return;
  }
  checkInteger(count.matched, `${label}.matched`, problems);
  checkInteger(count.opportunities, `${label}.opportunities`, problems);
  // `null` is the no-opportunity sentinel that `aggregateDraws` and
  // `failedRow` emit. It is not 0: `verdict()` skips the `p1_recall_floor`
  // check on a null rate rather than reading 0/0 as zero recall, so a numeric
  // 0 there would red a condition that simply has no P1 defect to score.
  if (count.rate === null) {
    if (count.opportunities !== 0) {
      problems.push(
        `${label}.rate may be null only when ${label}.opportunities is 0`,
      );
    }
  } else {
    checkNumber(count.rate, `${label}.rate`, problems);
  }
  if (
    Number.isSafeInteger(count.matched) &&
    Number.isSafeInteger(count.opportunities)
  ) {
    if (count.matched > count.opportunities) {
      problems.push(`${label}.matched exceeds ${label}.opportunities`);
    }
    if (typeof count.rate === "number" && Number.isFinite(count.rate)) {
      const expected =
        count.opportunities === 0 ? 0 : count.matched / count.opportunities;
      if (Math.abs(count.rate - expected) > RATE_TOLERANCE) {
        problems.push(
          `${label}.rate ${count.rate} does not match ${count.matched}/${count.opportunities}`,
        );
      }
    }
  }
}

function validateMcnemar(value, label, problems) {
  if (!checkKeys(value, label, ["b", "c", "delta"], [], problems)) return;
  checkInteger(value.b, `${label}.b`, problems);
  checkInteger(value.c, `${label}.c`, problems);
  if (!Number.isSafeInteger(value.delta)) {
    problems.push(`${label}.delta must be an integer`);
  } else if (
    Number.isSafeInteger(value.b) &&
    Number.isSafeInteger(value.c) &&
    value.delta !== value.b - value.c
  ) {
    problems.push(`${label}.delta must equal b - c`);
  }
}

function validateCondition(condition, label, problems) {
  if (
    !checkKeys(
      condition,
      label,
      CONDITION_REQUIRED_KEYS,
      CONDITION_OPTIONAL_KEYS,
      problems,
    )
  ) {
    return;
  }
  checkNonEmptyString(condition.model, `${label}.model`, problems);
  checkNonEmptyString(condition.effort, `${label}.effort`, problems);
  if (Object.hasOwn(condition, "finder")) {
    checkNonEmptyString(condition.finder, `${label}.finder`, problems);
  }
  if (Object.hasOwn(condition, "zero_finding_prs")) {
    checkInteger(
      condition.zero_finding_prs,
      `${label}.zero_finding_prs`,
      problems,
    );
  }
  checkInteger(condition.draws, `${label}.draws`, problems, { min: 1 });
  validateCount(condition.recall, `${label}.recall`, problems);
  validateCount(condition.p1, `${label}.p1`, problems);
  if (
    Number.isSafeInteger(condition.recall?.opportunities) &&
    Number.isSafeInteger(condition.p1?.opportunities) &&
    condition.p1.opportunities > condition.recall.opportunities
  ) {
    problems.push(`${label}.p1.opportunities exceeds ${label}.recall`);
  }
  checkInteger(condition.novel_real, `${label}.novel_real`, problems);
  checkInteger(condition.wrong_claims, `${label}.wrong_claims`, problems);
  checkNumber(condition.usd, `${label}.usd`, problems);
  checkNumber(condition.seconds, `${label}.seconds`, problems);
  if (!isObject(condition.per_defect)) {
    problems.push(`${label}.per_defect must be an object`);
    return;
  }
  for (const [id, vector] of Object.entries(condition.per_defect)) {
    const vectorLabel = `${label}.per_defect.${id}`;
    if (!/^[0-9]+$/.test(id)) {
      problems.push(`${vectorLabel} key must be a defect id`);
    }
    if (!Array.isArray(vector) || vector.length === 0) {
      problems.push(`${vectorLabel} must be a non-empty array`);
      continue;
    }
    if (!vector.every((bit) => bit === 0 || bit === 1)) {
      problems.push(`${vectorLabel} must contain only 0 or 1`);
    }
    // A defect carries one bit per draw its own PR completed, so a PR that ran
    // fewer draws than the condition has a shorter vector. More bits than the
    // condition has draws is still a contradiction.
    if (
      Number.isSafeInteger(condition.draws) &&
      vector.length > condition.draws
    ) {
      problems.push(
        `${vectorLabel} has ${vector.length} bits for ${condition.draws} draws`,
      );
    }
  }
}

/** Validate one ledger row against the committed schema. Returns problems. */
export function validateLedgerRow(row, label = "row") {
  const problems = [];
  if (!checkKeys(row, label, ROW_REQUIRED_KEYS, ROW_OPTIONAL_KEYS, problems)) {
    return problems;
  }
  if (row.schema_version !== LEDGER_SCHEMA_VERSION) {
    problems.push(`${label}.schema_version must be ${LEDGER_SCHEMA_VERSION}`);
  }
  if (!LEDGER_KINDS.includes(row.kind)) {
    problems.push(`${label}.kind must be one of ${LEDGER_KINDS.join(", ")}`);
  }
  if (!LEDGER_STATUSES.includes(row.status)) {
    problems.push(
      `${label}.status must be one of ${LEDGER_STATUSES.join(", ")}`,
    );
  }
  if (!LEDGER_VERDICTS.includes(row.verdict)) {
    problems.push(
      `${label}.verdict must be one of ${LEDGER_VERDICTS.join(", ")}`,
    );
  }
  checkInstant(row.executed_at, `${label}.executed_at`, problems);
  checkDigest(row.comparability_key, `${label}.comparability_key`, problems);
  checkDigest(row.contract_digest, `${label}.contract_digest`, problems);
  checkNonEmptyString(row.detail_dir, `${label}.detail_dir`, problems);
  if (typeof row.notes !== "string") {
    problems.push(`${label}.notes must be a string`);
  }
  // What the scorer spent on judges. Absent on a failed run, which never
  // reached a judge, and on any row written before the field existed.
  if (Object.hasOwn(row, "scoring_usd")) {
    checkNumber(row.scoring_usd, `${label}.scoring_usd`, problems);
  }

  if (
    checkKeys(
      row.inputs,
      `${label}.inputs`,
      INPUTS_REQUIRED_KEYS,
      INPUTS_OPTIONAL_KEYS,
      problems,
    )
  ) {
    checkDigest(
      row.inputs.skill_digest,
      `${label}.inputs.skill_digest`,
      problems,
    );
    checkDigest(
      row.inputs.finder_argv_digest,
      `${label}.inputs.finder_argv_digest`,
      problems,
    );
    checkDigest(
      row.inputs.orchestrator_digest,
      `${label}.inputs.orchestrator_digest`,
      problems,
    );
    for (const field of ["skill_ref", "claude_cli", "codex_cli", "host"]) {
      checkNonEmptyString(
        row.inputs[field],
        `${label}.inputs.${field}`,
        problems,
      );
    }
    if (
      Object.hasOwn(row.inputs, "dirty") &&
      typeof row.inputs.dirty !== "boolean"
    ) {
      problems.push(`${label}.inputs.dirty must be a boolean`);
    }
  }

  if (
    checkKeys(
      row.conditions,
      `${label}.conditions`,
      [],
      CONDITION_NAMES,
      problems,
    )
  ) {
    const names = Object.keys(row.conditions).filter((name) =>
      CONDITION_NAMES.includes(name),
    );
    if (names.length === 0) {
      problems.push(`${label}.conditions must carry at least one condition`);
    }
    for (const name of names) {
      validateCondition(
        row.conditions[name],
        `${label}.conditions.${name}`,
        problems,
      );
    }
  }

  if (
    checkKeys(
      row.judge_calibration,
      `${label}.judge_calibration`,
      ["agreement", "total"],
      [],
      problems,
    )
  ) {
    checkInteger(
      row.judge_calibration.agreement,
      `${label}.judge_calibration.agreement`,
      problems,
    );
    checkInteger(
      row.judge_calibration.total,
      `${label}.judge_calibration.total`,
      problems,
      { min: 1 },
    );
    if (
      Number.isSafeInteger(row.judge_calibration.agreement) &&
      Number.isSafeInteger(row.judge_calibration.total) &&
      row.judge_calibration.agreement > row.judge_calibration.total
    ) {
      problems.push(`${label}.judge_calibration.agreement exceeds total`);
    }
  }

  if (row.vs_baseline !== null) {
    if (
      checkKeys(
        row.vs_baseline,
        `${label}.vs_baseline`,
        ["baseline_executed_at", "mcnemar"],
        ["baseline_comparability_key", "control_mcnemar", "selection"],
        problems,
      )
    ) {
      checkInstant(
        row.vs_baseline.baseline_executed_at,
        `${label}.vs_baseline.baseline_executed_at`,
        problems,
      );
      // A null McNemar records a baseline that was named but never paired
      // with: the two rows carry different comparability keys.
      if (row.vs_baseline.mcnemar !== null) {
        validateMcnemar(
          row.vs_baseline.mcnemar,
          `${label}.vs_baseline.mcnemar`,
          problems,
        );
      }
      if (Object.hasOwn(row.vs_baseline, "control_mcnemar")) {
        validateMcnemar(
          row.vs_baseline.control_mcnemar,
          `${label}.vs_baseline.control_mcnemar`,
          problems,
        );
      }
      if (Object.hasOwn(row.vs_baseline, "baseline_comparability_key")) {
        checkDigest(
          row.vs_baseline.baseline_comparability_key,
          `${label}.vs_baseline.baseline_comparability_key`,
          problems,
        );
      }
      if (
        Object.hasOwn(row.vs_baseline, "selection") &&
        !["automatic", "explicit"].includes(row.vs_baseline.selection)
      ) {
        problems.push(
          `${label}.vs_baseline.selection must be automatic or explicit`,
        );
      }
    }
  }
  return problems;
}

/** Validate one row against the current frozen contract and matrix. */
export function validateLedgerRowAgainstContract({
  row,
  contract,
  contractDigest,
  label = "baseline row",
}) {
  const problems = validateLedgerRow(row, label);
  if (problems.length > 0) return problems;
  if (contractDigest && row.contract_digest !== contractDigest) {
    problems.push(
      `${label}.contract_digest does not match the current contract`,
    );
    return problems;
  }
  problems.push(...frozenDefectProblems({ contract, row, label }));
  // The other half of the frozen denominator: which conditions, which PRs and
  // how many draws a complete run must have scored at all.
  problems.push(...completeMatrixProblems({ contract, row, label }));
  return problems;
}

/** Validate an external baseline before a generated plan starts paid work. */
export function baselinePreflightProblems({
  row,
  contract,
  contractDigest,
  planComparabilityKey,
  candidateExecutedAt,
}) {
  const problems = validateLedgerRowAgainstContract({
    row,
    contract,
    contractDigest,
  });
  if (row?.comparability_key !== planComparabilityKey) {
    problems.push(
      "baseline comparability_key does not match the generated plan",
    );
  }
  if (
    typeof candidateExecutedAt === "string" &&
    typeof row?.executed_at === "string" &&
    !(row.executed_at < candidateExecutedAt)
  ) {
    problems.push(
      "baseline executed_at must precede the generated plan's candidate timestamp",
    );
  }
  return problems;
}

/**
 * Read the JSONL ledger. A zero-byte file is a valid empty ledger; a malformed
 * line is a hard error that names its line number.
 */
export function readLedger(path) {
  const raw = readFileSync(path, "utf8");
  const rows = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      // Only the trailing newline may produce an empty segment.
      if (index !== lines.length - 1) {
        throw new Error(`review-skill ledger line ${index + 1} is blank`);
      }
      continue;
    }
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `review-skill ledger line ${index + 1} is not valid JSON`,
        { cause: error },
      );
    }
  }
  return rows;
}

/** Append one validated row. Refuses to write a row the schema rejects. */
export function appendRow(path, row) {
  const problems = validateLedgerRow(row);
  if (problems.length) {
    throw new Error(
      `refusing to append an invalid ledger row:\n${problems.join("\n")}`,
    );
  }
  const existing = readFileSync(path, "utf8");
  const separator = existing.length && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${separator}${JSON.stringify(row)}\n`);
}

/** Frozen scorable defect ids for the whole contract, as strings. */
export function contractScorableIds(contract) {
  const ids = new Set();
  for (const fixture of contract?.fixtures ?? []) {
    for (const id of fixture.scorable_ids ?? []) ids.add(String(id));
  }
  return ids;
}

/** Frozen scorable defect ids per PR, as strings, in contract order. */
export function contractScorableIdsByPr(contract) {
  const byPr = new Map();
  for (const fixture of contract?.fixtures ?? []) {
    byPr.set(fixture.pr, (fixture.scorable_ids ?? []).map(String));
  }
  return byPr;
}

/**
 * What a `status: "complete"` row must cover, for its own kind. A partial or
 * failed row returns no problems: it is a matrix with cells that never ran.
 *
 * `checkLedger` already refuses a condition that scored a PR but dropped one of
 * that PR's frozen ids. This is the other half of the same denominator: a
 * complete run scores every cell `plannedMatrix` puts in its kind, so a row that
 * carries a subset claims a whole matrix on part of one. Nothing downstream
 * would notice — the freshness clock, `resolveKind` and `resolveBaseline` all
 * read `kind` and `status`, and `revalidateRow` recomputes over the conditions
 * and the draws the row happens to list.
 *
 * A canary is checked too. It is a floor test rather than a score of record, but
 * `canaryVerdict` reads its matched count against `canary_min_matched_grid`, so
 * a canary that ran one of the six grid PRs and calls itself complete passes
 * that floor on a sixth of the evidence it claims.
 *
 * The draw count is checked because it is the other axis of the same claim:
 * a `kind: "full"` row with `draws: 1` under pipeline has half the planned
 * sample, and it still refreshes the full-run clock and becomes a baseline. It
 * is checked per planned PR as well as per condition, because `draws` is one
 * number for the whole condition: a matrix that dropped one PR's second draw
 * keeps it and shortens only that PR's vectors, which every other check reads
 * as the run's own sample rather than as a missing cell.
 */
export function completeMatrixProblems({ contract, row, label = "row" }) {
  if (row?.status !== "complete") return [];
  if (!LEDGER_KINDS.includes(row?.kind) || row.kind === "bridge") return [];
  const problems = [];
  const scorableByPr = contractScorableIdsByPr(contract);
  const planned = plannedMatrix(contract, row.kind);
  for (const [name, cells] of planned) {
    if (cells.length === 0) continue;
    const condition = row.conditions?.[name];
    const scored = new Set(
      condition && typeof condition.per_defect === "object"
        ? Object.keys(condition.per_defect)
        : [],
    );
    if (scored.size === 0) {
      problems.push(
        `${label} is a complete ${row.kind} run but scores no ${name} condition; a complete ${row.kind} run carries ${[...planned.keys()].join(", ")}`,
      );
      continue;
    }
    const missing = cells
      .map((cell) => cell.pr)
      .filter(
        (pr) => !(scorableByPr.get(pr) ?? []).some((id) => scored.has(id)),
      );
    if (missing.length) {
      problems.push(
        `${label}.conditions.${name} is a complete ${row.kind} run but scores no defect from PR ${missing.join(", ")}; the contract puts ${cells.length} PR(s) in that condition`,
      );
    }
    const drawsPlanned = Math.max(...cells.map((cell) => cell.draws));
    if (
      Number.isSafeInteger(condition?.draws) &&
      condition.draws !== drawsPlanned
    ) {
      problems.push(
        `${label}.conditions.${name}.draws is ${condition.draws}; a complete ${row.kind} run plans ${drawsPlanned}`,
      );
    }
    // `condition.draws` is one number for the whole condition, so the check
    // above only catches a matrix shortened everywhere at once. A run that
    // dropped pipeline draw 2 for a single PR keeps `draws: 2` — the other PRs
    // still ran it — and every other check agrees with it: the vectors of the
    // omitted PR carry one bit each, `recall` is recomputed from those bits,
    // and `revalidateRow` finds the same single draw in the cell records. The
    // row then claims a whole matrix while missing a planned cell, refreshes
    // the freshness clock and becomes a baseline. The per-PR sample is the
    // vector length, so each planned cell is compared with the PR's own bits.
    for (const cell of cells) {
      const ids = scorableByPr.get(cell.pr) ?? [];
      const short = ids.filter((id) => {
        const vector = condition?.per_defect?.[id];
        return Array.isArray(vector) && vector.length !== cell.draws;
      });
      if (short.length) {
        const found = condition.per_defect[short[0]].length;
        problems.push(
          `${label}.conditions.${name} carries ${found} draw(s) for PR ${cell.pr}; a complete ${row.kind} run plans ${cell.draws}`,
        );
      }
    }
  }
  return problems;
}

/**
 * The frozen denominator, per id. Every producer builds a condition's vectors
 * from `conditionScope`, which takes a covered PR's whole `scorable_ids` list,
 * so a condition that scored a PR at all carries every defect that PR froze.
 * Dropping one shrinks `opportunities`, which lifts recall and the McNemar
 * denominator with it, and nothing else would notice: `revalidateRow`
 * recomputes over the ids the row lists, and `completeMatrixProblems` only asks
 * whether some id from each required PR is present.
 *
 * Applies to every kind and status. A partial run may leave a PR out entirely,
 * but a PR it did score is scored whole.
 */
export function frozenDefectProblems({ contract, row, label = "row" }) {
  const problems = [];
  const scorable = contractScorableIds(contract);
  const scorableByPr = contractScorableIdsByPr(contract);
  for (const name of CONDITION_NAMES) {
    const condition = row?.conditions?.[name];
    if (!condition || typeof condition.per_defect !== "object") continue;
    const scored = new Set(Object.keys(condition.per_defect));
    for (const id of scored) {
      if (!scorable.has(id)) {
        problems.push(
          `${label}.conditions.${name}.per_defect has ${id}, which the contract does not score`,
        );
      }
    }
    for (const [pr, ids] of scorableByPr) {
      if (!ids.some((id) => scored.has(id))) continue;
      const dropped = ids.filter((id) => !scored.has(id));
      if (dropped.length) {
        problems.push(
          `${label}.conditions.${name}.per_defect scored PR ${pr} but omits ${dropped.join(", ")}; the contract freezes ${ids.length} defect(s) for that PR`,
        );
      }
    }
  }
  return problems;
}

/**
 * Append-only comparison against the rows at a base ref. Rows may only be
 * added; an edited or removed row is a contract violation the caller reports.
 */
export function compareLedgers(oldRows, newRows) {
  const problems = [];
  const older = oldRows ?? [];
  const newer = newRows ?? [];
  if (newer.length < older.length) {
    problems.push(
      `ledger lost ${older.length - newer.length} committed row(s); the ledger is append-only`,
    );
  }
  const shared = Math.min(older.length, newer.length);
  for (let index = 0; index < shared; index += 1) {
    if (JSON.stringify(older[index]) !== JSON.stringify(newer[index])) {
      problems.push(
        `ledger row ${index + 1} changed; committed rows are immutable`,
      );
    }
  }
  return { appendOnly: problems.length === 0, problems };
}

/**
 * Validate the committed ledger against the contract. `baseRows` is optional:
 * pass the rows at the merge base to fold the append-only check in here.
 *
 * `contractDigest` is how a caller says which contract is current, and every
 * caller reading a real ledger owes it. A row scored under a retired contract
 * then gets the shape checks alone: its conditions, PR coverage and draws are
 * claims about the panel it ran on, and this contract's panel is a different
 * one. Omitting the digest holds every row, however old, to the contract passed
 * here, so a widened grid reads as coverage the old rows dropped.
 */
export function checkLedger({ path, contract, contractDigest, baseRows }) {
  const problems = [];
  let rows;
  try {
    rows = readLedger(path);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return { ok: false, problems, rows: [], comparableRows: [] };
  }

  rows.forEach((row, index) => {
    const label = `ledger row ${index + 1}`;
    const rowProblems =
      contractDigest && row.contract_digest !== contractDigest
        ? validateLedgerRow(row, label)
        : validateLedgerRowAgainstContract({
            row,
            contract,
            contractDigest,
            label,
          });
    problems.push(...rowProblems);
    if (rowProblems.length) return;
    if (contractDigest && row.contract_digest !== contractDigest) return;
  });

  if (baseRows) {
    problems.push(...compareLedgers(baseRows, rows).problems);
  }

  const comparableRows = contractDigest
    ? rows.filter((row) => row.contract_digest === contractDigest)
    : rows;
  return { ok: problems.length === 0, problems, rows, comparableRows };
}

function daysSince(instant, now) {
  return Math.floor((now.valueOf() - instant.valueOf()) / MS_PER_DAY);
}

function newestInstant(rows, predicate, notAfter = null) {
  let newest = null;
  for (const row of rows) {
    if (!predicate(row)) continue;
    const instant = parseInstant(row.executed_at);
    if (!instant) continue;
    if (notAfter && instant > notAfter) continue;
    if (!newest || instant > newest) newest = instant;
  }
  return newest;
}

/**
 * Age the ledger from `executed_at` alone. Rows written against a different
 * contract are legal history but never count here: they measure a different
 * suite. An empty eligible set counts from the contract's `established_at`, so
 * a suite nobody ever runs still ages to red.
 */
export function freshness({
  rows,
  contract,
  now = new Date(),
  contractDigest = null,
}) {
  const cadence = contract?.cadence_days ?? {};
  for (const key of [
    "freshness_warn",
    "freshness_red",
    "complete_red",
    "full_red",
  ]) {
    if (!Number.isSafeInteger(cadence[key])) {
      throw new Error(`contract cadence_days.${key} must be an integer`);
    }
  }
  const evaluatedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(evaluatedAt.valueOf())) {
    throw new Error("freshness needs a usable `now`");
  }
  const established = parseInstant(`${contract?.established_at}T00:00:00Z`);
  if (!established) {
    throw new Error("contract established_at must be a YYYY-MM-DD date");
  }

  const eligible = (rows ?? []).filter(
    (row) => !contractDigest || row?.contract_digest === contractDigest,
  );
  const excludedRows = (rows ?? []).length - eligible.length;

  // A row dated after `now` never ages: it would hold every clock below zero
  // until that date arrives, so a skewed machine clock or a hand-edited
  // `executed_at` could keep the guard green for as long as the forger liked.
  // Future rows are counted and named instead of being allowed to run a clock.
  const futureRows = eligible.filter((row) => {
    const instant = parseInstant(row?.executed_at);
    return Boolean(instant) && instant > evaluatedAt;
  }).length;

  // A bridge records a reviewed transition between two existing full runs. It
  // does not execute the harness or complete a new matrix, so it moves neither
  // of these clocks even when its hand-assembled row is current and complete.
  const lastAny = newestInstant(
    eligible,
    (row) => row.kind !== "bridge",
    evaluatedAt,
  );
  const lastComplete = newestInstant(
    eligible,
    (row) => row.kind !== "bridge" && row.status === "complete",
    evaluatedAt,
  );
  // A failed or partial full run verified nothing: it is a trace that the
  // harness ran, not a score. The baseline is "the first full, complete row"
  // and the operating point counts as verified only while a full run has
  // actually completed, so only a complete full row moves this clock. Counting
  // a failed one would reset `daysSinceFull`, and `resolveKind` would then pick
  // canaries for another whole cadence window instead of retrying the score.
  //
  // A run whose judge failed its own calibration verified nothing either:
  // `verdict()` caps it at AMBER and `resolveBaseline` refuses to anchor on it,
  // so letting it move this clock would keep the guard green and pick canaries
  // for a whole cadence window on a score nothing may rank on.
  //
  // A run whose notes record a suspected leak is refused by the same three
  // gates for the same reason — its bits may have come from the answer key
  // rather than from the review — so it may not move this clock either.
  //
  // A `--skill-ref` candidate run verified nothing about the installed skill:
  // it measured a working copy that may have been rejected the same afternoon.
  // This clock is what `resolveKind` and the staleness issue read as "the
  // operating point was checked", so a candidate row moving it would buy the
  // installed skill a whole cadence window of canaries on an experiment.
  // `daysSinceAny` and `daysSinceComplete` still count it: those say the
  // harness ran and produced a complete matrix, which a candidate run does.
  const lastFull = newestInstant(
    eligible,
    (row) =>
      row.kind === "full" &&
      row.status === "complete" &&
      installedSkillRun(row) &&
      judgeCalibrationPasses(row) &&
      !leakSuspected(row),
    evaluatedAt,
  );

  const reasons = [];
  if (futureRows > 0) {
    reasons.push(
      `${futureRows} row(s) are dated after the evaluation time and were ignored by every freshness clock`,
    );
  }
  if (!lastAny) {
    reasons.push(
      `no ledger row for the current contract; counting from established_at ${contract.established_at}`,
    );
  }
  const daysSinceAny = daysSince(lastAny ?? established, evaluatedAt);
  const daysSinceComplete = daysSince(lastComplete ?? established, evaluatedAt);
  const daysSinceFull = daysSince(lastFull ?? established, evaluatedAt);

  const red = [];
  const warn = [];
  if (daysSinceAny > cadence.freshness_red) {
    red.push(
      `no run in ${daysSinceAny} days (freshness_red ${cadence.freshness_red})`,
    );
  } else if (daysSinceAny > cadence.freshness_warn) {
    warn.push(
      `no run in ${daysSinceAny} days (freshness_warn ${cadence.freshness_warn})`,
    );
  }
  if (daysSinceComplete > cadence.complete_red) {
    red.push(
      `no complete run in ${daysSinceComplete} days (complete_red ${cadence.complete_red})`,
    );
  }
  if (daysSinceFull > cadence.full_red) {
    red.push(
      `no full run in ${daysSinceFull} days (full_red ${cadence.full_red})`,
    );
  }
  reasons.push(...red, ...warn);

  let level = "green";
  if (red.length) level = "red";
  else if (warn.length) level = "warn";

  return {
    level,
    reasons,
    daysSinceAny,
    daysSinceComplete,
    daysSinceFull,
    // Reported in the same canonical shape the rows carry, so a reader can
    // match a reported instant against `executed_at` by string.
    lastAnyAt: canonicalInstant(lastAny),
    lastCompleteAt: canonicalInstant(lastComplete),
    lastFullAt: canonicalInstant(lastFull),
    evaluatedAt: canonicalInstant(evaluatedAt),
    contractDigest,
    excludedRows,
    futureRows,
  };
}
