// CLI receipt lookup, retry checks, and atomic JSON publication.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  resolveExperimentArtifactPath,
  stageRetryDecision,
} from "./review-eval-experiment-evidence.mjs";
import {
  assertRunEvidenceDigest,
  validateStageRunArtifact,
} from "./review-eval-experiment-stage-evidence.mjs";

export function completedAttempts({ artifactRoot, candidateId, stage }) {
  const directory = resolveExperimentArtifactPath({
    artifactRoot,
    relativePath: `runs/${candidateId}/${stage}`,
  });
  if (!existsSync(directory)) return [];
  return [
    ...new Set(
      readdirSync(directory)
        .map((name) =>
          /^attempt-(\d+)(?:-(?:start|failed|novel))?\.json$/.exec(name),
        )
        .filter(Boolean)
        .map((match) => Number(match[1])),
    ),
  ].sort((left, right) => left - right);
}

export function runArtifactPath({
  artifactRoot,
  candidateId,
  stage,
  attempt,
  novel,
}) {
  return resolveExperimentArtifactPath({
    artifactRoot,
    relativePath: `runs/${candidateId}/${stage}/attempt-${attempt}${novel ? "-novel" : ""}.json`,
  });
}

export function latestStageRun({
  artifactRoot,
  candidateId,
  stage,
  plan,
  calibrationSet,
}) {
  const attempts = completedAttempts({ artifactRoot, candidateId, stage });
  for (const attempt of attempts.reverse()) {
    for (const novel of [true, false]) {
      const file = runArtifactPath({
        artifactRoot,
        candidateId,
        stage,
        attempt,
        novel,
      });
      if (existsSync(file)) {
        return validateStageRunArtifact({
          artifact: JSON.parse(readFileSync(file, "utf8")),
          plan,
          candidateId,
          stage,
          artifactRoot,
          calibrationSet,
        });
      }
    }
  }
  return null;
}

export function attemptReceiptPath({
  artifactRoot,
  candidateId,
  stage,
  attempt,
  suffix,
}) {
  return resolveExperimentArtifactPath({
    artifactRoot,
    relativePath: `runs/${candidateId}/${stage}/attempt-${attempt}${suffix ? `-${suffix}` : ""}.json`,
  });
}

function optionalJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function receiptOwnerActive(receipt, currentHost) {
  const owner = receipt?.owner;
  if (!owner || owner.host !== currentHost) return Boolean(owner);
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function assertAttemptReceipt({
  receipt,
  label,
  status,
  plan,
  candidateId,
  stage,
}) {
  assertRunEvidenceDigest(receipt, label);
  if (
    receipt.schema_version !== 1 ||
    receipt.namespace !== plan.namespace ||
    receipt.campaign_id !== plan.campaign_id ||
    receipt.plan_digest !== plan.plan_digest ||
    receipt.candidate_id !== candidateId ||
    receipt.stage !== stage ||
    receipt.attempt !== 1 ||
    receipt.status !== status
  ) {
    throw new Error(`${label} has mismatched provenance`);
  }
  const owner = receipt.owner;
  if (
    !owner ||
    typeof owner.token !== "string" ||
    owner.token.length === 0 ||
    typeof owner.host !== "string" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    owner.candidate_id !== candidateId ||
    owner.stage !== stage ||
    owner.attempt !== 1
  ) {
    throw new Error(`${label} has a mismatched owner`);
  }
  const timestamp =
    status === "started" ? receipt.started_at : receipt.completed_at;
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} has an invalid timestamp`);
  }
  if (status === "failed" && typeof receipt.reason !== "string") {
    throw new Error(`${label} has no failure reason`);
  }
  return receipt;
}

export function assertRetryEligible({
  artifactRoot,
  candidateId,
  stage,
  host,
  plan,
  calibrationSet,
}) {
  const start = optionalJson(
    attemptReceiptPath({
      artifactRoot,
      candidateId,
      stage,
      attempt: 1,
      suffix: "start",
    }),
  );
  const failed = optionalJson(
    attemptReceiptPath({
      artifactRoot,
      candidateId,
      stage,
      attempt: 1,
      suffix: "failed",
    }),
  );
  const base = optionalJson(
    runArtifactPath({
      artifactRoot,
      candidateId,
      stage,
      attempt: 1,
      novel: false,
    }),
  );
  const novel = optionalJson(
    runArtifactPath({
      artifactRoot,
      candidateId,
      stage,
      attempt: 1,
      novel: true,
    }),
  );
  if (start) {
    assertAttemptReceipt({
      receipt: start,
      label: `${candidateId} ${stage} start`,
      status: "started",
      plan,
      candidateId,
      stage,
    });
  }
  if (failed) {
    assertAttemptReceipt({
      receipt: failed,
      label: `${candidateId} ${stage} failure`,
      status: "failed",
      plan,
      candidateId,
      stage,
    });
    if (
      !start ||
      JSON.stringify(failed.owner) !== JSON.stringify(start.owner)
    ) {
      throw new Error(
        `${candidateId} ${stage} failure owner differs from start`,
      );
    }
  }
  if (base) {
    validateStageRunArtifact({
      artifact: base,
      plan,
      candidateId,
      stage,
      artifactRoot,
      calibrationSet,
      allowIncomplete: true,
    });
  }
  if (novel) {
    validateStageRunArtifact({
      artifact: novel,
      plan,
      candidateId,
      stage,
      artifactRoot,
      calibrationSet,
    });
  }
  const decision = stageRetryDecision({
    started: start !== null,
    failed: failed !== null,
    baseDecision: base?.decision ?? null,
    novelDecision: novel?.decision ?? null,
    ownerActive: receiptOwnerActive(start, host),
  });
  if (!decision.retry) {
    throw new Error(`attempt 2 is not allowed: ${decision.reason}`);
  }
}

export function writeExperimentJson(file, value, beforeWrite = null) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  beforeWrite?.();
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    beforeWrite?.();
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}
