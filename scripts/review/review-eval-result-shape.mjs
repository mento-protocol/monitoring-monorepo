#!/usr/bin/env node

// Ledger-row shape helpers: build the row a failed run leaves behind, pick the
// row a candidate may be paired against, and recompute a committed row from its
// own evidence.
//
// Nothing here calls a model. `revalidateRow` is what makes a committed row
// evidence rather than a claim: a self-reported score is never trusted.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { fixtureForPr } from "./review-eval-fixtures.mjs";
import {
  compareConditions,
  headlineCondition,
  installedSkillRun,
  judgeCalibrationPasses,
  leakSuspected,
  verdict,
} from "./review-eval-report.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

/** True for a plain object, the only shape the recompute below can read. */
function isShape(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Defect ids one condition can score, given the PRs its cells cover. */
export function conditionScope({ contract, cells, condition }) {
  const prs = [
    ...new Set(
      cells.filter((cell) => cell.condition === condition).map((c) => c.pr),
    ),
  ];
  const scorableIds = [];
  const p1Ids = [];
  for (const pr of prs) {
    const fixture = fixtureForPr(contract, pr);
    scorableIds.push(...fixture.scorable_ids);
    p1Ids.push(...fixture.p1_ids);
  }
  return { prs, scorableIds, p1Ids };
}

/**
 * The row an unrecoverable run leaves behind. A failed run must still leave a
 * trace: a run that leaves nothing is indistinguishable from a run that never
 * happened, and the freshness guard cannot tell those apart either.
 *
 * The schema requires at least one condition, so the headline condition is
 * recorded with every bit zero. `status: "failed"` keeps it out of every
 * ranking and out of baseline selection.
 */
export function failedRow({
  plan,
  contract,
  contractDigest,
  reason,
  now = new Date(),
}) {
  const name = plan.cells[0]?.condition ?? "pipeline";
  const scope = conditionScope({
    contract,
    cells: plan.cells,
    condition: name,
  });
  const perDefect = Object.fromEntries(
    scope.scorableIds.map((id) => [String(id), [0]]),
  );
  const zero = (ids) => ({
    matched: 0,
    opportunities: ids.length,
    rate: ids.length === 0 ? null : 0,
  });
  return {
    schema_version: 1,
    kind: plan.kind,
    executed_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    status: "failed",
    verdict: "INCOMPLETE",
    comparability_key: plan.comparability_key,
    contract_digest: contractDigest,
    inputs: plan.inputs,
    conditions: {
      [name]: {
        model: plan.cells[0]?.model ?? contract.sut.verifier.model,
        effort: plan.cells[0]?.effort ?? contract.sut.verifier.effort,
        draws: 1,
        recall: zero(scope.scorableIds),
        p1: zero(scope.p1Ids),
        novel_real: 0,
        wrong_claims: 0,
        usd: 0,
        seconds: 0,
        per_defect: perDefect,
      },
    },
    judge_calibration: { agreement: 0, total: 1 },
    vs_baseline: null,
    detail_dir: plan.detail_dir,
    notes: `run failed: ${String(reason).slice(0, 400)}`,
  };
}

/**
 * The baseline of record this row is paired against.
 *
 * It is the anchor, not the previous run: the first full, complete row on this
 * comparability key, so a slow slide that never trips the per-run flip
 * threshold still shows against the score the baseline PR established. The
 * anchor moves only where the runbook says it may — a reviewed PROMOTE row —
 * and the newest such row then becomes the anchor for everything after it.
 *
 * A row whose judge calibration failed is never eligible, as anchor or as
 * re-anchor: the runbook excludes such a row from baseline comparison, and an
 * anchor is the comparison every later run is paired against.
 *
 * A row whose notes record a suspected leak is refused on the same ground. The
 * runbook calls its score untrusted, and an anchor's bits are the denominator
 * of every flip count after it: anchoring on answer-key-contaminated bits would
 * score each later clean run as a regression against defects the anchor may
 * have read rather than found.
 *
 * A `--skill-ref` candidate row is refused as well. The runbook pairs a
 * candidate against the installed skill, which is the comparison a candidate
 * experiment exists to make, so an anchor picked automatically has to be an
 * installed run — otherwise a rejected candidate becomes the denominator every
 * later installed run is scored against. `--against` still names any row
 * explicitly, which is how a candidate is compared on purpose.
 */
export function resolveBaseline({ rows, row }) {
  const eligible = (rows ?? [])
    .filter(
      (candidate) =>
        candidate.kind === "full" &&
        candidate.status === "complete" &&
        installedSkillRun(candidate) &&
        judgeCalibrationPasses(candidate) &&
        !leakSuspected(candidate) &&
        candidate.comparability_key === row.comparability_key &&
        candidate.executed_at < row.executed_at,
    )
    .sort((left, right) => (left.executed_at < right.executed_at ? -1 : 1));
  if (eligible.length === 0) return null;
  const reAnchored = eligible.findLast(
    (candidate) => candidate.verdict === "PROMOTE",
  );
  return reAnchored ?? eligible[0];
}

/**
 * The stored pairing against the baseline. `--against` may name a row from a
 * different comparability key, which measures something else: that pairing is
 * recorded with a null McNemar rather than with numbers nothing may read.
 *
 * It lives beside `revalidateRow` rather than beside the scorer that first
 * calls it, because the recompute is the point: a stored pairing nobody
 * re-derives is a claim, and `--validate` re-derives it from the same two
 * `per_defect` vectors the scorer read.
 */
export function buildVsBaseline({ row, baselineRow }) {
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

/** Read one row from a file path, or from the ledger by executed_at prefix. */
export function resolveRowReference({ reference, rows, repoRoot }) {
  if (!reference) return null;
  const asPath = path.resolve(repoRoot, reference);
  if (existsSync(asPath) && statSync(asPath).isFile()) return readJson(asPath);
  const matches = (rows ?? []).filter((row) =>
    String(row.executed_at).startsWith(reference),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`no ledger row and no file matches ${reference}`);
  }
  throw new Error(`${reference} matches ${matches.length} ledger rows`);
}

/** Whether a detail directory holds any scored cell result. */
function hasCellResults(dir) {
  try {
    return readdirSync(dir).some(
      (name) => name.startsWith("result-") && name.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

function recomputeFromDetail({ dir, condition, ids, prForId }) {
  let files;
  try {
    files = readdirSync(dir).filter(
      (name) =>
        name.startsWith("result-") &&
        name.includes(`-${condition}-`) &&
        name.endsWith(".json"),
    );
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const byDraw = new Map();
  // None of these counters is derivable from the bits, so each is recomputed
  // from the same per-cell records the bits come from. A row states them about
  // itself, and every one of them is printed in the committed report.
  let wrongClaims = 0;
  let novelReal = 0;
  let usd = 0;
  let seconds = 0;
  const claimsByPr = new Map();
  for (const file of files) {
    const record = readJson(path.join(dir, file));
    const draw = Number(record.draw);
    const entry = byDraw.get(draw) ?? { matched: new Set(), prs: new Set() };
    for (const id of record.matched_ids ?? []) entry.matched.add(String(id));
    entry.prs.add(String(record.pr));
    byDraw.set(draw, entry);
    wrongClaims += Number(record.novel?.novelWrong ?? 0);
    novelReal += Number(record.novel?.novelReal ?? 0);
    usd += Number(record.usd ?? 0);
    seconds += Number(record.seconds ?? 0);
    claimsByPr.set(
      String(record.pr),
      (claimsByPr.get(String(record.pr)) ?? 0) + (record.claims ?? []).length,
    );
  }
  const zeroFindingPrs = [...claimsByPr.values()].filter(
    (claims) => claims === 0,
  ).length;
  const draws = [...byDraw.keys()].sort((a, b) => a - b);
  const bits = new Map();
  // A draw scores only the PRs that completed it, exactly as `foldCondition`
  // folds them, so a PR that never ran a draw contributes no bit for it.
  for (const id of ids) {
    const pr = prForId?.get(String(id));
    bits.set(
      id,
      draws
        .filter(
          (draw) => pr === undefined || byDraw.get(draw).prs.has(String(pr)),
        )
        .map((draw) => (byDraw.get(draw).matched.has(id) ? 1 : 0)),
    );
  }
  return { bits, wrongClaims, novelReal, usd, seconds, zeroFindingPrs };
}

/** Report a stated number that is not what the detail sums to. */
function checkClose(stated, found, tolerance, label, digits, problems) {
  if (typeof stated !== "number" || !Number.isFinite(stated)) {
    problems.push(`${label} is not a number; the run detail gives ${found}`);
    return;
  }
  // `Number("")`, `Number("2.4 usd")` and a missing nested field all reach here
  // as NaN, and every comparison with NaN is false: without this the sum of a
  // corrupt cell record would silently accept whatever the row stated. An
  // unusable sum is a validation problem about the detail, not a pass.
  if (!Number.isFinite(found)) {
    problems.push(
      `${label} cannot be checked; the run detail sums to ${found}, so at least one cell record carries a value that is not a finite number`,
    );
    return;
  }
  if (Math.abs(stated - found) > tolerance) {
    problems.push(
      `${label} is ${stated}; the run detail gives ${found.toFixed(digits)}`,
    );
  }
}

/**
 * What the scorer spent on judges, re-derived from the run detail.
 *
 * `scoring_usd` is the one recorded number no per-cell record used to carry, so
 * `--validate` had to take it on the row's own say-so. Each cell record now
 * carries the dollars its own judge calls cost and `calibration.json` carries
 * the replay's, which makes the run total a sum of evidence like every other
 * number on the row. Returns null when the detail predates that, so a row
 * written before the field existed is not failed for it.
 */
function recomputeScoringUsd(dir) {
  let files;
  try {
    files = readdirSync(dir).filter(
      (name) => name.startsWith("result-") && name.endsWith(".json"),
    );
  } catch {
    return null;
  }
  let total = 0;
  let seen = false;
  for (const file of files) {
    const record = readJson(path.join(dir, file));
    if (!Object.hasOwn(record ?? {}, "scoring_usd")) continue;
    seen = true;
    total += Number(record.scoring_usd ?? 0);
  }
  const calibrationFile = path.join(dir, "calibration.json");
  if (existsSync(calibrationFile)) {
    const record = readJson(calibrationFile);
    if (Object.hasOwn(record ?? {}, "scoring_usd")) {
      seen = true;
      total += Number(record.scoring_usd ?? 0);
    }
  }
  return seen ? total : null;
}

/**
 * Re-derive `judge_calibration` from the outcomes the scoring pass wrote.
 *
 * `judge_calibration` gates every other number on the row: `verdict()` caps a
 * run below the 35/40 floor at AMBER, `resolveBaseline` refuses to anchor on it, and the
 * freshness clock refuses to count it as a full run. Taken from the row itself
 * it was the one gate an edit could lift by retyping two integers, so it is
 * recomputed here from `calibration.json` exactly as the bits are recomputed
 * from the cell results.
 *
 * The limit is the same one the cell results have: this proves the row agrees
 * with the detail the run left behind, not that a model produced that detail.
 * A detail directory that carries cell results but no `calibration.json` is a
 * problem rather than a skipped check, so deleting the file cannot buy back the
 * trust it was written to remove.
 */
function checkCalibration({ dir, row, calibrationSet, problems }) {
  const file = path.join(dir, "calibration.json");
  if (!existsSync(file)) {
    problems.push(
      `${dir} carries cell results but no calibration.json; judge_calibration cannot be re-derived`,
    );
    return;
  }
  // `--validate` reads a detail directory it did not write, so unreadable JSON
  // is a problem to report, not a stack trace in place of the problem list.
  let record;
  try {
    record = readJson(file);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return;
  }
  const outcomes = record?.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    problems.push("calibration.json carries no outcomes array");
    return;
  }
  const ids = new Set(outcomes.map((outcome) => String(outcome?.record_id)));
  if (ids.size !== outcomes.length) {
    problems.push(
      `calibration.json repeats a record_id; ${outcomes.length} outcome(s) cover ${ids.size} pair(s)`,
    );
  }
  const expectedById = new Map(
    (
      (Array.isArray(calibrationSet)
        ? calibrationSet
        : (calibrationSet?.records ?? [])) ?? []
    ).map((entry) => [String(entry?.record_id), entry?.expected_verdict]),
  );
  if (expectedById.size > 0) {
    // Without this, flipping `expected` to whatever the judge answered turns
    // every disagreement into agreement inside the detail file itself.
    for (const outcome of outcomes) {
      const id = String(outcome?.record_id);
      if (!expectedById.has(id)) {
        problems.push(
          `calibration.json scores ${id}, which is not a frozen pair`,
        );
      } else if (expectedById.get(id) !== outcome?.expected) {
        problems.push(
          `calibration.json states expected ${outcome?.expected} for ${id}; the frozen pair says ${expectedById.get(id)}`,
        );
      }
    }
    if (outcomes.length !== expectedById.size) {
      problems.push(
        `calibration.json carries ${outcomes.length} outcome(s); the calibration set holds ${expectedById.size} pair(s)`,
      );
    }
  }
  const agreement = outcomes.filter(
    (outcome) => outcome?.actual === outcome?.expected,
  ).length;
  const stated = row?.judge_calibration ?? {};
  if (stated.total !== outcomes.length) {
    problems.push(
      `judge_calibration.total is ${stated.total}; calibration.json gives ${outcomes.length}`,
    );
  }
  if (stated.agreement !== agreement) {
    problems.push(
      `judge_calibration.agreement is ${stated.agreement}; calibration.json gives ${agreement}`,
    );
  }
}

function mcnemarText(value) {
  return isShape(value)
    ? `b=${value.b} c=${value.c} delta=${value.delta}`
    : String(value);
}

function checkMcnemar(stated, expected, label, problems) {
  const same =
    isShape(stated) && isShape(expected)
      ? stated.b === expected.b &&
        stated.c === expected.c &&
        stated.delta === expected.delta
      : (stated ?? null) === (expected ?? null);
  if (!same) {
    problems.push(
      `${label} is ${mcnemarText(stated)}; the baseline's bits give ${mcnemarText(expected)}`,
    );
  }
}

/**
 * Recompute the stored pairing from the baseline this row is validated against.
 *
 * `verdict()` never reads `vs_baseline` — it pairs the two rows itself — so
 * these are recorded numbers in the same class as `usd` and `seconds`: printed
 * in the committed report and, until now, taken on the row's own say-so. A row
 * could name a baseline it was never scored on, or state a delta its bits do
 * not give, and still append. The recompute needs a baseline row, so a pairing
 * with nothing to check it against — the hand-assembled bridge row validated
 * without `--against` — is still left to the reviewer of the ledger PR.
 *
 * A row that records no pairing at all is not a problem here: it under-claims,
 * and the verdict is derived from the baseline directly either way.
 */
function checkVsBaseline({ row, baseline, problems }) {
  const stated = row.vs_baseline ?? null;
  if (!baseline || stated === null) return;
  if (!isShape(stated)) {
    problems.push("row.vs_baseline is neither null nor an object");
    return;
  }
  const expected = buildVsBaseline({ row, baselineRow: baseline });
  if (stated.baseline_executed_at !== expected.baseline_executed_at) {
    // Everything below is about a different pair of runs, so recomputing it
    // against this baseline would report differences that are not errors.
    problems.push(
      `row.vs_baseline.baseline_executed_at is ${stated.baseline_executed_at}; this row is validated against ${expected.baseline_executed_at}`,
    );
    return;
  }
  if (
    Object.hasOwn(stated, "baseline_comparability_key") &&
    stated.baseline_comparability_key !== expected.baseline_comparability_key
  ) {
    problems.push(
      `row.vs_baseline.baseline_comparability_key is ${stated.baseline_comparability_key}; the baseline row carries ${expected.baseline_comparability_key}`,
    );
    return;
  }
  checkMcnemar(
    stated.mcnemar,
    expected.mcnemar,
    "row.vs_baseline.mcnemar",
    problems,
  );
  // The control pairing is optional on the row. Stated, it is checked; absent,
  // there is no claim to check.
  if (Object.hasOwn(stated, "control_mcnemar")) {
    checkMcnemar(
      stated.control_mcnemar,
      expected.control_mcnemar ?? null,
      "row.vs_baseline.control_mcnemar",
      problems,
    );
  }
}

/**
 * Recompute a row's numbers from its own per-defect bits and, when the run
 * detail is on disk, from the per-cell matched ids. A self-reported score is
 * never trusted; this is what makes a committed row evidence.
 *
 * The verdict is recomputed the same way, against the baseline the ledger
 * rows resolve to, because the verdict is the one field a human reads first.
 * `baselineMissing` suppresses that one check, and only it, when the caller
 * knows the baseline of record is not in this checkout.
 */
export function revalidateRow({
  contract,
  row,
  repoRoot,
  detailDir = null,
  ledgerRows = [],
  baselineRow = null,
  baselineMissing = false,
  calibrationSet = null,
}) {
  const problems = [];
  const dir =
    detailDir ?? (row.detail_dir ? path.join(repoRoot, row.detail_dir) : null);
  const p1 = new Set(
    contract.fixtures.flatMap((fixture) => fixture.p1_ids.map(String)),
  );
  const prForId = new Map(
    contract.fixtures.flatMap((fixture) =>
      fixture.scorable_ids.map((id) => [String(id), fixture.pr]),
    ),
  );
  for (const [name, condition] of Object.entries(row.conditions ?? {})) {
    const label = `conditions.${name}`;
    // `--validate` reads a row file it did not write, so every field here is
    // untrusted. A missing one is a problem to report, not a stack trace that
    // replaces the problem list the command promises.
    if (!isShape(condition)) {
      problems.push(`${label} is not an object; nothing to recompute`);
      continue;
    }
    const ids = Object.keys(condition.per_defect ?? {});
    if (ids.length === 0) {
      problems.push(`${label}.per_defect is empty`);
      continue;
    }
    if (!isShape(condition.recall) || !isShape(condition.p1)) {
      problems.push(`${label} is missing recall or p1; nothing to recompute`);
      continue;
    }
    // Every arithmetic below reads these vectors, and the detail comparison
    // calls `.join()` on them. A scalar or a vector carrying anything but 0 and
    // 1 is a validation problem to report, not a stack trace that replaces the
    // problem list `--validate` promises.
    const malformed = ids.filter(
      (id) =>
        !Array.isArray(condition.per_defect[id]) ||
        condition.per_defect[id].length === 0 ||
        condition.per_defect[id].some((bit) => bit !== 0 && bit !== 1),
    );
    if (malformed.length > 0) {
      problems.push(
        `${label}.per_defect must map each defect to a non-empty array of 0/1 bits; ${malformed.length} vector(s) are not, starting at ${malformed[0]}`,
      );
      continue;
    }
    const bits = ids.flatMap((id) => condition.per_defect[id]);
    const matched = bits.filter((bit) => bit === 1).length;
    if (matched !== condition.recall.matched) {
      problems.push(
        `${label}.recall.matched is ${condition.recall.matched}; the bits give ${matched}`,
      );
    }
    if (bits.length !== condition.recall.opportunities) {
      problems.push(
        `${label}.recall.opportunities is ${condition.recall.opportunities}; the bits give ${bits.length}`,
      );
    }
    const p1Bits = ids
      .filter((id) => p1.has(id))
      .flatMap((id) => condition.per_defect[id]);
    const p1Matched = p1Bits.filter((bit) => bit === 1).length;
    if (p1Matched !== condition.p1.matched) {
      problems.push(
        `${label}.p1.matched is ${condition.p1.matched}; the bits give ${p1Matched}`,
      );
    }
    // The P1 denominator is recomputed for the same reason the recall
    // denominator is. `verdict()` skips the `p1_recall_floor` check on a null
    // rate, which only zero P1 opportunities may produce, so a row that carries
    // P1 bits and states `{matched: 0, opportunities: 0, rate: null}` would
    // otherwise validate as GREEN while hiding a floor breach.
    if (p1Bits.length !== condition.p1.opportunities) {
      problems.push(
        `${label}.p1.opportunities is ${condition.p1.opportunities}; the bits give ${p1Bits.length}`,
      );
    }
    if (p1Bits.length > 0 && (condition.p1.rate ?? null) === null) {
      problems.push(
        `${label}.p1.rate is null, which claims no P1 defect was scored; the bits give ${p1Bits.length} P1 opportunities`,
      );
    }
    if (!dir || !existsSync(dir)) continue;
    const recomputed = recomputeFromDetail({
      dir,
      condition: name,
      ids,
      prForId,
    });
    if (!recomputed) continue;
    for (const id of ids) {
      const stated = condition.per_defect[id].join("");
      const found = (recomputed.bits.get(id) ?? []).join("");
      if (found !== stated) {
        problems.push(
          `${label}.per_defect.${id} is ${stated}; the run detail gives ${found || "no draw"}`,
        );
      }
    }
    // Both counters can turn a row RED on their own, so neither may pass
    // `--validate` on the row's own say-so.
    if (condition.wrong_claims !== recomputed.wrongClaims) {
      problems.push(
        `${label}.wrong_claims is ${condition.wrong_claims}; the run detail gives ${recomputed.wrongClaims}`,
      );
    }
    const statedZero = condition.zero_finding_prs ?? 0;
    if (statedZero !== recomputed.zeroFindingPrs) {
      problems.push(
        `${label}.zero_finding_prs is ${statedZero}; the run detail gives ${recomputed.zeroFindingPrs}`,
      );
    }
    // The remaining three recorded numbers. None of them moves a verdict, but
    // all three are printed in the committed report as measurements, and the
    // runbook's guarantee is that every recorded number is re-derived rather
    // than believed. An aggregation bug or an edited row is a validation
    // problem here instead of a figure a reader has no way to check.
    if (condition.novel_real !== recomputed.novelReal) {
      problems.push(
        `${label}.novel_real is ${condition.novel_real}; the run detail gives ${recomputed.novelReal}`,
      );
    }
    // Summed in a different order than `foldCondition` summed them, so the
    // comparison is to the cent and to the tenth of a second rather than to the
    // last bit of a float.
    checkClose(
      condition.usd,
      recomputed.usd,
      0.005,
      `${label}.usd`,
      2,
      problems,
    );
    checkClose(
      condition.seconds,
      recomputed.seconds,
      0.05,
      `${label}.seconds`,
      1,
      problems,
    );
  }
  if (dir && Object.hasOwn(row, "scoring_usd")) {
    const spent = recomputeScoringUsd(dir);
    if (spent !== null) {
      checkClose(row.scoring_usd, spent, 0.005, "row.scoring_usd", 2, problems);
    }
  }
  // Only a directory that actually holds this run's cells is expected to hold
  // its calibration outcomes. A row validated with no detail on disk is already
  // checked against its own bits alone.
  if (dir && hasCellResults(dir)) {
    checkCalibration({ dir, row, calibrationSet, problems });
  }
  const baseline =
    baselineRow ?? resolveBaseline({ rows: ledgerRows ?? [], row });
  checkVsBaseline({ row, baseline, problems });
  // The verdict is a function of the row and its baseline together: a net loss
  // of flips is RED and a net gain is PROMOTE, both read against the anchor.
  // `baselineMissing` says the caller knows the row was scored against a
  // baseline this checkout does not carry — the candidate paired with an
  // installed row whose own ledger PR has not merged. Recomputing without one
  // does not check that verdict, it computes a different row's: the unpaired
  // recompute gives GREEN and would fail a correctly recorded RED or PROMOTE.
  // The unpaired state is reported instead, and every check above — the bits,
  // the counters, the calibration, the cell records — has already run.
  if (baselineMissing) {
    return {
      ok: problems.length === 0,
      problems,
      detail_dir: dir,
      verdict: null,
      baseline_executed_at: null,
      baseline_missing: true,
    };
  }
  let recomputed = null;
  try {
    recomputed = verdict({ contract, row, baselineRow: baseline }).verdict;
  } catch (error) {
    problems.push(
      `the verdict could not be recomputed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (recomputed && recomputed !== row.verdict) {
    problems.push(
      `row.verdict is ${row.verdict}; the row's own numbers give ${recomputed}`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    detail_dir: dir,
    verdict: recomputed,
    baseline_executed_at: baseline?.executed_at ?? null,
    baseline_missing: false,
  };
}
