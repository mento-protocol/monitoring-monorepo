// Deterministic decisions for the lightweight review-skill experiment.

import { stagePlanFor } from "./review-eval-experiment-contract.mjs";
import { runtimeDriftReason } from "./review-eval-experiment-versions.mjs";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function decision(status, details) {
  return { status, ...details };
}
function policyFor(plan) {
  const policy = plan?.policy;
  const values = [
    policy?.screen?.known_net_min,
    policy?.screen?.p1_net_min,
    policy?.screen?.nonnegative_prs_min,
    policy?.combined?.known_net_min,
    policy?.combined?.candidate_p1_min,
    policy?.combined?.p1_net_min,
    policy?.combined?.gaining_prs_min,
    policy?.combined?.wrong_claim_delta_max,
    policy?.claim_inflation?.absolute_delta_min,
    policy?.claim_inflation?.ratio_min,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("plan policy is invalid");
  }
  return policy;
}
function candidateIdFor(plan, supplied) {
  const planned = plan?.candidate?.id;
  if (!planned || (supplied !== undefined && supplied !== planned)) {
    throw new Error(`plan has no candidate ${supplied ?? ""}`.trim());
  }
  return planned;
}
function recordKey(record) {
  return JSON.stringify([
    record.stage,
    record.cell_id,
    record.pr,
    record.treatment,
  ]);
}
function plannedRecords({ plan, candidateId, stage }) {
  const campaignId = plan?.campaign_id;
  if (!campaignId) throw new Error("plan has no campaign_id");
  const stagePlan = stagePlanFor({ plan, stage });
  if (!stagePlan.enabled) throw new Error(`${stage} is not enabled`);
  const output = stagePlan.lanes.flatMap((lane) =>
    lane.sequence.map((treatment) => ({
      campaignId,
      candidateId,
      stage,
      cell_id: `${lane.lane_id}-${treatment}`,
      pr: lane.pr,
      treatment,
      scorableIds: lane.fixture.scorable_ids,
      p1Ids: lane.fixture.p1_ids,
    })),
  );
  const keys = output.map(recordKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${stage} plans duplicate records`);
  }
  return output;
}
function hardLeak(value) {
  return value?.suspected === true;
}
function issue(kind, wanted, reason) {
  return {
    kind,
    treatment: wanted?.treatment ?? "unknown",
    pr: wanted?.pr ?? "unknown",
    reason,
  };
}

function validateRecord(record, wanted) {
  const issues = [];
  const add = (kind, reason) => issues.push(issue(kind, wanted, reason));
  if (hardLeak(record.leak)) add("leak", "result carries a hard leak signal");
  if (
    typeof record.cell_id !== "string" ||
    Object.hasOwn(record, "cellId") ||
    typeof record.empty !== "boolean" ||
    !isObject(record.leak) ||
    typeof record.leak.suspected !== "boolean"
  ) {
    add("malformed", "result has invalid cell, empty, or leak evidence");
  }
  if (record.empty === true || record.claims_count === 0) {
    add("empty", "result contains no review claim");
  }
  if (
    record.ok !== true ||
    record.malformed === true ||
    record.campaign_id !== wanted.campaignId ||
    record.candidate_id !== wanted.candidateId
  ) {
    add("malformed", "result provenance or completion state is invalid");
  }
  if (!count(record.claims_count) || !Array.isArray(record.matched_ids)) {
    add("malformed", "result has invalid claim or match counts");
  } else if (
    new Set(record.matched_ids).size !== record.matched_ids.length ||
    record.matched_ids.some(
      (id) => !Number.isSafeInteger(id) || !wanted.scorableIds.includes(id),
    )
  ) {
    add("malformed", "result has duplicate or unplanned matched IDs");
  }
  if (
    Object.hasOwn(record, "wrong_claims") &&
    (!count(record.wrong_claims) || record.wrong_claims > record.claims_count)
  ) {
    add("malformed", "result has an invalid wrong-claim count");
  }
  if (issues.length > 0) return { issues, usable: null };
  const p1 = new Set(wanted.p1Ids);
  return {
    issues,
    usable: {
      ...record,
      known: record.matched_ids.length,
      p1: record.matched_ids.filter((id) => p1.has(id)).length,
    },
  };
}

function inspectStage({ plan, candidateId, stage, records }) {
  const expected = plannedRecords({ plan, candidateId, stage });
  if (!Array.isArray(records)) {
    return {
      issues: [issue("malformed", null, `${stage} records are missing`)],
      usable: [],
    };
  }
  const expectedByKey = new Map(
    expected.map((item) => [recordKey(item), item]),
  );
  const actualByKey = new Map();
  const issues = [];
  for (const record of records) {
    if (!isObject(record)) {
      issues.push(issue("malformed", null, "result is not an object"));
      continue;
    }
    const key = recordKey(record);
    const wanted = expectedByKey.get(key);
    if (!wanted) {
      issues.push(issue("malformed", record, "result is outside the plan"));
      continue;
    }
    actualByKey.set(key, [...(actualByKey.get(key) ?? []), record]);
  }
  const usable = [];
  for (const wanted of expected) {
    const matches = actualByKey.get(recordKey(wanted)) ?? [];
    if (matches.length !== 1) {
      issues.push(
        issue(
          "malformed",
          wanted,
          matches.length === 0 ? "result is missing" : "result is duplicated",
        ),
      );
    }
    for (const record of matches) {
      const checked = validateRecord(record, wanted);
      issues.push(...checked.issues);
      if (matches.length === 1 && checked.usable) usable.push(checked.usable);
    }
  }
  return { issues, usable };
}

function invalidDecision({ candidateId, stage, issues }) {
  const hardCandidate = issues.some(
    (entry) =>
      entry.treatment === "candidate" && ["empty", "leak"].includes(entry.kind),
  );
  return decision(hardCandidate ? "REJECT" : "INCONCLUSIVE", {
    candidate_id: candidateId,
    stage,
    reasons: issues.map(
      (entry) => `${entry.treatment} PR ${entry.pr}: ${entry.reason}`,
    ),
    metrics: null,
    novelty: {
      required: false,
      deferred: true,
      reason: "paired evidence is invalid",
    },
  });
}

function aggregate(inspections) {
  const records = inspections.flatMap((inspection) => inspection.usable);
  const prs = [...new Set(records.map((record) => record.pr))].sort(
    (left, right) => left - right,
  );
  const totals = (treatment, field) =>
    records
      .filter((record) => record.treatment === treatment)
      .reduce((sum, record) => sum + record[field], 0);
  const perPr = prs.map((pr) => {
    const own = records.filter((record) => record.pr === pr);
    const total = (treatment, field) =>
      own
        .filter((record) => record.treatment === treatment)
        .reduce((sum, record) => sum + record[field], 0);
    const incumbent = total("incumbent", "known");
    const candidate = total("candidate", "known");
    return {
      pr,
      known: { incumbent, candidate, net: candidate - incumbent },
    };
  });
  const pair = (field) => {
    const incumbent = totals("incumbent", field);
    const candidate = totals("candidate", field);
    return { incumbent, candidate, net: candidate - incumbent };
  };
  const wrongComplete = records.every((record) => count(record.wrong_claims));
  return {
    known: pair("known"),
    p1: pair("p1"),
    claims: pair("claims_count"),
    wrong_claims: wrongComplete
      ? { complete: true, ...pair("wrong_claims") }
      : { complete: false, incumbent: null, candidate: null, net: null },
    nonnegative_prs: perPr.filter((row) => row.known.net >= 0).length,
    gaining_prs: perPr.filter((row) => row.known.net > 0).length,
    per_pr: perPr,
  };
}

export function claimInflationRequiresNovelty({
  incumbentClaims,
  candidateClaims,
  policy,
}) {
  if (!count(incumbentClaims) || !count(candidateClaims)) {
    throw new Error("claim counts must be non-negative integers");
  }
  const configured = policy?.claim_inflation ?? policy;
  const absolute = configured?.absolute_delta_min;
  const ratioMin = configured?.ratio_min;
  if (!Number.isFinite(absolute) || absolute < 0) {
    throw new Error("claim inflation absolute threshold is invalid");
  }
  if (!Number.isFinite(ratioMin) || ratioMin < 0) {
    throw new Error("claim inflation ratio threshold is invalid");
  }
  const delta = candidateClaims - incumbentClaims;
  const ratio =
    incumbentClaims === 0
      ? candidateClaims === 0
        ? 1
        : Number.POSITIVE_INFINITY
      : candidateClaims / incumbentClaims;
  return {
    required: delta >= absolute && ratio >= ratioMin,
    delta,
    ratio,
    thresholds: { absolute_delta_min: absolute, ratio_min: ratioMin },
  };
}

function recallFailures(metrics, stage, policy) {
  const threshold = stage === "holdout" ? policy.combined : policy.screen;
  const checks =
    stage === "holdout"
      ? [
          [metrics.known.net < threshold.known_net_min, "known net"],
          [metrics.p1.candidate < threshold.candidate_p1_min, "candidate P1"],
          [metrics.p1.net < threshold.p1_net_min, "P1 net"],
          [metrics.gaining_prs < threshold.gaining_prs_min, "gaining PRs"],
        ]
      : [
          [metrics.known.net < threshold.known_net_min, "known net"],
          [metrics.p1.net < threshold.p1_net_min, "P1 net"],
          [
            metrics.nonnegative_prs < threshold.nonnegative_prs_min,
            "nonnegative PRs",
          ],
        ];
  return checks
    .filter(([failed]) => failed)
    .map(([, label]) => `${label} missed`);
}

function stageDecision({
  plan,
  candidateId: suppliedCandidateId,
  stage,
  recordsByStage,
}) {
  const candidateId = candidateIdFor(plan, suppliedCandidateId);
  const policy = policyFor(plan);
  const stages = stage === "holdout" ? ["screen", "holdout"] : [stage];
  const actualStages = isObject(recordsByStage)
    ? Object.keys(recordsByStage).sort()
    : [];
  const issues = [];
  if (JSON.stringify(actualStages) !== JSON.stringify([...stages].sort())) {
    issues.push(issue("malformed", null, "record stages differ from the plan"));
  }
  const inspections = stages.map((stageName) =>
    inspectStage({
      plan,
      candidateId,
      stage: stageName,
      records: recordsByStage?.[stageName],
    }),
  );
  issues.push(...inspections.flatMap((inspection) => inspection.issues));
  if (issues.length > 0) {
    return invalidDecision({ candidateId, stage, issues });
  }

  const metrics = aggregate(inspections);
  const failures = recallFailures(metrics, stage, policy);
  if (failures.length > 0) {
    const clearRegression = metrics.known.net <= -2 || metrics.p1.net < 0;
    return decision(clearRegression ? "REJECT" : "INCONCLUSIVE", {
      candidate_id: candidateId,
      stage,
      reasons: failures,
      metrics,
      novelty: {
        required: false,
        deferred: true,
        reason: "recall thresholds did not pass",
      },
    });
  }

  const inflation = claimInflationRequiresNovelty({
    incumbentClaims: metrics.claims.incumbent,
    candidateClaims: metrics.claims.candidate,
    policy,
  });
  const noveltyRequired = stage === "holdout" || inflation.required;
  if (noveltyRequired && !metrics.wrong_claims.complete) {
    return decision("INCONCLUSIVE", {
      candidate_id: candidateId,
      stage,
      reasons: ["wrong-claim classification is deferred"],
      metrics,
      novelty: {
        required: true,
        deferred: true,
        reason:
          stage === "holdout"
            ? "combined recall thresholds passed"
            : "material claim inflation requires classification",
      },
    });
  }
  if (
    noveltyRequired &&
    metrics.wrong_claims.net > policy.combined.wrong_claim_delta_max
  ) {
    return decision("REJECT", {
      candidate_id: candidateId,
      stage,
      reasons: ["candidate wrong-claim delta is too high"],
      metrics,
      novelty: {
        required: true,
        deferred: false,
        reason: "wrong-claim classification is complete",
      },
    });
  }
  return decision("PROMISING", {
    candidate_id: candidateId,
    stage,
    reasons: [
      stage === "holdout"
        ? "combined thresholds passed"
        : "paired thresholds passed",
    ],
    metrics,
    novelty: {
      required: noveltyRequired,
      deferred: !noveltyRequired,
      reason: noveltyRequired
        ? "wrong-claim classification is complete"
        : "novelty classification is not required",
    },
  });
}

/**
 * Decide one stage. A campaign resumed under an upgraded provider CLI keeps its
 * thresholds; the drift is named in the reasons so a flip is never read as the
 * skill when it may be the runtime.
 */
export function evaluateExperimentDecision({
  runtimeDrift = null,
  ...options
}) {
  const result = stageDecision(options);
  const reason = runtimeDriftReason(runtimeDrift);
  if (reason === null) return result;
  return {
    ...result,
    reasons: [reason, ...result.reasons],
    runtime_drift: {
      providers: runtimeDrift.providers,
      cell_ids: [...new Set(runtimeDrift.cell_ids ?? [])].sort(),
    },
  };
}
