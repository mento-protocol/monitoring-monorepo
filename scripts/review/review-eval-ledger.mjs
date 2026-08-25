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
export const ROW_OPTIONAL_KEYS = [];

export const INPUTS_REQUIRED_KEYS = [
  "skill_digest",
  "skill_ref",
  "codex_review_sh_digest",
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

/** Parse an ISO timestamp; return null when it is not a usable instant. */
export function parseInstant(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function checkInstant(value, label, problems) {
  if (!parseInstant(value)) {
    problems.push(`${label} must be an ISO timestamp`);
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
  checkNumber(count.rate, `${label}.rate`, problems);
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
      row.inputs.codex_review_sh_digest,
      `${label}.inputs.codex_review_sh_digest`,
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
        ["baseline_comparability_key", "control_mcnemar"],
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
    }
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

  const scorable = contractScorableIds(contract);
  rows.forEach((row, index) => {
    const label = `ledger row ${index + 1}`;
    const rowProblems = validateLedgerRow(row, label);
    problems.push(...rowProblems);
    if (rowProblems.length) return;
    if (contractDigest && row.contract_digest !== contractDigest) return;
    for (const name of CONDITION_NAMES) {
      const condition = row.conditions[name];
      if (!condition) continue;
      for (const id of Object.keys(condition.per_defect)) {
        if (!scorable.has(id)) {
          problems.push(
            `${label}.conditions.${name}.per_defect has ${id}, which the contract does not score`,
          );
        }
      }
    }
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

function newestInstant(rows, predicate) {
  let newest = null;
  for (const row of rows) {
    if (!predicate(row)) continue;
    const instant = parseInstant(row.executed_at);
    if (!instant) continue;
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

  const lastAny = newestInstant(eligible, () => true);
  const lastComplete = newestInstant(
    eligible,
    (row) => row.status === "complete",
  );
  const lastFull = newestInstant(eligible, (row) => row.kind === "full");

  const reasons = [];
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
    lastAnyAt: lastAny ? lastAny.toISOString() : null,
    lastCompleteAt: lastComplete ? lastComplete.toISOString() : null,
    lastFullAt: lastFull ? lastFull.toISOString() : null,
    evaluatedAt: evaluatedAt.toISOString(),
    contractDigest,
    excludedRows,
  };
}
