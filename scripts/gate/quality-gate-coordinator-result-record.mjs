import { createHash } from "node:crypto";

import {
  array,
  boundedJson,
  identifier,
  oneOf,
  record,
  reject,
  sha256,
  text,
  utcTimestamp,
} from "./quality-gate-coordinator-journal-fields.mjs";

export function validatePersistedResult(
  result,
  {
    recordSchemaVersion,
    protocol,
    policyHash,
    fingerprint,
    fingerprintHash,
    executionId,
  },
) {
  record(result, "result");
  if (result.schemaVersion !== recordSchemaVersion) {
    reject("result.schemaVersion", "does not match the record schema");
  }
  record(result.protocol, "result.protocol");
  if (
    result.protocol.major !== protocol.major ||
    result.protocol.minor !== protocol.minor
  ) {
    reject("result.protocol", "does not match the coordinator protocol");
  }
  sha256(result.policyHash, "result.policyHash");
  if (result.policyHash !== policyHash) {
    reject("result.policyHash", "does not match the coordinator policy");
  }
  text(result.fingerprint, "result.fingerprint", 64 * 1024);
  if (result.fingerprint !== fingerprint) {
    reject("result.fingerprint", "does not match its result path");
  }
  sha256(result.fingerprintHash, "result.fingerprintHash");
  const computedHash = createHash("sha256")
    .update(result.fingerprint)
    .digest("hex");
  if (result.fingerprintHash !== computedHash) {
    reject("result.fingerprintHash", "does not match fingerprint");
  }
  if (
    fingerprintHash !== undefined &&
    result.fingerprintHash !== fingerprintHash
  ) {
    reject("result.fingerprintHash", "does not match its result directory");
  }
  identifier(result.executionId, "result.executionId");
  if (result.executionId !== executionId) {
    reject("result.executionId", "does not match its result path");
  }
  identifier(result.leaderRequestId, "result.leaderRequestId");
  if (result.leaderRequestId !== result.executionId) {
    reject(
      "result.leaderRequestId",
      "must match the leader execution identifier",
    );
  }
  const followers = array(
    result.followerRequestIds,
    "result.followerRequestIds",
  );
  const seenFollowers = new Set();
  followers.forEach((requestId, index) => {
    identifier(requestId, `result.followerRequestIds[${index}]`);
    if (seenFollowers.has(requestId)) {
      reject(
        `result.followerRequestIds[${index}]`,
        "duplicates a follower request",
      );
    }
    if (requestId === result.leaderRequestId) {
      reject(
        `result.followerRequestIds[${index}]`,
        "duplicates the leader request",
      );
    }
    seenFollowers.add(requestId);
  });
  oneOf(result.status, ["success", "failure", "cancelled"], "result.status");
  boundedJson(result.payload, "result.payload");
  utcTimestamp(result.completedAt, "result.completedAt");
}
