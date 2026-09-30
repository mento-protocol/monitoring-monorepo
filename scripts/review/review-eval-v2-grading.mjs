// Grading-only orchestration. Reviewer execution helpers arrive as callbacks.
import path from "node:path";
import { digestObject } from "./review-eval-experiment-contract.mjs";
import {
  readExperimentCache,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";
import { parseClaudeStream } from "./review-eval-stream.mjs";
import { leakSignals } from "./review-eval-run-cell.mjs";
import { rootsForCase } from "./review-eval-v2-selection.mjs";
import { scoreReview, scorerDigestV2 } from "./review-eval-v2-score.mjs";
import { writeJson } from "./review-eval-v2-provider.mjs";
import { invokeJudge } from "./review-eval-v2-judge-provider.mjs";
import { metricSummary } from "./review-eval-v2-report.mjs";

const keyed = (value) => ({ ...value, digest: digestObject(value) });

export function scoringIdentity({
  rawDigest,
  datasetDigest,
  scorerDigest,
  model,
  effort,
  version,
}) {
  return keyed({
    namespace: "review-eval-v2",
    phase: "score",
    raw_digest: rawDigest,
    dataset_digest: datasetDigest,
    scorer_digest: scorerDigest,
    model,
    effort,
    cli_version: version,
  });
}

export async function gradeCell({
  plan,
  cell,
  fixture,
  raw,
  reused,
  loaded,
  version,
  out,
  provider,
  prepare,
  sourceState,
  sourceDiff,
}) {
  if (
    raw.payload.completed !== true ||
    raw.payload.output_contract !== plan.output_contract ||
    raw.payload.envelope?.is_error !== false ||
    typeof raw.payload.final_text !== "string" ||
    !raw.payload.final_text.trim()
  ) {
    throw new Error("raw artifact lacks a completed final-review contract");
  }
  const leak = leakSignals({
    transcript: [
      ...parseClaudeStream(raw.payload.stream).messages,
      raw.payload.final_text,
    ].join("\n"),
    truth: { findings: loaded.dataset.roots },
    pr: fixture.pr,
    forbiddenShas: fixture.forbidden_shas,
  });
  if (leak.suspected)
    throw new Error(`possible answer-key leak: ${leak.hard.join("; ")}`);
  const scoreId = scoringIdentity({
    rawDigest: raw.artifact.content_digest,
    datasetDigest: loaded.digest,
    scorerDigest: scorerDigestV2(),
    model: plan.model,
    effort: plan.effort,
    version,
  });
  let scored = readExperimentCache({
    artifactRoot: out,
    kind: "score",
    identity: scoreId,
  });
  const scoreReused = Boolean(scored);
  if (!scored) {
    const isolated = prepare();
    if (sourceState(isolated.path) !== raw.payload.source_state)
      throw new Error("source fixture differs from raw execution");
    let judgeIndex = 0;
    const exec = async (request) => {
      if (scorerDigestV2() !== scoreId.scorer_digest)
        throw new Error("scorer changed during grading");
      const before = sourceState(isolated.path);
      const result = await invokeJudge(provider, {
        ...request,
        label: `${fixture.id}/${cell.treatment}/judge-${judgeIndex++}`,
      });
      scorerDigestV2();
      if (sourceState(isolated.path) !== before)
        throw new Error("grader mutated source fixture");
      return JSON.stringify(result.envelope);
    };
    process.stderr.write(`score ${fixture.id}/${cell.treatment}\n`);
    const result = await scoreReview({
      review: {
        finalText: raw.payload.final_text,
        completed: raw.payload.completed,
        outputContract: raw.payload.output_contract,
      },
      defects: rootsForCase(loaded.dataset, fixture.id),
      sourceDiff: sourceDiff(isolated.path),
      fixturePath: isolated.path,
      judge: { exec, model: plan.model, effort: plan.effort },
    });
    scorerDigestV2();
    if (result.errors?.length) {
      writeJson(path.join(out, "last-grading-error.json"), {
        ...cell,
        result,
      });
      throw new Error(
        `grading failed for ${fixture.id}/${cell.treatment}: ${result.errors.map((error) => error.message).join("; ")}`,
      );
    }
    scored = writeExperimentCache({
      artifactRoot: out,
      kind: "score",
      identity: scoreId,
      payload: result,
    });
  }
  const row = {
    ...cell,
    raw_digest: raw.artifact.content_digest,
    score_digest: scored.artifact.content_digest,
    raw_reused: reused,
    score_reused: scoreReused,
    score: scored.payload,
    expected_root_ids: fixture.expected_root_ids,
    negative_control_root_ids: fixture.negative_control_root_ids,
    roots: rootsForCase(loaded.dataset, fixture.id).map(({ id, severity }) => ({
      id,
      severity,
    })),
    raw_file: raw.file,
    score_file: scored.file,
    family_id: fixture.family_id,
    variant: fixture.variant,
    reviewer_duration_ms: raw.payload.envelope.duration_ms,
    reviewer_cost_usd: raw.payload.envelope.total_cost_usd,
    leak,
  };
  if (scored.payload.errors?.length)
    throw new Error(`grading failed for ${fixture.id}/${cell.treatment}`);
  return row;
}

export function finishCampaign({
  plan,
  rows,
  failure,
  spend,
  datasetDigest,
  out,
  started,
}) {
  let gradingSourceFailure = null;
  try {
    scorerDigestV2();
  } catch (error) {
    gradingSourceFailure = error.message;
  }
  // Do not call a stale metric reducer or leave an older successful report.
  const report = gradingSourceFailure
    ? {
        schema_version: 2,
        status: "incomplete",
        failure: gradingSourceFailure,
        plan_digest: plan.plan_digest,
        dataset_digest: datasetDigest,
        planned_cells: plan.cells.length,
        completed_cells: 0,
        metrics: null,
        rows: [],
        cost: null,
      }
    : campaignReport({
        plan,
        rows,
        failure,
        spend,
        datasetDigest,
      });
  report.elapsed_ms = Date.now() - started;
  writeJson(path.join(out, "report.json"), report);
  return report;
}

export function campaignReport({
  plan,
  rows,
  failure = null,
  spend,
  datasetDigest,
}) {
  const complete =
    !failure &&
    rows.length === plan.cells.length &&
    rows.every((row) => !row.score.errors?.length);
  const sameSkill =
    plan.skills.incumbent.skill_digest === plan.skills.candidate.skill_digest;
  return {
    schema_version: 2,
    status: complete ? "completed" : "incomplete",
    failure,
    source: "direct-review",
    qualification: sameSkill
      ? "A/A harness qualification"
      : "paired diagnostic comparison",
    inference:
      "No promotion decision; labels and grader have no independent expert calibration.",
    plan_digest: plan.plan_digest,
    dataset_digest: datasetDigest,
    provenance: plan.provenance,
    planned_cells: plan.cells.length,
    completed_cells: rows.length,
    grading_uncertainty: rows.some((row) => row.score.status !== "complete"),
    metrics: metricSummary(rows),
    cost: spend
      ? {
          actual_known_usd: spend.calls.reduce(
            (sum, call) => sum + (call.actual_usd ?? 0),
            0,
          ),
          reserved_or_spent_usd: spend.calls.reduce(
            (sum, call) => sum + call.charged_usd,
            0,
          ),
          unknown_cost_calls: spend.calls.filter(
            (call) => call.actual_usd === null,
          ).length,
          limit_usd: spend.limit_usd,
          note: "API-equivalent usage estimates, not account charges. Subscription runs have no dollar stop; missing usage remains unknown.",
        }
      : null,
    rows,
  };
}
