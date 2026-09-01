// Self-authenticating stage receipts for the non-ledger experiment lane.

import { digestObject } from "./review-eval-experiment-contract.mjs";
import { evaluateExperimentDecision } from "./review-eval-experiment-decision.mjs";
import { validateExperimentRecordCaches } from "./review-eval-experiment-runtime.mjs";
import { validateExperimentCalibrationReceipt } from "./review-eval-experiment-prepare.mjs";

export function sealRunEvidence(value) {
  return { ...value, artifact_digest: digestObject(value) };
}

export function assertRunEvidenceDigest(artifact, label) {
  const copy = { ...artifact };
  delete copy.artifact_digest;
  if (
    typeof artifact?.artifact_digest !== "string" ||
    artifact.artifact_digest !== digestObject(copy)
  ) {
    throw new Error(`${label} failed its artifact digest check`);
  }
  return artifact;
}

/** Recompute a persisted stage decision and authenticate its cache lineage. */
export function validateStageRunArtifact({
  artifact,
  plan,
  candidateId,
  stage,
  artifactRoot,
  calibrationSet,
  allowIncomplete = false,
}) {
  assertRunEvidenceDigest(artifact, `${candidateId} ${stage} run`);
  if (
    artifact.namespace !== plan.namespace ||
    artifact.campaign_id !== plan.campaign_id ||
    artifact.plan_digest !== plan.plan_digest ||
    artifact.candidate_id !== candidateId ||
    artifact.stage !== stage ||
    !Number.isSafeInteger(artifact.attempt) ||
    !["base", "novel"].includes(artifact.evidence_phase)
  ) {
    throw new Error(`${candidateId} ${stage} run has mismatched provenance`);
  }
  const recordsByStage = artifact.recordsByStage;
  const expectedStages = stage === "holdout" ? ["screen", "holdout"] : [stage];
  if (
    !recordsByStage ||
    JSON.stringify(Object.keys(recordsByStage).sort()) !==
      JSON.stringify([...expectedStages].sort()) ||
    !Array.isArray(recordsByStage[stage])
  ) {
    throw new Error(`${candidateId} ${stage} run has mismatched records`);
  }
  for (const [stageName, stageRecords] of Object.entries(recordsByStage)) {
    if (
      !Array.isArray(stageRecords) ||
      stageRecords.some(
        (record) =>
          record.stage !== stageName ||
          (stageName === stage && record.attempt !== artifact.attempt),
      )
    ) {
      throw new Error(
        `${candidateId} ${stage} recordsByStage key differs from record.stage or attempt in ${stageName}`,
      );
    }
  }
  if (
    JSON.stringify(artifact.records) !== JSON.stringify(recordsByStage[stage])
  ) {
    throw new Error(`${candidateId} ${stage} run has mismatched records`);
  }
  const calibration = validateExperimentCalibrationReceipt({
    plan,
    artifactRoot,
    receiptFile: artifact.calibration?.receipt_file,
    expectedReceiptDigest: artifact.calibration?.receipt_digest,
    calibrationSet,
    checkedAt: artifact.calibration?.checked_at,
  });
  if (
    artifact.calibration.agreement !== calibration.artifact.agreement ||
    artifact.calibration.total !== calibration.artifact.total ||
    typeof artifact.calibration.reused !== "boolean"
  ) {
    throw new Error(`${candidateId} ${stage} run has mismatched calibration`);
  }
  const records = Object.values(recordsByStage).flat();
  validateExperimentRecordCaches({
    plan,
    candidateId,
    records,
    artifactRoot,
    calibrationReceiptDigest: calibration.artifact.receipt_digest,
  });
  const recomputed = evaluateExperimentDecision({
    plan,
    candidateId,
    stage,
    recordsByStage,
  });
  if (digestObject(recomputed) !== digestObject(artifact.decision)) {
    throw new Error(`${candidateId} ${stage} decision does not recompute`);
  }
  const incomplete =
    recomputed.novelty.required === true &&
    recomputed.novelty.deferred === true;
  if (incomplete && !allowIncomplete) {
    throw new Error(`${candidateId} ${stage} run has incomplete novelty`);
  }
  if (artifact.evidence_phase === "novel" && incomplete) {
    throw new Error(`${candidateId} ${stage} novel run is incomplete`);
  }
  return artifact;
}
