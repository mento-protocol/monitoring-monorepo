// Artifact paths, cache identities, and retry rules for experiment evidence.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalPath } from "./review-eval-fixtures.mjs";
import {
  CALIBRATION_MAX_AGE_MS,
  digestObject,
  EXPERIMENT_CACHE_STAGES,
  EXPERIMENT_NAMESPACE,
  EXPERIMENT_SCHEMA_VERSION,
  EXPERIMENT_STAGES,
  MAX_STAGE_ATTEMPTS,
} from "./review-eval-experiment-contract.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inside(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function assertExperimentArtifactRoot({ repoRoot, artifactRoot }) {
  if (!path.isAbsolute(String(artifactRoot ?? ""))) {
    throw new Error("experiment artifact root must be an absolute path");
  }
  const repo = canonicalPath(repoRoot);
  const artifact = canonicalPath(artifactRoot);
  if (inside(repo, artifact)) {
    throw new Error(
      `experiment artifacts must stay outside the repository: ${artifactRoot}`,
    );
  }
  return artifact;
}

/** Keep mutable fixtures away from campaign evidence in both directions. */
export function assertDisjointExperimentRoots({ artifactRoot, fixtureRoot }) {
  const artifact = canonicalPath(artifactRoot);
  const fixture = canonicalPath(fixtureRoot);
  if (inside(artifact, fixture) || inside(fixture, artifact)) {
    throw new Error("experiment artifact and fixture roots must be disjoint");
  }
  return { artifact, fixture };
}

export function resolveExperimentArtifactPath({ artifactRoot, relativePath }) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new Error(
      "experiment artifact path must be a non-empty relative path",
    );
  }
  const root = canonicalPath(artifactRoot);
  const target = canonicalPath(path.resolve(root, relativePath));
  if (!inside(root, target) || target === root) {
    throw new Error(
      `experiment artifact path escapes its root: ${relativePath}`,
    );
  }
  return target;
}

export function writeExperimentPlan({ plan, artifactRoot, repoRoot }) {
  const root = assertExperimentArtifactRoot({ repoRoot, artifactRoot });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = resolveExperimentArtifactPath({
    artifactRoot: root,
    relativePath: "plan.json",
  });
  const bytes = `${JSON.stringify(plan, null, 2)}\n`;
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") !== bytes) {
      throw new Error(`${target} already contains a different campaign plan`);
    }
    return target;
  }
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, target);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (readFileSync(target, "utf8") !== bytes) {
      throw new Error(`${target} already contains a different campaign plan`, {
        cause: error,
      });
    }
  } finally {
    unlinkSync(temporary);
  }
  return target;
}

function candidatePlan(plan, candidateId) {
  const found = plan?.candidate_plans?.find(
    (candidate) => candidate.candidate_id === candidateId,
  );
  if (!found) throw new Error(`plan has no candidate ${candidateId}`);
  return found;
}

export function stagePlanFor({ plan, candidateId, stage }) {
  if (!EXPERIMENT_STAGES.includes(stage)) {
    throw new Error(`unknown experiment stage ${stage}`);
  }
  const stagePlan = candidatePlan(plan, candidateId).stages?.[stage];
  if (!stagePlan?.enabled) {
    throw new Error(`experiment stage ${stage} is not enabled`);
  }
  return stagePlan;
}

function laneFor({ plan, candidateId, stage, pr }) {
  const lane = stagePlanFor({ plan, candidateId, stage }).lanes.find(
    (candidate) => candidate.pr === Number(pr),
  );
  if (!lane) throw new Error(`${stage} has no PR ${pr} lane`);
  return lane;
}

function requiredDigest(value, label) {
  if (!SHA256_PATTERN.test(String(value ?? ""))) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
  return String(value);
}

/** Build separate content identities for raw, match, and novelty caches. */
export function buildCacheIdentity({
  phase,
  plan,
  candidateId,
  stage,
  pr,
  treatment,
  finderArtifactDigest = null,
  rawDigest = null,
  matchDigest = null,
  claimsDigest = null,
  calibrationReceiptDigest = null,
}) {
  if (!EXPERIMENT_CACHE_STAGES.includes(phase)) {
    throw new Error(
      `cache phase must be ${EXPERIMENT_CACHE_STAGES.join(", ")}`,
    );
  }
  if (!["incumbent", "candidate"].includes(treatment)) {
    throw new Error("treatment must be incumbent or candidate");
  }
  const lane = laneFor({ plan, candidateId, stage, pr });
  const arm = lane.sequence.find((entry) => entry.treatment === treatment);
  const source = { ...lane.source };
  if (source.kind === "live-finder") {
    source.finder_artifact_digest = requiredDigest(
      finderArtifactDigest,
      "finderArtifactDigest",
    );
  }
  const common = {
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    phase,
    campaign_plan_digest: plan.plan_digest,
    comparison_id: treatment === "candidate" ? candidateId : "shared-incumbent",
    stage,
    pr: lane.pr,
    treatment,
    canonical_cell_id: arm.canonical_cell_id,
    source,
  };
  let inputs;
  if (phase === "raw") {
    inputs = {
      ...common,
      contestant: arm.execution_fingerprint,
      prompt_digest: plan.contract_digest,
    };
  } else if (phase === "match") {
    inputs = {
      ...common,
      raw_digest: requiredDigest(rawDigest, "rawDigest"),
      calibration_receipt_digest: requiredDigest(
        calibrationReceiptDigest,
        "calibrationReceiptDigest",
      ),
      matcher_digest: plan.identities.matcher_digest,
      judge: plan.identities.judge,
      truth_sha256: lane.fixture.truth_sha256,
      scorable_ids: lane.fixture.scorable_ids,
    };
  } else {
    inputs = {
      ...common,
      raw_digest: requiredDigest(rawDigest, "rawDigest"),
      match_digest: requiredDigest(matchDigest, "matchDigest"),
      claims_digest: requiredDigest(claimsDigest, "claimsDigest"),
      calibration_receipt_digest: requiredDigest(
        calibrationReceiptDigest,
        "calibrationReceiptDigest",
      ),
      matcher_digest: plan.identities.matcher_digest,
      judge: plan.identities.judge,
      fixture_head: lane.fixture.first_head,
      truth_sha256: lane.fixture.truth_sha256,
    };
  }
  return { ...inputs, digest: digestObject(inputs) };
}

export function calibrationReuseDecision({
  artifact,
  expectedIdentity,
  now = new Date(),
}) {
  if (!isObject(artifact)) {
    return { reuse: false, reason: "no calibration artifact" };
  }
  if (digestObject(artifact.identity) !== digestObject(expectedIdentity)) {
    return { reuse: false, reason: "calibration identity differs" };
  }
  const completed = Date.parse(artifact.completed_at);
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(completed) || !Number.isFinite(current)) {
    return { reuse: false, reason: "calibration timestamp is invalid" };
  }
  const age = current - completed;
  if (age < 0) return { reuse: false, reason: "calibration is future-dated" };
  if (age > CALIBRATION_MAX_AGE_MS) {
    return { reuse: false, reason: "calibration is older than 6 hours" };
  }
  if (!Array.isArray(artifact.outcomes) || artifact.outcomes.length === 0) {
    return { reuse: false, reason: "calibration outcomes are missing" };
  }
  return {
    reuse: true,
    reason: "exact calibration identity is younger than 6 hours",
  };
}

export function validateStageAttempt({ attempt, priorAttempts = [] }) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    return { ok: false, reason: "attempt must be a positive integer" };
  }
  if (attempt > MAX_STAGE_ATTEMPTS) {
    return { ok: false, reason: "a stage permits at most one retry" };
  }
  const unique = new Set(priorAttempts);
  if (unique.size !== priorAttempts.length || priorAttempts.includes(attempt)) {
    return { ok: false, reason: "stage attempt was already recorded" };
  }
  if (attempt === 2 && !priorAttempts.includes(1)) {
    return { ok: false, reason: "retry 2 requires recorded attempt 1" };
  }
  return { ok: true, reason: "stage attempt is allowed" };
}

/** A retry is for a failed or crashed attempt, never a second sample. */
export function stageRetryDecision({
  started = false,
  failed = false,
  baseDecision = null,
  novelDecision = null,
  ownerActive = false,
}) {
  if (novelDecision !== null) {
    return { retry: false, reason: "attempt 1 completed novelty scoring" };
  }
  if (baseDecision !== null) {
    const unfinishedNovelty =
      baseDecision?.novelty?.required === true &&
      baseDecision?.novelty?.deferred === true;
    if (!unfinishedNovelty) {
      return { retry: false, reason: "attempt 1 completed its decision" };
    }
  }
  if (failed) {
    return { retry: true, reason: "attempt 1 recorded a failure" };
  }
  if (!started && baseDecision === null) {
    return { retry: false, reason: "attempt 1 has no start receipt" };
  }
  if (ownerActive) {
    return { retry: false, reason: "attempt 1 still has a live owner" };
  }
  return { retry: true, reason: "attempt 1 crashed before completion" };
}

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function validLockOwner(owner) {
  return (
    isObject(owner) &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.host === "string" &&
    owner.host.length > 0 &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0
  );
}

/** Claim one campaign before any paid process can start. */
export function acquireExperimentRunLock({
  artifactRoot,
  owner,
  isPidAlive = defaultPidAlive,
  token = randomUUID(),
}) {
  const lockFile = resolveExperimentArtifactPath({
    artifactRoot,
    relativePath: "run.lock",
  });
  const claimed = { ...owner, token };
  if (!validLockOwner(claimed)) {
    throw new Error("experiment lock owner is invalid");
  }
  const bytes = `${JSON.stringify(claimed, null, 2)}\n`;
  const temporary = `${lockFile}.${token}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, lockFile);
    return { file: lockFile, owner: claimed };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  let current;
  try {
    current = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch (error) {
    throw new Error(`experiment run lock is unreadable: ${error.message}`, {
      cause: error,
    });
  }
  if (!validLockOwner(current)) {
    throw new Error("experiment run lock has an invalid owner");
  }
  if (current.host !== claimed.host || isPidAlive(current.pid)) {
    throw new Error(
      `experiment campaign is already running as pid ${current.pid} on ${current.host}`,
    );
  }
  throw new Error(
    "experiment campaign has a stale owner; automatic recovery fails closed because paid process lineage cannot be proven settled",
  );
}

/** Remove only the lock created by this process. */
export function releaseExperimentRunLock(lock) {
  if (!lock?.file || !existsSync(lock.file)) return false;
  const current = JSON.parse(readFileSync(lock.file, "utf8"));
  if (current.token !== lock.owner?.token) {
    throw new Error("experiment run lock ownership changed before release");
  }
  unlinkSync(lock.file);
  return true;
}
