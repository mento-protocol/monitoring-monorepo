// Deterministic decisions for the non-ledger review-skill experiment lane.

import { EXPERIMENT_STATUSES } from "./review-eval-experiment-contract.mjs";
import { stagePlanFor } from "./review-eval-experiment-evidence.mjs";

function result(status, details) {
  if (!EXPERIMENT_STATUSES.includes(status)) {
    throw new Error(`invalid experiment status ${status}`);
  }
  return { status, ...details };
}

function leakSuspected(value) {
  return value === true || value?.suspected === true;
}

function finiteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function claimInflationRequiresNovelty({
  incumbentClaims,
  candidateClaims,
  policy,
}) {
  if (!finiteCount(incumbentClaims) || !finiteCount(candidateClaims)) {
    throw new Error("claim counts must be non-negative integers");
  }
  const configured = policy?.claim_inflation ?? policy;
  const absolute = Number(configured?.absolute_delta_min ?? 3);
  const ratio = Number(configured?.ratio_min ?? 1.25);
  const delta = candidateClaims - incumbentClaims;
  const measuredRatio =
    incumbentClaims === 0
      ? candidateClaims === 0
        ? 1
        : Number.POSITIVE_INFINITY
      : candidateClaims / incumbentClaims;
  return {
    required: delta >= absolute && measuredRatio >= ratio,
    delta,
    ratio: measuredRatio,
    thresholds: { absolute_delta_min: absolute, ratio_min: ratio },
  };
}

function expectedRecords({ plan, candidateId, stage }) {
  const stagePlan = stagePlanFor({ plan, candidateId, stage });
  return stagePlan.lanes.flatMap((lane) =>
    lane.sequence.map((arm) => ({
      pr: lane.pr,
      treatment: arm.treatment,
      scorableIds: lane.fixture.scorable_ids,
      p1Ids: lane.fixture.p1_ids,
    })),
  );
}

function inspectRecords({ plan, candidateId, stage, records }) {
  const expected = expectedRecords({ plan, candidateId, stage });
  const source = Array.isArray(records) ? records : [];
  const issues = [];
  const usable = [];
  for (const wanted of expected) {
    const matches = source.filter(
      (record) =>
        record?.pr === wanted.pr && record?.treatment === wanted.treatment,
    );
    if (matches.length !== 1) {
      issues.push({
        kind: "malformed",
        treatment: wanted.treatment,
        pr: wanted.pr,
        reason:
          matches.length === 0 ? "result is missing" : "result is duplicated",
      });
      continue;
    }
    const record = matches[0];
    if (record.ok !== true || record.malformed === true) {
      issues.push({
        kind: "malformed",
        treatment: wanted.treatment,
        pr: wanted.pr,
        reason: "result is not a valid completed arm",
      });
      continue;
    }
    if (
      !Array.isArray(record.matched_ids) ||
      !finiteCount(record.claims_count)
    ) {
      issues.push({
        kind: "malformed",
        treatment: wanted.treatment,
        pr: wanted.pr,
        reason: "result has no matched_ids or claims_count",
      });
      continue;
    }
    const allowed = new Set(wanted.scorableIds);
    const uniqueMatched = [...new Set(record.matched_ids)];
    if (
      uniqueMatched.some((id) => !Number.isSafeInteger(id) || !allowed.has(id))
    ) {
      issues.push({
        kind: "malformed",
        treatment: wanted.treatment,
        pr: wanted.pr,
        reason: "result names a defect outside the frozen denominator",
      });
      continue;
    }
    if (leakSuspected(record.leak)) {
      issues.push({
        kind: "leak",
        treatment: wanted.treatment,
        pr: wanted.pr,
        reason: "result carries a hard leak signal",
      });
      continue;
    }
    if (record.empty === true || record.claims_count === 0) {
      issues.push({
        kind: "empty",
        treatment: wanted.treatment,
        pr: wanted.pr,
        reason: "result contains no review claim",
      });
      continue;
    }
    const p1 = new Set(wanted.p1Ids);
    usable.push({
      ...record,
      matched_ids: uniqueMatched,
      known: uniqueMatched.length,
      p1: uniqueMatched.filter((id) => p1.has(id)).length,
    });
  }
  const expectedKeys = new Set(
    expected.map((entry) => `${entry.pr}:${entry.treatment}`),
  );
  for (const record of source) {
    const key = `${record?.pr}:${record?.treatment}`;
    if (!expectedKeys.has(key)) {
      issues.push({
        kind: "malformed",
        treatment: record?.treatment ?? "unknown",
        pr: record?.pr ?? null,
        reason: "result is outside the planned stage",
      });
    }
  }
  return { issues, usable };
}

function invalidDecision({ candidateId, stage, inspected }) {
  const candidateLeak = inspected.issues.some(
    (issue) => issue.kind === "leak" && issue.treatment === "candidate",
  );
  const candidateEmpty = inspected.issues.some(
    (issue) => issue.kind === "empty" && issue.treatment === "candidate",
  );
  const hard = candidateLeak || candidateEmpty;
  return result(hard ? "REJECT" : "INCONCLUSIVE", {
    candidate_id: candidateId,
    stage,
    reasons: inspected.issues.map(
      (issue) => `${issue.treatment} PR ${issue.pr}: ${issue.reason}`,
    ),
    metrics: null,
    novelty: {
      required: false,
      deferred: true,
      reason: "the paired evidence is invalid",
    },
  });
}

function aggregate(inspections) {
  const records = inspections.flatMap((inspection) => inspection.usable);
  const prs = [...new Set(records.map((record) => record.pr))].sort(
    (a, b) => a - b,
  );
  const perPr = prs.map((pr) => {
    const incumbent = records.filter(
      (record) => record.pr === pr && record.treatment === "incumbent",
    );
    const candidate = records.filter(
      (record) => record.pr === pr && record.treatment === "candidate",
    );
    const total = (items, field) =>
      items.reduce((sum, record) => sum + record[field], 0);
    const incumbentKnown = total(incumbent, "known");
    const candidateKnown = total(candidate, "known");
    const incumbentP1 = total(incumbent, "p1");
    const candidateP1 = total(candidate, "p1");
    return {
      pr,
      known: {
        incumbent: incumbentKnown,
        candidate: candidateKnown,
        net: candidateKnown - incumbentKnown,
      },
      p1: {
        incumbent: incumbentP1,
        candidate: candidateP1,
        net: candidateP1 - incumbentP1,
      },
      claims: {
        incumbent: total(incumbent, "claims_count"),
        candidate: total(candidate, "claims_count"),
      },
    };
  });
  const sum = (selector) =>
    records.reduce((total, record) => total + selector(record), 0);
  const wrongComplete = records.every((record) =>
    finiteCount(record.wrong_claims),
  );
  const incumbentWrong = wrongComplete
    ? sum((record) =>
        record.treatment === "incumbent" ? record.wrong_claims : 0,
      )
    : null;
  const candidateWrong = wrongComplete
    ? sum((record) =>
        record.treatment === "candidate" ? record.wrong_claims : 0,
      )
    : null;
  const incumbentKnown = sum((record) =>
    record.treatment === "incumbent" ? record.known : 0,
  );
  const candidateKnown = sum((record) =>
    record.treatment === "candidate" ? record.known : 0,
  );
  const incumbentP1 = sum((record) =>
    record.treatment === "incumbent" ? record.p1 : 0,
  );
  const candidateP1 = sum((record) =>
    record.treatment === "candidate" ? record.p1 : 0,
  );
  const incumbentClaims = sum((record) =>
    record.treatment === "incumbent" ? record.claims_count : 0,
  );
  const candidateClaims = sum((record) =>
    record.treatment === "candidate" ? record.claims_count : 0,
  );
  return {
    known: {
      incumbent: incumbentKnown,
      candidate: candidateKnown,
      net: candidateKnown - incumbentKnown,
    },
    p1: {
      incumbent: incumbentP1,
      candidate: candidateP1,
      net: candidateP1 - incumbentP1,
    },
    claims: {
      incumbent: incumbentClaims,
      candidate: candidateClaims,
    },
    wrong_claims: {
      complete: wrongComplete,
      incumbent: incumbentWrong,
      candidate: candidateWrong,
      net: wrongComplete ? candidateWrong - incumbentWrong : null,
    },
    nonnegative_prs: perPr.filter((row) => row.known.net >= 0).length,
    gaining_prs: perPr.filter((row) => row.known.net > 0).length,
    per_pr: perPr,
  };
}

function recallFailures({ metrics, stage, policy }) {
  if (stage === "holdout") {
    const threshold = policy.combined;
    return [
      [
        metrics.known.net < threshold.known_net_min,
        `known net ${metrics.known.net} is below ${threshold.known_net_min}`,
      ],
      [
        metrics.p1.candidate < threshold.candidate_p1_min,
        `candidate P1 ${metrics.p1.candidate} is below ${threshold.candidate_p1_min}/${threshold.p1_opportunities}`,
      ],
      [
        metrics.p1.net < threshold.p1_net_min,
        `P1 net ${metrics.p1.net} is below ${threshold.p1_net_min}`,
      ],
      [
        metrics.gaining_prs < threshold.gaining_prs_min,
        `gains cover ${metrics.gaining_prs} PRs, below ${threshold.gaining_prs_min}`,
      ],
    ]
      .filter(([failed]) => failed)
      .map(([, reason]) => reason);
  }
  const threshold = policy.screen;
  return [
    [
      metrics.known.net < threshold.known_net_min,
      `known net ${metrics.known.net} is below ${threshold.known_net_min}`,
    ],
    [
      metrics.p1.net < threshold.p1_net_min,
      `P1 net ${metrics.p1.net} is below ${threshold.p1_net_min}`,
    ],
    [
      metrics.nonnegative_prs < threshold.nonnegative_prs_min,
      `${metrics.nonnegative_prs} PRs are nonnegative, below ${threshold.nonnegative_prs_min}`,
    ],
  ]
    .filter(([failed]) => failed)
    .map(([, reason]) => reason);
}

export function evaluateExperimentDecision({
  plan,
  candidateId,
  stage,
  recordsByStage,
}) {
  const stages = stage === "holdout" ? ["screen", "holdout"] : [stage];
  const inspections = stages.map((stageName) =>
    inspectRecords({
      plan,
      candidateId,
      stage: stageName,
      records: recordsByStage?.[stageName],
    }),
  );
  if (inspections.some((inspection) => inspection.issues.length > 0)) {
    return invalidDecision({
      candidateId,
      stage,
      inspected: {
        issues: inspections.flatMap((inspection) => inspection.issues),
      },
    });
  }
  const metrics = aggregate(inspections);
  const recall = recallFailures({ metrics, stage, policy: plan.policy });
  if (recall.length > 0) {
    const clearRegression = metrics.known.net <= -2 || metrics.p1.net < 0;
    return result(clearRegression ? "REJECT" : "INCONCLUSIVE", {
      candidate_id: candidateId,
      stage,
      reasons: recall,
      metrics,
      novelty: {
        required: false,
        deferred: true,
        reason: clearRegression
          ? "clear regression failed the recall gate before novelty"
          : "finalist recall evidence is insufficient, so novelty stays deferred",
      },
    });
  }
  const inflation = claimInflationRequiresNovelty({
    incumbentClaims: metrics.claims.incumbent,
    candidateClaims: metrics.claims.candidate,
    policy: plan.policy,
  });
  const noveltyRequired = stage === "holdout" || inflation.required;
  if (noveltyRequired && !metrics.wrong_claims.complete) {
    return result("INCONCLUSIVE", {
      candidate_id: candidateId,
      stage,
      reasons: [
        stage === "holdout"
          ? "combined finalist scoring requires wrong-claim classification"
          : "material claim inflation requires wrong-claim classification",
      ],
      metrics,
      novelty: {
        required: true,
        deferred: true,
        reason:
          stage === "holdout"
            ? "candidate passed combined recall gates"
            : `candidate emitted ${inflation.delta} more claims at ${inflation.ratio.toFixed(2)}x`,
      },
    });
  }
  if (
    noveltyRequired &&
    metrics.wrong_claims.candidate >
      metrics.wrong_claims.incumbent +
        plan.policy.combined.wrong_claim_delta_max
  ) {
    return result("REJECT", {
      candidate_id: candidateId,
      stage,
      reasons: [
        `candidate wrong claims ${metrics.wrong_claims.candidate} exceed incumbent ${metrics.wrong_claims.incumbent} by more than ${plan.policy.combined.wrong_claim_delta_max}`,
      ],
      metrics,
      novelty: {
        required: true,
        deferred: false,
        reason: "wrong-claim classification is complete",
      },
    });
  }
  return result("PROMISING", {
    candidate_id: candidateId,
    stage,
    reasons: [
      stage === "holdout"
        ? "candidate passed the combined screen and holdout gates"
        : "candidate passed the paired screen gates",
    ],
    metrics,
    novelty: {
      required: noveltyRequired,
      deferred: !noveltyRequired,
      reason: noveltyRequired
        ? "wrong-claim classification is complete"
        : "no material claim inflation requires novel classification",
    },
  });
}
