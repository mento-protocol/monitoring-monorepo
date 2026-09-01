// Paid stage orchestration for the non-ledger experiment CLI.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { expandHome } from "./review-eval-run-plan.mjs";
import {
  CAMPAIGN_MAX_AGE_MS,
  experimentCampaignRemainingMs,
} from "./review-eval-experiment-contract.mjs";
import {
  assertRetryEligible,
  attemptReceiptPath,
  completedAttempts,
  latestStageRun,
  runArtifactPath,
  writeExperimentJson,
} from "./review-eval-experiment-cli-evidence.mjs";
import { loadExperimentCampaign } from "./review-eval-experiment-cli-campaign.mjs";
import {
  acquireExperimentRunLock,
  assertExperimentArtifactRoot,
  assertDisjointExperimentRoots,
  releaseExperimentRunLock,
} from "./review-eval-experiment-evidence.mjs";
import { evaluateExperimentDecision } from "./review-eval-experiment-decision.mjs";
import {
  assertExperimentStorageRoot,
  createDisposableExperimentFixture,
  DEFAULT_EXPERIMENT_FIXTURE_ROOT,
  disposeDisposableExperimentFixture,
  verifyExperimentSandbox,
} from "./review-eval-experiment-isolation.mjs";
import { runExperimentStage } from "./review-eval-experiment-run.mjs";
import {
  createExperimentArmExecutor,
  enrichRecordsWithNovelty,
  ensureExperimentCalibration,
  prepareExperimentFixtures,
} from "./review-eval-experiment-runtime.mjs";
import { sealExperimentRuntimeSources } from "./review-eval-experiment-seal.mjs";
import {
  sealRunEvidence,
  validateStageRunArtifact,
} from "./review-eval-experiment-stage-evidence.mjs";
import { assertExperimentCalibrationCovers } from "./review-eval-experiment-prepare.mjs";
import {
  drainExperimentProcesses,
  EXPERIMENT_STAGE_TIMEOUT_MS,
} from "./review-eval-experiment-process.mjs";

export function absoluteExperimentStageDeadline({ plan, startedAt }) {
  const startedMs = Date.parse(startedAt);
  const plannedMs = Date.parse(plan?.planned_at);
  if (!Number.isFinite(startedMs) || !Number.isFinite(plannedMs)) {
    throw new Error("experiment stage or campaign timestamp is invalid");
  }
  const stageDeadlineMs = startedMs + EXPERIMENT_STAGE_TIMEOUT_MS;
  const campaignDeadlineMs = plannedMs + CAMPAIGN_MAX_AGE_MS;
  return {
    deadlineMs: Math.min(stageDeadlineMs, campaignDeadlineMs),
    campaignLimited: campaignDeadlineMs <= stageDeadlineMs,
  };
}

export function calibrationBoundedStageDeadline({
  stageDeadlineMs,
  calibrationArtifact,
  now = Date.now(),
}) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(stageDeadlineMs) || !Number.isFinite(current)) {
    throw new Error("experiment stage deadline is invalid");
  }
  const calibrationDeadlineMs = assertExperimentCalibrationCovers({
    artifact: calibrationArtifact,
    requiredValidUntil: current,
  });
  const deadlineMs = Math.min(stageDeadlineMs, calibrationDeadlineMs);
  if (deadlineMs <= current) {
    throw new Error("experiment calibration has no execution time remaining");
  }
  return {
    deadlineMs,
    calibrationLimited: calibrationDeadlineMs < stageDeadlineMs,
  };
}

export function publishValidatedStageArtifact({
  file,
  artifact,
  plan,
  candidateId,
  stage,
  artifactRoot,
  calibrationSet,
  beforeWrite,
}) {
  const allowIncomplete =
    artifact.evidence_phase === "base" &&
    artifact.decision?.novelty?.required === true &&
    artifact.decision?.novelty?.deferred === true;
  const validation = {
    plan,
    candidateId,
    stage,
    artifactRoot,
    calibrationSet,
    allowIncomplete,
  };
  validateStageRunArtifact({ artifact, ...validation });
  writeExperimentJson(file, artifact, beforeWrite);
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  validateStageRunArtifact({ artifact: persisted, ...validation });
  return { artifact_file: file, ...persisted };
}

export async function runExperimentMode(options) {
  if (!options.candidateId || !options.stage) {
    throw new Error("--run requires --candidate-id and --stage");
  }
  const loaded = loadExperimentCampaign({ ...options, verifyRuntime: true });
  const { artifactRoot, plan, contract, calibrationSet, sandboxWorktreeRoots } =
    loaded;
  const priorAttempts = completedAttempts({
    artifactRoot,
    candidateId: options.candidateId,
    stage: options.stage,
  });
  if (options.attempt === 2) {
    assertRetryEligible({
      artifactRoot,
      candidateId: options.candidateId,
      stage: options.stage,
      host: plan.identities.host,
      plan,
      calibrationSet,
    });
  }
  if (options.dryRun) {
    return runExperimentStage({
      plan,
      candidateId: options.candidateId,
      stage: options.stage,
      attempt: options.attempt,
      priorAttempts,
      concurrency: options.concurrency,
      dryRun: true,
    });
  }
  if (options.stage === "holdout") {
    const screen = latestStageRun({
      artifactRoot,
      candidateId: options.candidateId,
      stage: "screen",
      plan,
      calibrationSet,
    });
    if (screen?.decision?.status !== "PROMISING") {
      throw new Error("holdout requires a PROMISING screen decision");
    }
  }
  if (options.stage === "live-paired") {
    const holdout = latestStageRun({
      artifactRoot,
      candidateId: options.candidateId,
      stage: "holdout",
      plan,
      calibrationSet,
    });
    if (holdout?.decision?.status !== "PROMISING") {
      throw new Error("live-paired requires a PROMISING holdout decision");
    }
  }
  const schedule = await runExperimentStage({
    plan,
    candidateId: options.candidateId,
    stage: options.stage,
    attempt: options.attempt,
    priorAttempts,
    concurrency: options.concurrency,
    dryRun: true,
  });
  const startedAt = new Date().toISOString();
  const receiptBase = {
    schema_version: 1,
    namespace: plan.namespace,
    campaign_id: plan.campaign_id,
    plan_digest: plan.plan_digest,
    candidate_id: options.candidateId,
    stage: options.stage,
    attempt: options.attempt,
    started_at: startedAt,
  };
  const lock = acquireExperimentRunLock({
    artifactRoot,
    owner: {
      pid: process.pid,
      host: plan.identities.host,
      candidate_id: options.candidateId,
      stage: options.stage,
      attempt: options.attempt,
      started_at: startedAt,
    },
  });
  const controller = new AbortController();
  const abortStage = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const campaignWriteGuard = () => {
    if (experimentCampaignRemainingMs({ plan }) <= 0) {
      throw new Error("experiment campaign reached its six-hour deadline");
    }
  };
  let stageDeadlineMs = null;
  const runtimeWriteGuard = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error("experiment stage stopped");
    }
    campaignWriteGuard();
    if (stageDeadlineMs !== null && Date.now() >= stageDeadlineMs) {
      throw new Error("experiment stage reached its absolute deadline");
    }
  };
  let deadline = null;
  const onSigint = () => abortStage(new Error("experiment received SIGINT"));
  const onSigterm = () => abortStage(new Error("experiment received SIGTERM"));
  const onSighup = () => abortStage(new Error("experiment received SIGHUP"));
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  let started = false;
  try {
    const absoluteDeadline = absoluteExperimentStageDeadline({
      plan,
      startedAt,
    });
    const stageBudget = absoluteDeadline.deadlineMs - Date.now();
    if (stageBudget <= 0) {
      throw new Error(
        absoluteDeadline.campaignLimited
          ? "experiment campaign has no execution time remaining"
          : "experiment stage has no execution time remaining",
      );
    }
    stageDeadlineMs = absoluteDeadline.deadlineMs;
    const deadlineReason = absoluteDeadline.campaignLimited
      ? "experiment campaign reached its six-hour deadline"
      : `experiment stage exceeded ${EXPERIMENT_STAGE_TIMEOUT_MS} ms`;
    deadline = setTimeout(
      () => abortStage(new Error(deadlineReason)),
      stageBudget,
    );
    const calibrationFile = path.resolve(
      options.repoRoot,
      options.calibrationPath,
    );
    const fixtureCacheBase = options.fixtureCacheDir
      ? path.resolve(expandHome(options.fixtureCacheDir))
      : DEFAULT_EXPERIMENT_FIXTURE_ROOT;
    assertExperimentArtifactRoot({
      repoRoot: options.repoRoot,
      artifactRoot: fixtureCacheBase,
    });
    assertExperimentStorageRoot({
      target: fixtureCacheBase,
      base: DEFAULT_EXPERIMENT_FIXTURE_ROOT,
      label: "experiment fixture cache",
      allowBase: true,
      worktreeRoots: sandboxWorktreeRoots,
    });
    assertDisjointExperimentRoots({
      artifactRoot,
      fixtureRoot: fixtureCacheBase,
    });
    const artifactNamespace = createHash("sha256")
      .update(artifactRoot)
      .digest("hex")
      .slice(0, 12);
    const fixtureCacheDir = path.join(
      fixtureCacheBase,
      "review-skill-experiments",
      `${plan.campaign_id}-${artifactNamespace}`,
      options.candidateId,
    );
    const startFile = attemptReceiptPath({
      artifactRoot,
      candidateId: options.candidateId,
      stage: options.stage,
      attempt: options.attempt,
      suffix: "start",
    });
    writeExperimentJson(
      startFile,
      sealRunEvidence({
        ...receiptBase,
        status: "started",
        owner: lock.owner,
        schedule,
      }),
      campaignWriteGuard,
    );
    started = true;
    const sourceSeal = sealExperimentRuntimeSources({
      plan,
      contract,
      artifactRoot,
      repoRoot: options.repoRoot,
      calibrationPath: calibrationFile,
      beforeWrite: runtimeWriteGuard,
    });
    runtimeWriteGuard();
    const preparedFixtures = prepareExperimentFixtures({
      plan,
      candidateId: options.candidateId,
      stage: options.stage,
      contract,
      repoRoot: options.repoRoot,
      fixtureCacheDir,
      sourceSeal,
      deadlineMs: stageDeadlineMs,
    });
    const protectedRoots = [
      plan.incumbent.skill_ref,
      ...plan.candidates.map((candidate) => candidate.skill_ref),
    ];
    const preflightLane = plan.candidate_plans.find(
      (candidate) => candidate.candidate_id === options.candidateId,
    )?.stages?.[options.stage]?.lanes?.[0];
    const preflightSeed = preparedFixtures.get(preflightLane?.pr);
    if (!preflightLane || !preflightSeed) {
      throw new Error("experiment sandbox has no prepared preflight fixture");
    }
    const preflightFixture = createDisposableExperimentFixture({
      seedFixture: preflightSeed,
      fixtureCacheDir,
      head: preflightLane.fixture.first_head,
      base: preflightLane.fixture.base_sha,
      cellId: `${options.candidateId}-${options.stage}-preflight`,
      deadlineMs: stageDeadlineMs,
    });
    try {
      verifyExperimentSandbox({
        repoRoot: options.repoRoot,
        artifactRoot,
        fixtureCacheDir,
        fixturePath: preflightFixture.path,
        worktreeRoots: sandboxWorktreeRoots,
        protectedRoots,
      });
    } finally {
      disposeDisposableExperimentFixture({
        fixturePath: preflightFixture.path,
        fixtureCacheDir,
      });
    }
    runtimeWriteGuard();
    const calibration = await ensureExperimentCalibration({
      plan,
      artifactRoot,
      repoRoot: options.repoRoot,
      calibrationBytes: sourceSeal.calibration_bytes,
      signal: controller.signal,
      beforeWrite: runtimeWriteGuard,
      claudeFile: plan.identities.claude_bin.path,
    });
    runtimeWriteGuard();
    const boundedDeadline = calibrationBoundedStageDeadline({
      stageDeadlineMs,
      calibrationArtifact: calibration.artifact,
    });
    if (boundedDeadline.calibrationLimited) {
      clearTimeout(deadline);
      stageDeadlineMs = boundedDeadline.deadlineMs;
      deadline = setTimeout(
        () =>
          abortStage(
            new Error("experiment calibration reached its six-hour deadline"),
          ),
        Math.max(1, Math.ceil(stageDeadlineMs - Date.now())),
      );
    }
    const execute = createExperimentArmExecutor({
      plan,
      contract,
      artifactRoot,
      repoRoot: options.repoRoot,
      fixtureCacheDir,
      sourceSeal,
      preparedFixtures,
      calibrationReceipt: calibration.artifact,
      signal: controller.signal,
      beforeWrite: runtimeWriteGuard,
      sandboxWorktreeRoots,
      deadlineMs: stageDeadlineMs,
    });
    const run = await runExperimentStage({
      plan,
      candidateId: options.candidateId,
      stage: options.stage,
      attempt: options.attempt,
      priorAttempts,
      execute,
      concurrency: options.concurrency,
    });
    const recordsByStage = { [options.stage]: run.records };
    if (options.stage === "holdout") {
      const screen = latestStageRun({
        artifactRoot,
        candidateId: options.candidateId,
        stage: "screen",
        plan,
        calibrationSet,
      });
      recordsByStage.screen = screen.recordsByStage?.screen ?? screen.records;
    }
    const initialDecision = evaluateExperimentDecision({
      plan,
      candidateId: options.candidateId,
      stage: options.stage,
      recordsByStage,
    });
    const common = {
      ...receiptBase,
      records: run.records,
    };
    const calibrationEvidence = () => ({
      receipt_file: path.relative(artifactRoot, calibration.file),
      receipt_digest: calibration.artifact.receipt_digest,
      agreement: calibration.artifact.agreement,
      total: calibration.artifact.total,
      reused: calibration.reused,
      checked_at: new Date().toISOString(),
    });
    const baseArtifact = sealRunEvidence({
      ...common,
      evidence_phase: "base",
      calibration: calibrationEvidence(),
      recordsByStage: structuredClone(recordsByStage),
      decision: initialDecision,
    });
    const baseFile = runArtifactPath({
      artifactRoot,
      candidateId: options.candidateId,
      stage: options.stage,
      attempt: options.attempt,
      novel: false,
    });
    const publishedBase = publishValidatedStageArtifact({
      file: baseFile,
      artifact: baseArtifact,
      plan,
      candidateId: options.candidateId,
      stage: options.stage,
      artifactRoot,
      calibrationSet,
      beforeWrite: runtimeWriteGuard,
    });
    if (
      !initialDecision.novelty.required ||
      !initialDecision.novelty.deferred
    ) {
      return publishedBase;
    }
    const enriched = await enrichRecordsWithNovelty({
      plan,
      candidateId: options.candidateId,
      records: Object.values(recordsByStage).flat(),
      artifactRoot,
      repoRoot: options.repoRoot,
      fixtureCacheDir,
      sourceSeal,
      preparedFixtures,
      calibrationReceipt: calibration.artifact,
      concurrency: options.concurrency,
      signal: controller.signal,
      beforeWrite: runtimeWriteGuard,
      sandboxWorktreeRoots,
      deadlineMs: stageDeadlineMs,
    });
    for (const stageName of Object.keys(recordsByStage)) {
      recordsByStage[stageName] = enriched.filter(
        (record) => record.stage === stageName,
      );
    }
    const decision = evaluateExperimentDecision({
      plan,
      candidateId: options.candidateId,
      stage: options.stage,
      recordsByStage,
    });
    const artifact = sealRunEvidence({
      ...common,
      evidence_phase: "novel",
      calibration: calibrationEvidence(),
      records: recordsByStage[options.stage],
      recordsByStage,
      decision,
    });
    const file = runArtifactPath({
      artifactRoot,
      candidateId: options.candidateId,
      stage: options.stage,
      attempt: options.attempt,
      novel: true,
    });
    return publishValidatedStageArtifact({
      file,
      artifact,
      plan,
      candidateId: options.candidateId,
      stage: options.stage,
      artifactRoot,
      calibrationSet,
      beforeWrite: runtimeWriteGuard,
    });
  } catch (error) {
    abortStage(error);
    await drainExperimentProcesses();
    if (started) {
      const failureFile = attemptReceiptPath({
        artifactRoot,
        candidateId: options.candidateId,
        stage: options.stage,
        attempt: options.attempt,
        suffix: "failed",
      });
      if (!existsSync(failureFile)) {
        writeExperimentJson(
          failureFile,
          sealRunEvidence({
            ...receiptBase,
            status: "failed",
            completed_at: new Date().toISOString(),
            reason: error.message,
            owner: lock.owner,
          }),
        );
      }
    }
    throw error;
  } finally {
    if (deadline !== null) clearTimeout(deadline);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
    await drainExperimentProcesses();
    releaseExperimentRunLock(lock);
  }
}
