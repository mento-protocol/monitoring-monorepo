/**
 * Verdict, paired comparison, and reporting for the review-skill evaluation.
 *
 * Every number here comes from committed booleans. A run stores one found or
 * missed bit per defect per draw in its ledger row, so comparing two runs is
 * arithmetic, not a second model pass. A defect counts as found when any draw
 * of that run found it.
 *
 * Two rules protect the comparison. Rows with different `comparability_key`
 * values measure different things and are never compared unless the candidate
 * is an explicit `kind: "bridge"` row. Canary rows are a floor test: they can
 * only pass or fail, and they never rank against a baseline.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const REVIEW_EVAL_MARKER = "<!-- review-skill-eval-issue:v1 -->";
export const REVIEW_EVAL_STALENESS_MARKER_PREFIX =
  "<!-- review-skill-eval-staleness:v1 ";
export const REVIEW_EVAL_OWNERSHIP_LABEL = "source:audit";
export const REVIEW_EVAL_ISSUE_LABELS = [
  "agent-ready",
  "pkg:tooling",
  "kind:refactor",
  REVIEW_EVAL_OWNERSHIP_LABEL,
  "priority:p2",
  "risk:low",
];

export const REPORT_MAX_LINES = 40;
// Anchored empirically 2026-08-28: the contract judge (claude-fable-5 max)
// measures 37/40 blind against the audited labels — its only misses are the
// three same-file trap pairs every blind judge over-matches. The floor sits
// two below that measured baseline so it fires on drift, not on the known
// ceiling. Re-measure and re-anchor whenever the calibration set or the
// contract judge changes; the measured baseline lives in the calibration
// file's measured_blind_baseline field.
const CALIBRATION_FLOOR_RATIO = 35 / 40;
const HEADLINE_ORDER = ["pipeline", "replay", "control"];
const MAX_FLIP_LINES = 12;
const MAX_TITLE_CHARS = 88;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The scorer records a suspected leak in `notes` as `leak suspected: …`. Match
 * the underscored spelling too, so a reworded note never silently turns a
 * leaked run green.
 */
const LEAK_NOTE_PATTERN = /leak[ _]suspected/i;

/**
 * Whether a row's judge calibration is good enough for its numbers to mean
 * anything. Every recorded bit comes from the judge, so a judge that falls
 * more than two pairs below its measured 37/40 blind baseline produces a
 * matrix nothing may rank on. The runbook: agreement under 35/40 marks the
 * run AMBER and excludes
 * it from baseline comparison.
 */
export function judgeCalibrationPasses(row) {
  const calibration = row?.judge_calibration;
  if (!isObject(calibration)) return false;
  const { agreement, total } = calibration;
  if (!Number.isFinite(agreement) || !Number.isFinite(total) || total <= 0) {
    return false;
  }
  return agreement / total >= CALIBRATION_FLOOR_RATIO;
}

function calibrationReason(row) {
  const calibration = row?.judge_calibration;
  if (!isObject(calibration)) {
    return "row carries no judge_calibration; the score is not usable evidence";
  }
  return `judge calibration ${calibration.agreement}/${calibration.total} is below 35/40`;
}

/** A rate is null when the condition had no opportunity to score it. */
function rateText(rate) {
  return rate === null || rate === undefined ? "not measured" : rate.toFixed(3);
}

/** The condition a row is ranked on: the live pipeline when it ran. */
export function headlineCondition(row) {
  for (const name of HEADLINE_ORDER) {
    const condition = row?.conditions?.[name];
    if (condition) return { name, condition };
  }
  return { name: null, condition: null };
}

/** Collapse a condition's per-draw bits to one found/missed bit per defect. */
export function perDefectBits(condition) {
  const bits = new Map();
  for (const [id, vector] of Object.entries(condition?.per_defect ?? {})) {
    bits.set(id, vector.some((bit) => bit === 1) ? 1 : 0);
  }
  return bits;
}

/**
 * McNemar counts over paired per-defect vectors. `b` is found then missed,
 * `c` is missed then found, and `delta = b - c` is the net regression.
 */
export function mcnemar(baseVec, candVec) {
  if (!Array.isArray(baseVec) || !Array.isArray(candVec)) {
    throw new Error("mcnemar needs two arrays");
  }
  if (baseVec.length !== candVec.length) {
    throw new Error("mcnemar needs vectors of the same length");
  }
  let b = 0;
  let c = 0;
  for (const [index, baseBit] of baseVec.entries()) {
    const candBit = candVec[index];
    for (const bit of [baseBit, candBit]) {
      if (bit !== 0 && bit !== 1)
        throw new Error("mcnemar bits must be 0 or 1");
    }
    if (baseBit === 1 && candBit === 0) b += 1;
    if (baseBit === 0 && candBit === 1) c += 1;
  }
  return { b, c, delta: b - c };
}

/**
 * Pair two conditions on the defects both scored, and name what flipped.
 * Defects only one run attempted are reported as skipped, never as a flip.
 */
export function compareConditions(baseCondition, candCondition) {
  const baseBits = perDefectBits(baseCondition);
  const candBits = perDefectBits(candCondition);
  const ids = [...baseBits.keys()]
    .filter((id) => candBits.has(id))
    .sort((left, right) => left.localeCompare(right));
  const counts = mcnemar(
    ids.map((id) => baseBits.get(id)),
    ids.map((id) => candBits.get(id)),
  );
  const lost = ids.filter(
    (id) => baseBits.get(id) === 1 && candBits.get(id) === 0,
  );
  const gained = ids.filter(
    (id) => baseBits.get(id) === 0 && candBits.get(id) === 1,
  );
  const skipped =
    new Set([...baseBits.keys(), ...candBits.keys()]).size - ids.length;
  return { ...counts, ids, lost, gained, skipped };
}

function zeroFindingPrs(condition) {
  return Number.isSafeInteger(condition?.zero_finding_prs)
    ? condition.zero_finding_prs
    : 0;
}

/** Whether the scorer recorded a suspected answer-key leak on this row. */
export function leakSuspected(row) {
  return LEAK_NOTE_PATTERN.test(row?.notes ?? "");
}

/**
 * Whether this row measured the installed review skill.
 *
 * A `--skill-ref` run stamps `skill_ref` with the candidate directory and
 * `dirty: true`, and what it measured is a working copy nobody has to keep: a
 * rejected candidate leaves the installed skill untouched. Two selections are
 * about the installed lineage and must not read such a row as one of its runs —
 * the freshness clock that says when the operating point was last verified, and
 * the automatic baseline every later run is paired against. A complete
 * candidate experiment would otherwise reset `daysSinceFull`, hold
 * `resolveKind` on canaries for a whole cadence window and suppress the
 * staleness issue while the installed skill has not scored in months, and it
 * could become the anchor whose bits are the denominator of every flip counted
 * after it. Candidate rows stay in the ledger as comparison evidence, and a
 * promoted candidate re-enters both selections through the next installed run.
 *
 * Both markers are required, so a row carrying neither is left out of the
 * installed lineage rather than counted into it: that direction ages a clock
 * and drops an anchor, which is the failure a reader sees.
 */
export function installedSkillRun(row) {
  const inputs = row?.inputs;
  if (!isObject(inputs)) return false;
  return inputs.dirty !== true && inputs.skill_ref === "installed";
}

/**
 * The note a pair that straddles a CLI upgrade carries, or null.
 *
 * `comparability_key` deliberately omits the two CLI versions: they move far
 * more often than this suite runs, so keying on them would end the lineage at
 * every upgrade and leave every later run with no baseline and no flip rule to
 * fire. The pairing therefore stands, and the drift is named beside the verdict
 * instead — a flip counted across an upgrade may be the runtime's defaults, tool
 * behaviour or model resolution rather than the skill, and the reader deciding
 * on a RED or a PROMOTE is the one who must know that.
 */
function runtimeDrift(row, baselineRow) {
  const moved = ["claude_cli", "codex_cli"].filter(
    (field) => row?.inputs?.[field] !== baselineRow?.inputs?.[field],
  );
  if (moved.length === 0) return null;
  return `the baseline ran under ${moved
    .map(
      (field) => `${field.replace("_cli", "")} ${baselineRow?.inputs?.[field]}`,
    )
    .join(", ")} and this run under ${moved
    .map((field) => `${field.replace("_cli", "")} ${row?.inputs?.[field]}`)
    .join(", ")}; a flip may come from the runtime rather than the skill`;
}

/** Whether one row has the intrinsic standing required of a baseline. */
export function baselineEligibility(row) {
  // The same standing `resolveBaseline` requires of an anchor. A canary is a
  // floor test on a two-cell subset and a partial or failed run is a matrix
  // with cells that never ran, so neither carries the per-defect bits a flip
  // count needs: pairing against one would read defects the baseline never had
  // the chance to find as gains, and produce a RED or PROMOTE verdict from
  // non-ranking evidence. `resolveBaseline` never selects such a row; this
  // refuses one named explicitly with `--against`.
  if (row?.kind !== "full" || row?.status !== "complete") {
    return {
      usable: false,
      reason: `baseline is a ${row?.kind} row with status ${row?.status}; comparison refused (a baseline must be a complete full run)`,
    };
  }
  if (!installedSkillRun(row)) {
    return {
      usable: false,
      reason:
        "baseline is not an installed-skill run; comparison refused (a candidate cannot become the denominator)",
    };
  }
  // The baseline supplies `baseHeadline`, every flip count derived from it and
  // the wrong-claims denominator. A baseline whose own judge failed calibration
  // would rank a calibrated candidate on numbers the runbook calls unusable, so
  // it is refused as a baseline exactly the way `resolveBaseline` refuses to
  // anchor on one.
  if (!judgeCalibrationPasses(row)) {
    return {
      usable: false,
      reason: `baseline ${calibrationReason(row)}; comparison refused`,
    };
  }
  // A leaked baseline is refused for the same reason, and here it matters more
  // than on the candidate: the anchor's bits are the denominator of every later
  // flip count, so answer-key-contaminated bits would silently score every
  // clean run after them as a regression. `resolveBaseline` never selects such
  // a row; this refuses one named explicitly with `--against`.
  if (leakSuspected(row)) {
    return {
      usable: false,
      reason:
        "baseline notes record a suspected leak; comparison refused (its bits are not trusted)",
    };
  }
  const { condition } = headlineCondition(row);
  if (
    !isObject(condition) ||
    !isObject(condition.per_defect) ||
    Object.keys(condition.per_defect).length === 0
  ) {
    return {
      usable: false,
      reason:
        "baseline carries no scored condition; comparison refused (there are no defect bits to pair)",
    };
  }
  return { usable: true, reason: null };
}

function comparable(row, baselineRow, { baselineIsExplicit = true } = {}) {
  if (!baselineRow) return { usable: false, reason: null };
  const eligibility = baselineEligibility(baselineRow);
  if (!eligibility.usable) return eligibility;
  // `resolveBaseline` establishes precedence from append order. A baseline
  // named outside that ledger context still needs a timestamp guard. A later
  // row named with `--against` reverses the pairing: its bits become
  // the base, so the defects the candidate found and the later row did not are
  // counted as lost and the ones it gained as gains. The delta then reads
  // backwards, and a regression can print PROMOTE. Instants are ISO-8601 UTC,
  // so a string compare orders explicit rows without overriding append order.
  if (baselineIsExplicit && !(baselineRow.executed_at < row.executed_at)) {
    return {
      usable: false,
      reason: `baseline executed_at ${baselineRow.executed_at} does not precede this row's ${row.executed_at}; comparison refused (a baseline must be the earlier run)`,
    };
  }
  if (row.comparability_key === baselineRow.comparability_key) {
    return { usable: true, reason: runtimeDrift(row, baselineRow) };
  }
  if (row.kind === "bridge") {
    return {
      usable: true,
      reason:
        "bridge row: comparing across comparability keys is intentional here",
    };
  }
  return {
    usable: false,
    reason:
      "baseline has a different comparability_key; comparison refused (use a bridge run)",
  };
}

function canaryVerdict({ contract, row }) {
  const reasons = [];
  if (row.status !== "complete") {
    // A canary never ranks, but a canary that did not finish must not read
    // green either. INCOMPLETE says the floor test did not run to the end.
    reasons.push(`canary status is ${row.status}`);
    return { verdict: "INCOMPLETE", reasons };
  }
  const { name, condition } = headlineCondition(row);
  const floor = contract.verdict_rules.canary_min_matched_grid;
  if (!condition) {
    reasons.push("canary carries no condition");
    return { verdict: "INCOMPLETE", reasons };
  }
  // A floor test read by a judge that failed its own calibration is not a
  // floor test. This precedes the floor checks below for the same reason it
  // precedes RED on a full run: every matched count is the judge's output.
  if (!judgeCalibrationPasses(row)) {
    return { verdict: "AMBER", reasons: [calibrationReason(row)] };
  }
  // A floor test that may have read the answer key is not a floor test either.
  if (leakSuspected(row)) {
    return {
      verdict: "AMBER",
      reasons: ["notes record a suspected leak; scores are not trusted"],
    };
  }
  if (condition.recall.matched < floor) {
    reasons.push(
      `${name} matched ${condition.recall.matched} grid defects, below canary_min_matched_grid ${floor}`,
    );
  }
  for (const conditionName of HEADLINE_ORDER) {
    const other = row.conditions[conditionName];
    if (other && zeroFindingPrs(other) >= 1) {
      reasons.push(
        `${conditionName} emitted no parseable finding on ${zeroFindingPrs(other)} PR(s)`,
      );
    }
  }
  if (reasons.length) return { verdict: "RED", reasons };
  return {
    verdict: "GREEN",
    reasons: [
      `${name} matched ${condition.recall.matched} grid defects, at or above the canary floor ${floor}`,
    ],
  };
}

/**
 * Apply the pre-registered decision rule to one row. Precedence, highest
 * first: INCOMPLETE for a failed run that has no scored matrix, then AMBER for
 * a judge that failed its own calibration, then AMBER for a suspected
 * answer-key leak, then AMBER for a matrix that did not complete, then RED,
 * AMBER, PROMOTE, GREEN. The three AMBER gates precede RED for one reason: a
 * run whose numbers are untrusted or incomplete may not be escalated on them
 * either.
 */
export function verdict({
  contract,
  row,
  baselineRow = null,
  baselineIsExplicit = true,
}) {
  if (!isObject(contract?.verdict_rules)) {
    throw new Error("contract is missing verdict_rules");
  }
  if (!isObject(row)) throw new Error("verdict needs a ledger row");
  if (row.kind === "canary") return canaryVerdict({ contract, row });

  const rules = contract.verdict_rules;
  const reasons = [];
  if (row.status === "failed") {
    return {
      verdict: "INCOMPLETE",
      reasons: [
        `run failed before it produced a scored matrix: ${row.notes || "no reason recorded"}`,
      ],
    };
  }

  const { name, condition } = headlineCondition(row);
  if (!condition) {
    return { verdict: "INCOMPLETE", reasons: ["row carries no condition"] };
  }

  const pairing = comparable(row, baselineRow, { baselineIsExplicit });
  const baseline = pairing.usable ? baselineRow : null;
  if (pairing.reason) reasons.push(pairing.reason);
  if (!baselineRow) reasons.push("no baseline row; comparison skipped");

  const baseHeadline = baseline ? baseline.conditions?.[name] : null;
  const flips = baseHeadline
    ? compareConditions(baseHeadline, condition)
    : null;
  // "Never rank on fewer than three defects." A pair of runs that overlap on
  // fewer than `noise_floor_defects` scored defects carries no ranking signal,
  // so every rule that reads the flip counts is skipped below.
  const rankable = flips
    ? flips.ids.length >= (rules.noise_floor_defects ?? 0)
    : false;

  // Calibration gates every number under it. A judge below the floor produced
  // the matched ids, the recall, the P1 counts and the wrong-claim counts, so
  // the run is AMBER and unusable rather than GREEN, RED, or PROMOTE.
  if (!judgeCalibrationPasses(row)) {
    const notes = [...reasons, calibrationReason(row)];
    if (row.status !== "complete") notes.push(`run status is ${row.status}`);
    return { verdict: "AMBER", reasons: notes };
  }

  // A suspected leak gates every number under it for the same reason
  // calibration does: the run may have scored by reading the answer key, and
  // the runbook classifies that evidence as untrusted and AMBER. It therefore
  // precedes RED — escalating on untrusted evidence is as wrong as passing on
  // it, and RED here would name defects the run never really found or missed.
  if (leakSuspected(row)) {
    const notes = [
      ...reasons,
      "notes record a suspected leak; scores are not trusted",
    ];
    if (row.status !== "complete") notes.push(`run status is ${row.status}`);
    return { verdict: "AMBER", reasons: notes };
  }

  // An incomplete matrix gates the RED floors for the same reason calibration
  // and a leak do. The cells that never ran are the cells that would have
  // supplied the missing P1 matches, the missing claims and the missing
  // findings, so a subset's P1 recall, wrong-claim count and empty-PR count are
  // not the run's. The runbook classifies a run that did not complete as AMBER
  // and unusable for ranking; escalating on a subset would name flipped defects
  // the run never had the chance to find.
  if (row.status !== "complete") {
    return {
      verdict: "AMBER",
      reasons: [...reasons, `run status is ${row.status}`],
    };
  }

  // The paired regression is the one RED the control condition can explain
  // away: when control fell with the headline by at least the same threshold,
  // the model moved and the loss is not attributable to the skill, which the
  // runbook scores AMBER. The absolute floors below are floors either way, so
  // they stay RED whatever the control did.
  const worldMoved = controlMoved({ contract, row, baseline, flips });
  const regression =
    flips && rankable && flips.delta >= rules.regression_net_flips
      ? `${name} lost a net ${flips.delta} defects against the baseline (b=${flips.b}, c=${flips.c}, regression_net_flips ${rules.regression_net_flips})`
      : null;

  const red = [];
  if (regression && !worldMoved) red.push(regression);
  if (condition.p1.rate === null || condition.p1.rate === undefined) {
    // Zero P1 opportunities is not zero P1 recall. Say so instead of reading
    // an unmeasured rate as a floor breach.
    reasons.push(
      `${name} scored no P1 defect, so the p1_recall_floor check is skipped`,
    );
  } else if (condition.p1.rate < rules.p1_recall_floor) {
    red.push(
      `${name} P1 recall ${condition.p1.rate.toFixed(3)} is below p1_recall_floor ${rules.p1_recall_floor}`,
    );
  }
  // The ratio is taken against a baseline floored at one, so a clean baseline
  // still bounds the candidate instead of disabling the ceiling.
  const wrongClaimsBase = Math.max(baseHeadline?.wrong_claims ?? 0, 1);
  if (
    baseHeadline &&
    condition.wrong_claims >= rules.wrong_claims_ratio_ceiling * wrongClaimsBase
  ) {
    red.push(
      `${name} made ${condition.wrong_claims} wrong claims against a baseline of ${baseHeadline.wrong_claims} (ceiling ${rules.wrong_claims_ratio_ceiling}x, baseline floored at 1)`,
    );
  }
  for (const conditionName of HEADLINE_ORDER) {
    const other = row.conditions[conditionName];
    if (other && zeroFindingPrs(other) >= 2) {
      red.push(
        `${conditionName} emitted no parseable finding on ${zeroFindingPrs(other)} PRs`,
      );
    }
  }
  if (red.length) return { verdict: "RED", reasons: [...reasons, ...red] };

  const amber = [];
  if (!pairing.usable && baselineRow) {
    amber.push("row cannot be ranked against the given baseline");
  }
  if (flips && !rankable) {
    amber.push(
      `${name} and the baseline share only ${flips.ids.length} scored defect(s); noise_floor_defects ${rules.noise_floor_defects} refuses to rank on that`,
    );
  }
  if (
    flips &&
    rankable &&
    baseHeadline &&
    condition.recall.rate < baseHeadline.recall.rate &&
    flips.delta < rules.regression_net_flips
  ) {
    amber.push(
      `${name} recall ${condition.recall.rate.toFixed(3)} is below the baseline ${baseHeadline.recall.rate.toFixed(3)}, but the flip count is inside the noise floor`,
    );
  }
  if (worldMoved) {
    amber.push(worldMoved);
    if (regression) amber.push(regression);
  }
  if (amber.length)
    return { verdict: "AMBER", reasons: [...reasons, ...amber] };

  if (flips && rankable && -flips.delta >= rules.regression_net_flips) {
    return {
      verdict: "PROMOTE",
      reasons: [
        ...reasons,
        `${name} gained a net ${-flips.delta} defects against the baseline (b=${flips.b}, c=${flips.c})`,
      ],
    };
  }
  return {
    verdict: "GREEN",
    reasons: [
      ...reasons,
      flips
        ? `${name} moved b=${flips.b} c=${flips.c} against the baseline, inside the noise floor`
        : `${name} recall ${rateText(condition.recall.rate)}, P1 ${rateText(condition.p1.rate)}`,
    ],
  };
}

/**
 * The control condition isolates model drift. When control and the headline
 * move together by at least the flip threshold, the world moved and the score
 * is not attributable to the skill.
 */
function controlMoved({ contract, row, baseline, flips }) {
  if (!baseline || !flips || flips.delta === 0) return null;
  const control = row.conditions?.control;
  const baseControl = baseline.conditions?.control;
  if (!control || !baseControl) return null;
  const controlFlips = compareConditions(baseControl, control);
  if (controlFlips.delta === 0) return null;
  const sameDirection =
    Math.sign(controlFlips.delta) === Math.sign(flips.delta);
  if (
    sameDirection &&
    Math.abs(controlFlips.delta) >= contract.verdict_rules.regression_net_flips
  ) {
    return `control moved ${controlFlips.delta} defects in the same direction as the headline; the model moved, so the score is not attributable`;
  }
  return null;
}

/** Defect id to {path, line, title, severity}, read from the frozen truth. */
export function loadTruthIndex({ contract, repoRoot }) {
  const index = new Map();
  for (const fixture of contract?.fixtures ?? []) {
    const truth = JSON.parse(
      readFileSync(path.join(repoRoot, fixture.truth_file), "utf8"),
    );
    for (const finding of truth.findings ?? []) {
      index.set(String(finding.id), {
        pr: fixture.pr,
        path: finding.path,
        line: finding.line,
        title: finding.title,
        severity: finding.severity,
      });
    }
  }
  return index;
}

function normalizeTruth(truth) {
  if (truth instanceof Map) return truth;
  if (isObject(truth)) return new Map(Object.entries(truth));
  return new Map();
}

function describeDefect(id, truth) {
  const record = truth.get(String(id));
  if (!record) return id;
  const title = String(record.title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const clipped =
    title.length > MAX_TITLE_CHARS
      ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…`
      : title;
  return `${record.path}:${record.line} — ${clipped}`;
}

function percent(count) {
  const rate =
    count.rate === null || count.rate === undefined
      ? "n/a"
      : `${(count.rate * 100).toFixed(1)}%`;
  return `${count.matched}/${count.opportunities} (${rate})`;
}

function conditionRow(name, condition) {
  const model = condition.finder
    ? `${condition.finder} → ${condition.model}@${condition.effort}`
    : `${condition.model}@${condition.effort}`;
  return `| ${name} | ${model} | ${condition.draws} | ${percent(condition.recall)} | ${percent(condition.p1)} | ${condition.novel_real} | ${condition.wrong_claims} | $${condition.usd.toFixed(2)} | ${Math.round(condition.seconds)} |`;
}

/**
 * The PR body for a ledger run: verdict, condition table, the defects that
 * flipped, cost, and calibration. Capped at REPORT_MAX_LINES so a reviewer
 * reads the whole thing.
 */
export function renderReport({
  contract,
  row,
  baselineRow = null,
  baselineIsExplicit = true,
  truth = null,
  repoRoot = null,
}) {
  const truthIndex = truth
    ? normalizeTruth(truth)
    : repoRoot
      ? loadTruthIndex({ contract, repoRoot })
      : new Map();
  const decision = verdict({
    contract,
    row,
    baselineRow,
    baselineIsExplicit,
  });
  // The row is the artifact of record, so the report states the verdict the
  // row carries. Recomputing it is a check, never a silent substitution: a
  // disagreement is printed instead of hidden.
  const stored = row.verdict ?? decision.verdict;
  const disagreement =
    stored === decision.verdict
      ? null
      : `stored verdict ${stored} disagrees with the verdict recomputed here (${decision.verdict}); revalidate the row before ranking on it`;
  const { name, condition } = headlineCondition(row);
  const pairing = comparable(row, baselineRow, { baselineIsExplicit });
  const baseHeadline =
    pairing.usable && baselineRow ? baselineRow.conditions?.[name] : null;
  const flips = baseHeadline
    ? compareConditions(baseHeadline, condition)
    : null;

  const totals = Object.values(row.conditions).reduce(
    (sum, item) => ({
      usd: sum.usd + item.usd,
      seconds: sum.seconds + item.seconds,
    }),
    { usd: 0, seconds: 0 },
  );

  const lines = [
    `## Review-skill eval — ${row.executed_at.slice(0, 10)} (${row.kind})`,
    "",
    `**${stored}** — status ${row.status}, suite \`${contract.suite_id}\`, key \`${row.comparability_key.slice(0, 8)}\``,
    "",
    ...(disagreement ? [`- **${disagreement}**`] : []),
    ...decision.reasons.map((reason) => `- ${reason}`),
    "",
    "| condition | model | draws | recall | P1 | novel-real | wrong | $ | s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...HEADLINE_ORDER.filter((key) => row.conditions[key]).map((key) =>
      conditionRow(key, row.conditions[key]),
    ),
    "",
  ];

  if (flips) {
    lines.push(
      `McNemar vs ${baselineRow.executed_at.slice(0, 10)} on \`${name}\`: b=${flips.b} c=${flips.c} delta=${flips.delta} over ${flips.ids.length} paired defects.`,
      "",
    );
    const flipLines = [
      ...flips.lost.map(
        (id) => `- lost \`${id}\` ${describeDefect(id, truthIndex)}`,
      ),
      ...flips.gained.map(
        (id) => `- gained \`${id}\` ${describeDefect(id, truthIndex)}`,
      ),
    ];
    if (flipLines.length === 0) {
      lines.push("No defect changed state against the baseline.", "");
    } else {
      lines.push(...flipLines.slice(0, MAX_FLIP_LINES));
      if (flipLines.length > MAX_FLIP_LINES) {
        lines.push(`- ...and ${flipLines.length - MAX_FLIP_LINES} more flips.`);
      }
      lines.push("");
    }
  } else {
    lines.push("No paired baseline comparison for this row.", "");
  }

  // The cells are one half of what a run costs; the judges are the other. A
  // total that counts only the cells understates the run by a judge pass.
  const scoringUsd =
    typeof row.scoring_usd === "number" && Number.isFinite(row.scoring_usd)
      ? row.scoring_usd
      : 0;
  lines.push(
    `Judge calibration ${row.judge_calibration.agreement}/${row.judge_calibration.total}. Cost $${(totals.usd + scoringUsd).toFixed(2)} over ${Math.round(totals.seconds)} s — $${totals.usd.toFixed(2)} cells, $${scoringUsd.toFixed(2)} scoring.`,
    `Skill \`${row.inputs.skill_ref}\` (\`${row.inputs.skill_digest.slice(0, 8)}\`), claude ${row.inputs.claude_cli}, codex ${row.inputs.codex_cli}, host ${row.inputs.host}.`,
    `Detail: \`${row.detail_dir}\`. Contract \`${row.contract_digest.slice(0, 8)}\`.`,
  );

  if (lines.length > REPORT_MAX_LINES) {
    const kept = lines.slice(0, REPORT_MAX_LINES - 1);
    kept.push(
      `- report truncated at ${REPORT_MAX_LINES} lines; read \`${row.detail_dir}\`.`,
    );
    return `${kept.join("\n")}\n`;
  }
  return `${lines.join("\n")}\n`;
}

/** Dedup marker for the staleness issue: one issue per contract per month. */
export function reviewEvalMonthMarker(month, digest) {
  if (!/^\d{4}-\d{2}$/.test(month ?? "")) {
    throw new Error(`invalid month: ${month}`);
  }
  if (!/^[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error("invalid contract digest");
  }
  return `${REVIEW_EVAL_STALENESS_MARKER_PREFIX}${JSON.stringify({ month, contract_digest: digest })} -->`;
}

/** Read the marker block back, the way the garden scheduler reads its own. */
export function parseLeadingReviewEvalMarkers(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  if (lines[0] !== REVIEW_EVAL_MARKER) return null;
  const metadataLine = lines[1] ?? "";
  if (
    !metadataLine.startsWith(REVIEW_EVAL_STALENESS_MARKER_PREFIX) ||
    !metadataLine.endsWith(" -->")
  ) {
    throw new Error(
      "review-eval issue has a missing or malformed month marker",
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(
      metadataLine.slice(
        REVIEW_EVAL_STALENESS_MARKER_PREFIX.length,
        -" -->".length,
      ),
    );
  } catch (error) {
    throw new Error("review-eval month marker is not valid JSON", {
      cause: error,
    });
  }
  if (
    !/^\d{4}-\d{2}$/.test(metadata?.month ?? "") ||
    !/^[0-9a-f]{64}$/.test(metadata?.contract_digest ?? "")
  ) {
    throw new Error("review-eval month marker has invalid metadata");
  }
  return metadata;
}

/**
 * The staleness issue for a stale ledger, or null while the ledger is fresh.
 * The body opens with the same two-line marker block the documentation
 * schedulers use, so one issue per contract per month is the dedup key.
 */
export function scheduleIssuePayload({
  freshnessResult,
  contract,
  contractDigest = null,
  month = null,
}) {
  if (!freshnessResult) throw new Error("scheduleIssuePayload needs freshness");
  if (freshnessResult.level === "green") return null;
  const digest = contractDigest ?? freshnessResult.contractDigest;
  if (!/^[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error(
      "scheduleIssuePayload needs the current contract digest for its dedup marker",
    );
  }
  const markerMonth = month ?? freshnessResult.evaluatedAt.slice(0, 7);
  const lastFull = freshnessResult.lastFullAt
    ? freshnessResult.lastFullAt.slice(0, 10)
    : "never";
  const cadence = contract.cadence_days;
  const body = [
    REVIEW_EVAL_MARKER,
    reviewEvalMonthMarker(markerMonth, digest),
    "",
    "### Goal",
    "",
    `Run the review-skill evaluation and append its row to \`docs/evals/review-skill-ledger.jsonl\`. The last full run was ${lastFull}; the freshness guard is ${freshnessResult.level}.`,
    "",
    "### Context and links",
    "",
    "- Evaluation contract: `docs/evals/review-skill-fixtures.json`",
    "- Runbook: `docs/evals/review-skill.md`",
    `- Contract digest: \`${digest}\``,
    `- Cadence: canary ${cadence.canary} d, full ${cadence.full} d; red after ${cadence.freshness_red} d since any run, after ${cadence.complete_red} d since a complete run, after ${cadence.full_red} d since a full run.`,
    "- This issue is a reminder. The scheduled workflow never invokes a model.",
    "",
    "Freshness reasons:",
    "",
    ...freshnessResult.reasons.map((reason) => `- ${reason}`),
    "",
    "### Acceptance criteria",
    "",
    "- [ ] Claim this issue before spending model quota.",
    "- [ ] Run the harness on a clean worktree of `origin/main`.",
    "- [ ] Append one ledger row; never edit a committed row.",
    "- [ ] Open the ledger PR with the generated report as its body.",
    "- [ ] Escalate a RED verdict as its own issue naming the flipped defects.",
    "",
    "### Verification commands",
    "",
    "```bash",
    // One mode per invocation: the CLI refuses two, so a combined line would
    // fail the moment an operator pasted this block.
    "pnpm review:eval -- --check-fixtures",
    "pnpm review:eval -- --check-ledger",
    "pnpm review:eval:run",
    "pnpm review:eval -- --report",
    "```",
    "",
    "### Risks, non-goals, and do-not-touch",
    "",
    "- The harness spends real model quota. Do not re-run it to chase a nicer verdict.",
    "- Never rewrite frozen truth, the scorable id lists, or a committed baseline.",
    "- No model credential belongs in CI or in this scheduler.",
    "",
    "### Done means",
    "",
    "A ledger PR carrying one new row is merged by a human reviewer, and this issue is closed by that PR.",
    "",
  ].join("\n");
  return {
    title: `Review-skill eval is stale (last full run ${lastFull})`,
    body,
    labels: [...REVIEW_EVAL_ISSUE_LABELS],
  };
}
