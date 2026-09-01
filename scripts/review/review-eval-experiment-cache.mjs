// Atomic cache storage and persisted record lineage checks.

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
import process from "node:process";

import { canonicalPath } from "./review-eval-fixtures.mjs";
import { digestObject } from "./review-eval-experiment-contract.mjs";
import {
  buildCacheIdentity,
  resolveExperimentArtifactPath,
} from "./review-eval-experiment-evidence.mjs";

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function experimentArtifactFile(artifactRoot, relativePath) {
  const file = resolveExperimentArtifactPath({ artifactRoot, relativePath });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return file;
}

function writeBytesOnce(file, bytes, mode = 0o600, beforeWrite = null) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (existsSync(file)) {
    const existing = readFileSync(file);
    if (!existing.equals(value)) {
      throw new Error(`cache artifact ${file} already has different content`);
    }
    return;
  }
  beforeWrite?.();
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { flag: "wx", mode });
  try {
    beforeWrite?.();
    linkSync(temporary, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!readFileSync(file).equals(value)) {
      throw new Error(`cache artifact ${file} already has different content`, {
        cause: error,
      });
    }
  } finally {
    unlinkSync(temporary);
  }
}

export function writeExperimentCache(file, value, beforeWrite = null) {
  writeBytesOnce(
    file,
    `${JSON.stringify(value, null, 2)}\n`,
    0o600,
    beforeWrite,
  );
}

function selfDigest(artifact, field) {
  const copy = { ...artifact };
  delete copy[field];
  return digestObject(copy);
}

function validateCacheSemantics(artifact, digestField, file) {
  if (
    digestField === "raw_digest" &&
    (artifact.schema_version !== 1 ||
      artifact.namespace !== artifact.identity?.namespace ||
      artifact.identity?.phase !== "raw" ||
      artifact.ok !== true ||
      typeof artifact.campaign_id !== "string" ||
      artifact.comparison_id !== artifact.identity?.comparison_id ||
      artifact.stage !== artifact.identity?.stage ||
      artifact.pr !== artifact.identity?.pr ||
      artifact.treatment !== artifact.identity?.treatment ||
      artifact.cell_id !== artifact.identity?.canonical_cell_id ||
      JSON.stringify(artifact.fingerprint) !==
        JSON.stringify(artifact.identity?.contestant) ||
      typeof artifact.output !== "string" ||
      artifact.output.trim().length === 0)
  ) {
    throw new Error(`cache artifact ${file} has no raw review output`);
  }
  if (digestField === "match_digest") {
    const leak = artifact.leak;
    if (
      artifact.schema_version !== 1 ||
      artifact.namespace !== artifact.identity?.namespace ||
      artifact.identity?.phase !== "match" ||
      artifact.raw_digest !== artifact.identity?.raw_digest ||
      !Array.isArray(artifact.claims) ||
      artifact.claims.some(
        (claim) => typeof claim !== "string" || claim.trim().length === 0,
      ) ||
      artifact.claims_digest !== digestObject(artifact.claims) ||
      !Array.isArray(artifact.matched_ids) ||
      artifact.matched_ids.some((id) => !Number.isSafeInteger(id)) ||
      !leak ||
      typeof leak.suspected !== "boolean" ||
      !Array.isArray(leak.hard) ||
      !Array.isArray(leak.advisory)
    ) {
      throw new Error(`cache artifact ${file} has mismatched claim evidence`);
    }
  }
  if (
    digestField === "novel_digest" &&
    (artifact.schema_version !== 1 ||
      artifact.namespace !== artifact.identity?.namespace ||
      artifact.identity?.phase !== "novel" ||
      !Number.isSafeInteger(artifact.verdict?.novelWrong) ||
      artifact.verdict.novelWrong < 0 ||
      !Number.isSafeInteger(artifact.verdict?.novelReal) ||
      artifact.verdict.novelReal < 0)
  ) {
    throw new Error(`cache artifact ${file} has malformed novel evidence`);
  }
}

export function readExperimentIdentityCache(file, identity, digestField) {
  if (!existsSync(file)) return null;
  const artifact = readJson(file);
  if (JSON.stringify(artifact.identity) !== JSON.stringify(identity)) {
    throw new Error(`cache artifact ${file} has a mismatched identity`);
  }
  if (
    typeof artifact[digestField] !== "string" ||
    artifact[digestField] !== selfDigest(artifact, digestField)
  ) {
    throw new Error(`cache artifact ${file} has a mismatched ${digestField}`);
  }
  validateCacheSemantics(artifact, digestField, file);
  return artifact;
}

function readRecordedCache({
  artifactRoot,
  file,
  digestField,
  expectedDigest,
}) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`record has no ${digestField} cache artifact`);
  }
  const root = canonicalPath(artifactRoot);
  const target = canonicalPath(file);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`cache artifact ${file} is outside the campaign root`);
  }
  const artifact = readJson(target);
  if (
    artifact[digestField] !== expectedDigest ||
    artifact[digestField] !== selfDigest(artifact, digestField)
  ) {
    throw new Error(`cache artifact ${file} has a mismatched ${digestField}`);
  }
  validateCacheSemantics(artifact, digestField, file);
  return artifact;
}

export function experimentRecordCacheLineage({
  plan,
  candidateId,
  record,
  artifactRoot,
  calibrationReceiptDigest,
}) {
  const candidatePlan = plan.candidate_plans.find(
    (entry) => entry.candidate_id === candidateId,
  );
  const lane = candidatePlan?.stages?.[record.stage]?.lanes.find(
    (entry) => entry.pr === record.pr,
  );
  const arm = lane?.sequence.find(
    (entry) => entry.treatment === record.treatment,
  );
  if (
    !lane ||
    !arm ||
    record.campaign_id !== plan.campaign_id ||
    record.candidate_id !== candidateId ||
    record.cell_id !== arm.canonical_cell_id
  ) {
    throw new Error(
      `record is outside the planned cache lineage for PR ${record.pr}`,
    );
  }
  const raw = readRecordedCache({
    artifactRoot,
    file: record.artifacts?.raw,
    digestField: "raw_digest",
    expectedDigest: record.raw_digest,
  });
  const matched = readRecordedCache({
    artifactRoot,
    file: record.artifacts?.match,
    digestField: "match_digest",
    expectedDigest: record.match_digest,
  });
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (
    record.ok !== true ||
    raw.ok !== true ||
    raw.namespace !== plan.namespace ||
    raw.campaign_id !== plan.campaign_id ||
    raw.comparison_id !==
      (record.treatment === "candidate" ? candidateId : "shared-incumbent") ||
    raw.stage !== record.stage ||
    raw.cell_id !== arm.canonical_cell_id ||
    raw.pr !== record.pr ||
    raw.treatment !== record.treatment ||
    matched.raw_digest !== record.raw_digest ||
    matched.claims_digest !== record.claims_digest ||
    record.output !== raw.output ||
    record.claims_count !== matched.claims.length ||
    record.empty !== (matched.claims.length === 0) ||
    !same(record.matched_ids, matched.matched_ids) ||
    !same(record.leak, matched.leak) ||
    !same(record.fingerprint, raw.fingerprint) ||
    !same(raw.fingerprint, arm.execution_fingerprint)
  ) {
    throw new Error(
      `recorded cache evidence differs for PR ${record.pr} ${record.treatment}`,
    );
  }
  const rawIdentity = buildCacheIdentity({
    phase: "raw",
    plan,
    candidateId,
    stage: record.stage,
    pr: record.pr,
    treatment: record.treatment,
    finderArtifactDigest:
      lane.source.kind === "live-finder"
        ? raw.identity?.source?.finder_artifact_digest
        : null,
  });
  if (JSON.stringify(raw.identity) !== JSON.stringify(rawIdentity)) {
    throw new Error(`raw cache identity differs for PR ${record.pr}`);
  }
  const matchIdentity = buildCacheIdentity({
    phase: "match",
    plan,
    candidateId,
    stage: record.stage,
    pr: record.pr,
    treatment: record.treatment,
    finderArtifactDigest:
      lane.source.kind === "live-finder"
        ? raw.identity.source.finder_artifact_digest
        : null,
    rawDigest: record.raw_digest,
    calibrationReceiptDigest,
  });
  if (JSON.stringify(matched.identity) !== JSON.stringify(matchIdentity)) {
    throw new Error(`match cache identity differs for PR ${record.pr}`);
  }
  const hasWrong = Object.hasOwn(record, "wrong_claims");
  const hasReal = Object.hasOwn(record, "novel_real");
  const hasNovelDigest = Object.hasOwn(record, "novel_digest");
  const hasNovelArtifact = typeof record.artifacts?.novel === "string";
  if (
    hasWrong !== hasReal ||
    hasWrong !== hasNovelDigest ||
    hasWrong !== hasNovelArtifact
  ) {
    throw new Error(`record has incomplete novel evidence for PR ${record.pr}`);
  }
  let novel = null;
  if (hasWrong) {
    novel = readRecordedCache({
      artifactRoot,
      file: record.artifacts.novel,
      digestField: "novel_digest",
      expectedDigest: record.novel_digest,
    });
    const novelIdentity = buildCacheIdentity({
      phase: "novel",
      plan,
      candidateId,
      stage: record.stage,
      pr: record.pr,
      treatment: record.treatment,
      finderArtifactDigest:
        lane.source.kind === "live-finder"
          ? raw.identity.source.finder_artifact_digest
          : null,
      rawDigest: record.raw_digest,
      matchDigest: record.match_digest,
      claimsDigest: record.claims_digest,
      calibrationReceiptDigest,
    });
    if (
      !same(novel.identity, novelIdentity) ||
      record.wrong_claims !== novel.verdict.novelWrong ||
      record.novel_real !== novel.verdict.novelReal
    ) {
      throw new Error(`novel evidence differs for PR ${record.pr}`);
    }
  }
  return { lane, arm, raw, matched, novel };
}

/** Re-authenticate every cache artifact before a later paid stage can start. */
export function validateExperimentRecordCaches({
  plan,
  candidateId,
  records,
  artifactRoot,
  calibrationReceiptDigest,
}) {
  for (const record of records ?? []) {
    experimentRecordCacheLineage({
      plan,
      candidateId,
      record,
      artifactRoot,
      calibrationReceiptDigest,
    });
  }
  return true;
}
