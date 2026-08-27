import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  JournalValidationError,
  isPlainRecordValue,
} from "./quality-gate-coordinator-journal-fields.mjs";
import { validatePersistedJournal } from "./quality-gate-coordinator-journal.mjs";
import {
  CoordinatorError,
  JOURNAL_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RECORD_SCHEMA_VERSION,
  copy,
  fingerprintHash,
  hashRequestCapability,
  identitiesEqual,
  identifier,
  validateIdentity,
} from "./quality-gate-coordinator-primitives.mjs";
import { validatePersistedResult } from "./quality-gate-coordinator-result-record.mjs";

export * from "./quality-gate-coordinator-primitives.mjs";
export * from "./quality-gate-coordinator-scheduler.mjs";

import {
  barrier,
  blockersForLease,
  usedCapacity,
  weightedReservation,
  worktreeHolder,
} from "./quality-gate-coordinator-scheduler.mjs";

export function ensurePrivateDirectory(
  path,
  { directorySync = syncDirectory } = {},
) {
  const missing = [];
  for (let current = path; !existsSync(current); current = dirname(current)) {
    missing.push(current);
    if (dirname(current) === current) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CoordinatorError(
      "UNSAFE_STATE_ROOT",
      `state path is not a real directory: ${path}`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CoordinatorError(
      "UNSAFE_STATE_ROOT",
      `state path has a different owner: ${path}`,
    );
  }
  chmodSync(path, 0o700);
  for (const created of missing.reverse()) {
    const createdStat = lstatSync(created);
    if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
      throw new CoordinatorError(
        "UNSAFE_STATE_ROOT",
        `created state path is not a real directory: ${created}`,
      );
    }
    // Persist the new directory entry before a journal can reference content
    // below it. Content writers sync the created directory after mutation.
    directorySync(dirname(created));
  }
}

export function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeAtomicJson(path, value) {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

export function writeImmutable(
  path,
  value,
  equivalent,
  { directorySync = syncDirectory } = {},
) {
  const directory = dirname(path);
  ensurePrivateDirectory(directory, { directorySync });
  const temporary = `${path}.staged-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let result = value;
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(path, "utf8"));
    if (!equivalent(existing, value)) {
      throw new CoordinatorError(
        "IMMUTABLE_RECORD_CONFLICT",
        `immutable record conflicts with ${path}`,
      );
    }
    result = existing;
  }
  // Make the canonical link durable before removing its staging link. A
  // failure leaves the exact staging file as inert recovery evidence.
  directorySync(directory);
  unlinkSync(temporary);
  directorySync(directory);
  return result;
}

export function readExecutionResult(
  resultsDirectory,
  fingerprint,
  executionId,
  policyHash,
) {
  identifier(executionId, "executionId");
  const hash = fingerprintHash(fingerprint);
  const path = join(resultsDirectory, hash, `${executionId}.json`);
  if (!existsSync(path)) return null;
  let result;
  try {
    result = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new CoordinatorError(
      "RESULT_RECORD_INVALID",
      "terminal result is not valid JSON",
      { path: "result", reason: "must be valid JSON" },
    );
  }
  try {
    validatePersistedResult(result, {
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      protocol: PROTOCOL_VERSION,
      policyHash,
      fingerprint,
      fingerprintHash: hash,
      executionId,
    });
  } catch (error) {
    if (!(error instanceof JournalValidationError)) throw error;
    throw new CoordinatorError(
      "RESULT_RECORD_INVALID",
      `terminal result is invalid at ${error.path}: ${error.reason}`,
      { path: error.path, reason: error.reason },
    );
  }
  return result;
}

export function inspectState(state, capacity, identity) {
  const oldestBarrier = barrier(state);
  const reservation = weightedReservation(state);
  return {
    protocol: { ...PROTOCOL_VERSION },
    policyHash: state.policyHash,
    capacity,
    usedCapacity: usedCapacity(state),
    availableCapacity: capacity - usedCapacity(state),
    revision: state.revision,
    coordinatorIdentity: copy(identity),
    activeRequestCount: Object.keys(state.requests).length,
    activeSingleflightCount: Object.keys(state.singleflights).length,
    allCapacityBarrier: oldestBarrier
      ? {
          leaseId: oldestBarrier.leaseId,
          requestId: oldestBarrier.requestId,
          drainIdentity: oldestBarrier.drainIdentity,
          sequence: oldestBarrier.sequence,
        }
      : null,
    weightedCapacityBarrier: reservation
      ? {
          leaseId: reservation.leaseId,
          requestId: reservation.requestId,
          drainIdentity: reservation.drainIdentity,
          sequence: reservation.sequence,
          weight: reservation.weight,
          allCapacity: reservation.allCapacity,
        }
      : null,
    requests: Object.values(state.requests)
      .sort((left, right) => left.sequence - right.sequence)
      .map((request) => {
        const visible = copy(request);
        delete visible.capabilityHash;
        return {
          ...visible,
          worktreeBlocker:
            request.admission === "queued"
              ? (worktreeHolder(state, request.worktreeKey)?.requestId ?? null)
              : null,
        };
      }),
    leases: Object.values(state.leases)
      .sort((left, right) => left.sequence - right.sequence)
      .map((lease) => ({
        ...copy(lease),
        capacity,
        blockers: blockersForLease(state, lease),
      })),
    drainObligations: Object.values(state.drainObligations).map(copy),
  };
}

export function registrationFor(state, capacity, request) {
  return {
    role: request.role,
    requestId: request.requestId,
    drainIdentity: request.drainIdentity,
    executionId: request.executionId,
    leaderRequestId:
      request.leaderRequestId ??
      state.singleflights[request.fingerprintHash]?.leaderRequestId ??
      request.requestId,
    state: request.state,
    admission: request.admission,
    sequence: request.sequence,
    capacity,
    worktreeBlocker:
      request.admission === "queued"
        ? (worktreeHolder(state, request.worktreeKey)?.requestId ?? null)
        : null,
  };
}

export function initialState(capacity, policyHash, identity, generationToken) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    protocol: { ...PROTOCOL_VERSION },
    policyHash,
    capacity,
    revision: 0,
    nextSequence: 1,
    roundRobinCursor: 0,
    coordinatorIdentity: copy(identity),
    generationToken,
    requests: {},
    requestOrder: [],
    leases: {},
    singleflights: {},
    drainObligations: {},
    successIndex: {},
  };
}

export function validateState(state, capacity, policyHash) {
  if (!isPlainRecordValue(state)) {
    throw new CoordinatorError(
      "JOURNAL_STATE_INVALID",
      "journal must be a plain object map",
      { path: "journal", reason: "must be a plain object map" },
    );
  }
  if (state.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new CoordinatorError(
      "JOURNAL_SCHEMA_MISMATCH",
      `unsupported journal schema ${state.schemaVersion}`,
    );
  }
  if (
    state.protocol?.major !== PROTOCOL_VERSION.major ||
    state.protocol?.minor !== PROTOCOL_VERSION.minor
  ) {
    throw new CoordinatorError(
      "JOURNAL_PROTOCOL_MISMATCH",
      "journal protocol differs from this coordinator",
    );
  }
  if (state.policyHash !== policyHash || state.capacity !== capacity) {
    throw new CoordinatorError(
      "STATE_NAMESPACE_MISMATCH",
      "journal policy or capacity differs from its namespace",
    );
  }
  try {
    validatePersistedJournal(state, capacity);
  } catch (error) {
    if (!(error instanceof JournalValidationError)) throw error;
    throw new CoordinatorError(
      "JOURNAL_STATE_INVALID",
      `journal state is invalid at ${error.path}: ${error.reason}`,
      { path: error.path, reason: error.reason },
    );
  }
}

export function assertRequestAuthority(request, owner, capability) {
  const actualCapabilityHash = hashRequestCapability(capability);
  const expectedCapabilityHash = request.capabilityHash;
  if (
    typeof expectedCapabilityHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedCapabilityHash) ||
    !timingSafeEqual(
      Buffer.from(actualCapabilityHash, "hex"),
      Buffer.from(expectedCapabilityHash, "hex"),
    )
  ) {
    throw new CoordinatorError(
      "REQUEST_CAPABILITY_MISMATCH",
      "request capability does not match",
    );
  }
  validateIdentity(owner);
  if (!identitiesEqual(request.owner, owner)) {
    throw new CoordinatorError(
      "OWNER_IDENTITY_MISMATCH",
      "owner PID/start identity does not match",
      { expected: request.owner, actual: owner },
    );
  }
}

export function terminalStatus(value) {
  if (!["success", "failure", "cancelled"].includes(value)) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "status must be success, failure, or cancelled",
    );
  }
  return value;
}

export function staleRequestCandidates(state) {
  return Object.values(state.requests)
    .filter((request) => !request.pendingTerminal)
    .map((request) => ({
      requestId: request.requestId,
      owner: copy(request.owner),
    }));
}

export function stateIsIdle(state) {
  return (
    Object.keys(state.requests).length === 0 &&
    Object.keys(state.leases).length === 0 &&
    Object.keys(state.singleflights).length === 0 &&
    Object.keys(state.drainObligations).length === 0
  );
}
