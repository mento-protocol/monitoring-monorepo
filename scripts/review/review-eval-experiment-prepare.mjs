// Fixture preparation and judge calibration before paid experiment arms.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  canonicalPath,
  fixtureForPr,
  forbiddenShasForFixture,
  materializeFixture,
} from "./review-eval-fixtures.mjs";
import { scrubbedEnv } from "./review-eval-run-execution.mjs";
import {
  runCalibration,
  validateCalibrationSet,
} from "./review-eval-score.mjs";
import {
  experimentArtifactFile,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";
import {
  CALIBRATION_MAX_AGE_MS,
  digestObject,
} from "./review-eval-experiment-contract.mjs";
import {
  calibrationReuseDecision,
  resolveExperimentArtifactPath,
} from "./review-eval-experiment-evidence.mjs";
import {
  createBoundedClaudeExec,
  EXPERIMENT_CALL_TIMEOUT_MS,
} from "./review-eval-experiment-process.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function timestampMs(value, label) {
  const numeric = value instanceof Date ? value.getTime() : Number(value);
  const millis = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return millis;
}

export function assertExperimentCalibrationCovers({
  artifact,
  requiredValidUntil,
}) {
  const completedAt = timestampMs(
    artifact?.completed_at,
    "calibration completion",
  );
  const requiredUntil = timestampMs(
    requiredValidUntil,
    "calibration required-valid-until",
  );
  const expiresAt = completedAt + CALIBRATION_MAX_AGE_MS;
  if (expiresAt < requiredUntil) {
    throw new Error("calibration receipt expires before the stage deadline");
  }
  return expiresAt;
}

function sealedFixture({
  contract,
  pr,
  repoRoot,
  fixtureCacheDir,
  sourceSeal,
  deadlineMs,
  now,
}) {
  const fixtureScript = readFileSync(sourceSeal.fixture_script);
  if (sha256(fixtureScript) !== sourceSeal.manifest.fixture_script_digest) {
    throw new Error("sealed fixture script changed before execution");
  }
  const remaining = deadlineMs - now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error("experiment stage expired during fixture preparation");
  }
  const fixtureContract = fixtureForPr(contract, pr);
  const truth = sourceSeal.truth_by_pr[String(pr)];
  return materializeFixture({
    contract,
    pr,
    cacheDir: fixtureCacheDir,
    srcRepo: repoRoot,
    repoRoot,
    forbidden: forbiddenShasForFixture({ fixture: fixtureContract, truth }),
    exec: ({ args, cwd }) => {
      const result = spawnSync("bash", [sourceSeal.fixture_script, ...args], {
        cwd,
        encoding: "utf8",
        timeout: Math.max(1, Math.floor(remaining)),
      });
      return {
        status: result.status === null ? 1 : result.status,
        stdout: result.stdout || "",
        stderr:
          result.stderr ||
          (result.error ? `FATAL: ${result.error.message}` : ""),
      };
    },
  });
}

/** Materialize every mutable fixture before calibration or another paid call. */
export function prepareExperimentFixtures({
  plan,
  candidateId,
  stage,
  contract,
  repoRoot,
  fixtureCacheDir,
  sourceSeal,
  deadlineMs = Number.POSITIVE_INFINITY,
  now = Date.now,
}) {
  if (sourceSeal?.manifest?.plan_digest !== plan.plan_digest) {
    throw new Error("the experiment runtime source seal is missing or stale");
  }
  const stagePlan = plan.candidate_plans.find(
    (entry) => entry.candidate_id === candidateId,
  )?.stages?.[stage];
  if (!stagePlan?.enabled) throw new Error(`stage ${stage} is not enabled`);
  return new Map(
    stagePlan.lanes.map((lane) => [
      lane.pr,
      sealedFixture({
        contract,
        pr: lane.pr,
        repoRoot,
        fixtureCacheDir,
        sourceSeal,
        deadlineMs,
        now,
      }),
    ]),
  );
}

function readReceipt(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function receiptDigest(artifact) {
  const copy = { ...artifact };
  delete copy.receipt_digest;
  return digestObject(copy);
}

function calibrationReceiptFile({ artifactRoot, receiptFile, identity }) {
  const expectedDirectory = canonicalPath(
    resolveExperimentArtifactPath({
      artifactRoot,
      relativePath: `cache/calibration/${digestObject(identity)}`,
    }),
  );
  const target = path.isAbsolute(String(receiptFile ?? ""))
    ? canonicalPath(receiptFile)
    : canonicalPath(
        resolveExperimentArtifactPath({
          artifactRoot,
          relativePath: receiptFile,
        }),
      );
  if (!target.startsWith(`${expectedDirectory}${path.sep}`)) {
    throw new Error("calibration receipt is outside its identity cache");
  }
  return target;
}

/** Authenticate one exact frozen calibration receipt at its use time. */
export function validateExperimentCalibrationReceipt({
  plan,
  artifactRoot,
  receiptFile,
  expectedReceiptDigest,
  calibrationSet,
  checkedAt = new Date(),
}) {
  const validation = validateCalibrationSet(calibrationSet);
  if (!validation.ok) throw new Error(validation.problems.join(" | "));
  const file = calibrationReceiptFile({
    artifactRoot,
    receiptFile,
    identity: plan.calibration_identity,
  });
  const artifact = readReceipt(file);
  if (artifact.receipt_digest !== expectedReceiptDigest) {
    throw new Error(`calibration receipt digest differs for ${file}`);
  }
  if (
    artifact.schema_version !== 1 ||
    artifact.namespace !== plan.namespace ||
    digestObject(artifact.identity) !==
      digestObject(plan.calibration_identity) ||
    artifact.receipt_digest !== receiptDigest(artifact)
  ) {
    throw new Error(`calibration receipt ${file} failed its identity check`);
  }
  const expected = calibrationSet.records;
  if (
    artifact.total !== expected.length ||
    artifact.total !== plan.policy.calibration.total ||
    !Array.isArray(artifact.outcomes) ||
    artifact.outcomes.length !== expected.length
  ) {
    throw new Error(`calibration receipt ${file} has incomplete outcomes`);
  }
  let agreement = 0;
  for (const [index, frozen] of expected.entries()) {
    const outcome = artifact.outcomes[index];
    if (
      !outcome ||
      outcome.record_id !== frozen.record_id ||
      outcome.defect_id !== frozen.defect_id ||
      outcome.expected !== frozen.expected_verdict ||
      !["matched", "unmatched"].includes(outcome.actual) ||
      typeof outcome.reasoning !== "string"
    ) {
      throw new Error(
        `calibration receipt ${file} differs at frozen record ${index + 1}`,
      );
    }
    if (outcome.actual === outcome.expected) agreement += 1;
  }
  if (
    artifact.agreement !== agreement ||
    agreement < plan.policy.calibration.agreement_min
  ) {
    throw new Error(
      `judge calibration ${artifact.agreement}/${artifact.total} is below or differs from ${plan.policy.calibration.agreement_min}/${plan.policy.calibration.total}`,
    );
  }
  const reuse = calibrationReuseDecision({
    artifact,
    expectedIdentity: plan.calibration_identity,
    now: checkedAt,
  });
  if (!reuse.reuse) {
    throw new Error(`calibration receipt ${file} is invalid: ${reuse.reason}`);
  }
  return { artifact, file };
}

/** Run or reuse the exact judge calibration receipt for this host and CLI. */
export async function ensureExperimentCalibration({
  plan,
  artifactRoot,
  repoRoot,
  calibrationPath = null,
  calibrationBytes = null,
  clock = () => new Date(),
  exec = null,
  timeoutMs = EXPERIMENT_CALL_TIMEOUT_MS,
  signal = null,
  beforeWrite = null,
  claudeFile = plan.identities.claude_bin?.path,
}) {
  const bytes =
    calibrationBytes === null
      ? readFileSync(calibrationPath)
      : Buffer.from(calibrationBytes);
  if (sha256(bytes) !== plan.identities.calibration_digest) {
    throw new Error("calibration file does not match the campaign plan");
  }
  const calibrationSet = JSON.parse(bytes.toString("utf8"));
  const validation = validateCalibrationSet(calibrationSet);
  if (!validation.ok) throw new Error(validation.problems.join(" | "));
  const identity = plan.calibration_identity;
  const identityDigest = digestObject(identity);
  const directory = resolveExperimentArtifactPath({
    artifactRoot,
    relativePath: `cache/calibration/${identityDigest}`,
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const current = clock();
  const cachedReceipts = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      file: path.join(directory, name),
      artifact: readReceipt(path.join(directory, name)),
    }))
    .sort((left, right) =>
      String(right.artifact.completed_at).localeCompare(
        String(left.artifact.completed_at),
      ),
    );
  for (const cached of cachedReceipts) {
    const reuse = calibrationReuseDecision({
      artifact: cached.artifact,
      expectedIdentity: identity,
      now: current,
    });
    if (!reuse.reuse && reuse.reason === "calibration is older than 6 hours") {
      continue;
    }
    const checked = validateExperimentCalibrationReceipt({
      plan,
      artifactRoot,
      receiptFile: cached.file,
      expectedReceiptDigest: cached.artifact.receipt_digest,
      calibrationSet,
      checkedAt: current,
    });
    return { artifact: checked.artifact, file: checked.file, reused: true };
  }
  const env = scrubbedEnv({ roots: [repoRoot] });
  const judgeExec =
    exec ??
    createBoundedClaudeExec({ file: claudeFile, env, timeoutMs, signal });
  beforeWrite?.();
  const outcome = await runCalibration({
    calibrationSet,
    exec: judgeExec,
    model: plan.identities.judge.model,
    effort: plan.identities.judge.effort,
  });
  const receipt = {
    schema_version: 1,
    namespace: plan.namespace,
    identity,
    completed_at: clock().toISOString(),
    agreement: outcome.agreement,
    total: outcome.total,
    outcomes: outcome.outcomes,
  };
  receipt.receipt_digest = digestObject(receipt);
  if (
    receipt.agreement < plan.policy.calibration.agreement_min ||
    receipt.total !== plan.policy.calibration.total
  ) {
    throw new Error(
      `judge calibration ${receipt.agreement}/${receipt.total} is below ${plan.policy.calibration.agreement_min}/${plan.policy.calibration.total}`,
    );
  }
  const file = experimentArtifactFile(
    artifactRoot,
    `cache/calibration/${identityDigest}/receipt-${receipt.completed_at.replace(/[:.]/g, "-")}-${receipt.receipt_digest.slice(0, 12)}.json`,
  );
  writeExperimentCache(file, receipt, beforeWrite);
  validateExperimentCalibrationReceipt({
    plan,
    artifactRoot,
    receiptFile: file,
    expectedReceiptDigest: receipt.receipt_digest,
    calibrationSet,
    checkedAt: clock(),
  });
  return { artifact: receipt, file, reused: false };
}
