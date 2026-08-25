import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { JournalValidationError } from "./quality-gate-coordinator-journal-fields.mjs";
import { validatePersistedResult } from "./quality-gate-coordinator-result-record.mjs";

import {
  CoordinatorError,
  PROTOCOL_VERSION,
  RECORD_SCHEMA_VERSION,
  copy,
  isImmutableWriteStagingName,
  readExecutionResult,
  registrationFor,
  terminalStatus,
  utc,
  writeImmutable,
} from "./quality-gate-coordinator-state.mjs";

const fingerprintHashPattern = /^[a-f0-9]{64}$/u;
function resultKey(fingerprintHash, executionId) {
  return `${fingerprintHash}\0${executionId}`;
}

function parseRetainedResult(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw invalidResult("result", `must be valid JSON (${path})`);
  }
}

function validateRetainedResult(
  result,
  { path, fingerprintHash, executionId, policyHash },
) {
  try {
    validatePersistedResult(result, {
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      protocol: PROTOCOL_VERSION,
      policyHash,
      fingerprint: result?.fingerprint,
      fingerprintHash,
      executionId,
    });
  } catch (error) {
    if (!(error instanceof JournalValidationError)) throw error;
    throw invalidResult(error.path, `${error.reason} (${path})`);
  }
}

export function validateRetainedResults({
  resultsDirectory,
  successIndex,
  policyHash,
}) {
  const retained = new Map();
  const resultDirectories = new Set();
  for (const directory of readdirSync(resultsDirectory, {
    withFileTypes: true,
  })) {
    if (
      !directory.isDirectory() ||
      !fingerprintHashPattern.test(directory.name)
    ) {
      throw invalidResult(
        "result.path",
        `unexpected entry in the results directory: ${directory.name}`,
      );
    }
    const directoryPath = join(resultsDirectory, directory.name);
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.isFile() && isImmutableWriteStagingName(entry.name)) continue;
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw invalidResult(
          "result.path",
          `unexpected entry in retained result directory: ${join(directoryPath, entry.name)}`,
        );
      }
      const executionId = entry.name.slice(0, -5);
      const path = join(directoryPath, entry.name);
      const result = parseRetainedResult(path);
      validateRetainedResult(result, {
        path,
        fingerprintHash: directory.name,
        executionId,
        policyHash,
      });
      retained.set(resultKey(directory.name, executionId), result);
      resultDirectories.add(directoryPath);
    }
  }

  for (const [hash, indexed] of Object.entries(successIndex)) {
    const path = `successIndex.${hash}`;
    const result = retained.get(resultKey(hash, indexed.executionId));
    if (!result) {
      throw invalidResult(path, "does not have its retained terminal result");
    }
    if (result.status !== "success") {
      throw invalidResult(path, "references a non-success terminal result");
    }
    if (!allowsRetainedSuccessReuse(result)) {
      throw invalidResult(
        path,
        "references a success terminal result that forbids retained reuse",
      );
    }
    if (result.completedAt !== indexed.completedAt) {
      throw invalidResult(
        `${path}.completedAt`,
        "does not match the retained terminal result",
      );
    }
  }
  return { retained, resultDirectories: [...resultDirectories].sort() };
}

function sameOrderedValues(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function equivalentResult(left, right) {
  return (
    left?.schemaVersion === right.schemaVersion &&
    isDeepStrictEqual(left.protocol, right.protocol) &&
    left.policyHash === right.policyHash &&
    left.fingerprint === right.fingerprint &&
    left.fingerprintHash === right.fingerprintHash &&
    left.executionId === right.executionId &&
    left.leaderRequestId === right.leaderRequestId &&
    sameOrderedValues(left.followerRequestIds, right.followerRequestIds) &&
    left.status === right.status &&
    isDeepStrictEqual(left.payload, right.payload) &&
    typeof left.completedAt === "string" &&
    Number.isFinite(Date.parse(left.completedAt))
  );
}

// A qualified success still terminates the active singleflight for its leader
// and followers. It must not become a retained --skip-if-fresh verdict: the
// caller omitted at least one required arm and needs a later execution to retry
// it. Keep the opt-out in the immutable payload so restart recovery applies the
// same rule as live publication.
function allowsRetainedSuccessReuse(result) {
  return result?.status === "success" && result.payload?.reusable !== false;
}

export function reusableSuccess({
  state,
  resultsDirectory,
  fingerprint,
  fingerprintHash,
  policyHash,
  maximumAgeMs,
  now,
}) {
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "successMaxAgeMs must be a non-negative integer",
    );
  }
  if (!maximumAgeMs) return null;
  const indexed = state.successIndex[fingerprintHash];
  const completedAt = Date.parse(indexed?.completedAt);
  const age = now() - completedAt;
  if (
    !indexed ||
    !Number.isFinite(completedAt) ||
    age < 0 ||
    age > maximumAgeMs
  ) {
    return null;
  }
  const result = readExecutionResult(
    resultsDirectory,
    fingerprint,
    indexed.executionId,
    policyHash,
  );
  return allowsRetainedSuccessReuse(result) &&
    result.executionId === indexed.executionId &&
    result.completedAt === indexed.completedAt
    ? result
    : null;
}

export function publishExecutionResult({
  state,
  resultPath,
  request,
  singleflight,
  policyHash,
  status,
  payload,
  now,
  resultWriter = writeImmutable,
}) {
  const result = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    protocol: { ...PROTOCOL_VERSION },
    policyHash,
    fingerprint: request.fingerprint,
    fingerprintHash: request.fingerprintHash,
    executionId: request.executionId,
    leaderRequestId: request.requestId,
    followerRequestIds: copy(singleflight.followers),
    status: terminalStatus(status),
    payload: copy(payload),
    completedAt: utc(now),
  };
  const persistedResult = resultWriter(resultPath, result, equivalentResult);
  validatePersistedResult(persistedResult, {
    recordSchemaVersion: RECORD_SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    policyHash,
    fingerprint: request.fingerprint,
    fingerprintHash: request.fingerprintHash,
    executionId: request.executionId,
  });
  assertResultMatchesSingleflight(persistedResult, singleflight);
  finishExecutionState(state, singleflight, persistedResult);
  return persistedResult;
}

export function finishExecutionState(state, singleflight, result) {
  const ids = [singleflight.leaderRequestId, ...singleflight.followers];
  const completedIds = new Set(ids);
  let nextRequestId = null;
  for (let offset = 0; offset < state.requestOrder.length; offset += 1) {
    const index = (state.roundRobinCursor + offset) % state.requestOrder.length;
    const requestId = state.requestOrder[index];
    if (!completedIds.has(requestId)) {
      nextRequestId = requestId;
      break;
    }
  }
  for (const id of ids) {
    const request = state.requests[id];
    if (!request) continue;
    request.resultReady = true;
    request.pendingTerminal = null;
    request.state =
      request.admission === "held" ? "result-ready" : "waiting-worktree";
  }
  state.requestOrder = state.requestOrder.filter((id) => !completedIds.has(id));
  delete state.singleflights[singleflight.fingerprintHash];
  if (allowsRetainedSuccessReuse(result)) {
    state.successIndex[singleflight.fingerprintHash] = {
      executionId: result.executionId,
      completedAt: result.completedAt,
    };
  } else delete state.successIndex[singleflight.fingerprintHash];
  state.roundRobinCursor =
    nextRequestId === null ? 0 : state.requestOrder.indexOf(nextRequestId);
}

function invalidResult(path, reason) {
  return new CoordinatorError(
    "RESULT_RECORD_INVALID",
    `terminal result is invalid at ${path}: ${reason}`,
    { path, reason },
  );
}

export function assertResultMatchesSingleflight(result, singleflight) {
  if (result.leaderRequestId !== singleflight.leaderRequestId) {
    throw invalidResult(
      "result.leaderRequestId",
      "does not match the active singleflight leader",
    );
  }
  if (
    result.followerRequestIds.length !== singleflight.followers.length ||
    result.followerRequestIds.some(
      (requestId, index) => requestId !== singleflight.followers[index],
    )
  ) {
    throw invalidResult(
      "result.followerRequestIds",
      "does not match the active singleflight followers",
    );
  }
}

export function readReadyResult(resultsDirectory, policyHash, request) {
  if (!request.resultReady) {
    throw new CoordinatorError(
      "RESULT_NOT_READY",
      "request has no terminal result to acknowledge",
    );
  }
  const result = readExecutionResult(
    resultsDirectory,
    request.fingerprint,
    request.executionId,
    policyHash,
  );
  if (!result) {
    throw new CoordinatorError(
      "RESULT_RECORD_MISSING",
      "terminal request has no immutable result record",
    );
  }
  if (result.leaderRequestId !== request.leaderRequestId) {
    throw invalidResult(
      "result.leaderRequestId",
      "does not match the request leader",
    );
  }
  if (
    (request.role === "leader" &&
      result.leaderRequestId !== request.requestId) ||
    (request.role === "follower" &&
      !result.followerRequestIds.includes(request.requestId))
  ) {
    throw invalidResult(
      request.role === "leader"
        ? "result.leaderRequestId"
        : "result.followerRequestIds",
      `does not contain the ${request.role} request`,
    );
  }
  return result;
}

export function requestRegistration(
  state,
  capacity,
  resultsDirectory,
  request,
) {
  const registration = registrationFor(state, capacity, request);
  if (!request.resultReady) return registration;
  return {
    ...registration,
    result: readReadyResult(resultsDirectory, state.policyHash, request),
  };
}

export function removeAcknowledgedResult(state, resultsDirectory, request) {
  const result = readReadyResult(resultsDirectory, state.policyHash, request);
  if (
    Object.values(state.leases).some(
      (lease) => lease.requestId === request.requestId,
    )
  ) {
    throw new CoordinatorError(
      "LEASES_STILL_ACTIVE",
      "a terminal request cannot acknowledge while leases remain",
    );
  }
  delete state.requests[request.requestId];
  return result;
}
