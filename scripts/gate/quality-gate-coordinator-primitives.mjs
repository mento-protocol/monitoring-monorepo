import { createHash } from "node:crypto";

import {
  DARWIN_COHERENT_LIFECYCLE_CONTRACT,
  DARWIN_LEGACY_LIFECYCLE_CONTRACT,
  LEASE_LIFECYCLE_CONTRACTS,
  PERSISTED_DARWIN_LIFECYCLE_CONTRACTS,
  PERSISTED_LEASE_LIFECYCLE_CONTRACTS,
  isIdentifierValue,
  isResourceNameValue,
  isRunTokenValue,
} from "./quality-gate-coordinator-journal-fields.mjs";

export {
  DARWIN_COHERENT_LIFECYCLE_CONTRACT,
  DARWIN_LEGACY_LIFECYCLE_CONTRACT,
  LEASE_LIFECYCLE_CONTRACTS,
  PERSISTED_DARWIN_LIFECYCLE_CONTRACTS,
  PERSISTED_LEASE_LIFECYCLE_CONTRACTS,
};

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 2 });
export const JOURNAL_SCHEMA_VERSION = 3;
export const RECORD_SCHEMA_VERSION = 1;
export const DEFAULT_CAPACITY = 3;
export const DEFAULT_IDLE_MS = 5_000;
export const DEFAULT_SUCCESS_MAX_AGE_MS = 0;

const writerSuffixPattern =
  /^[1-9][0-9]{0,9}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

const policyDescription = `quality-gate-coordinator-policy-v4
request-round-robin weighted-capacity oldest-all-capacity-barrier
weighted-reservation-barrier atomic-named-resources
full-request-worktree-admission explicit-result-handoff-ack explicit-drain-ack
per-request-capability-digest-auth strict-per-execution-results
distinct-request-and-per-lease-drain-identities
typed-active-and-persisted-lease-lifecycle-contract
global-darwin-coherent-settlement-barrier legacy-darwin-drain-recovery`;

export const DEFAULT_POLICY_HASH = createHash("sha256")
  .update(policyDescription)
  .digest("hex");

export class CoordinatorError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CoordinatorError";
    this.code = code;
    this.details = details;
  }
}

export function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isAtomicWriteTemporaryName(name, targetName) {
  const prefix = `${targetName}.tmp-`;
  return (
    name.startsWith(prefix) &&
    writerSuffixPattern.test(name.slice(prefix.length))
  );
}

export function isImmutableWriteStagingName(name) {
  const marker = ".json.staged-";
  const markerIndex = name.lastIndexOf(marker);
  if (markerIndex < 1) return false;
  return (
    isIdentifierValue(name.slice(0, markerIndex)) &&
    writerSuffixPattern.test(name.slice(markerIndex + marker.length))
  );
}

export function utc(now) {
  return new Date(now()).toISOString();
}

export function text(value, label, maximumBytes = 4096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${label} must be a non-empty string of at most ${maximumBytes} bytes`,
    );
  }
}

export function identifier(value, label) {
  if (!isIdentifierValue(value)) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${label} contains unsupported characters`,
    );
  }
}

export function validateRunToken(token, label = "run token") {
  if (!isRunTokenValue(token)) {
    throw new CoordinatorError("INVALID_ARGUMENT", `${label} is malformed`);
  }
}

export function validateLifecycleContract(value, label = "lifecycleContract") {
  if (!LEASE_LIFECYCLE_CONTRACTS.includes(value)) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${label} must be one of ${LEASE_LIFECYCLE_CONTRACTS.join(", ")}`,
    );
  }
  return value;
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${label} must be a positive integer`,
    );
  }
}

export function validatePolicyHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "policyHash must be a lowercase SHA-256 digest",
    );
  }
}

export function validateIdentity(identity, label = "owner") {
  if (!identity || typeof identity !== "object") {
    throw new CoordinatorError(
      "INVALID_IDENTITY",
      `${label} must contain pid and startUtc`,
    );
  }
  positiveInteger(identity.pid, `${label}.pid`);
  text(identity.startUtc, `${label}.startUtc`, 256);
  if (/\r|\n/.test(identity.startUtc)) {
    throw new CoordinatorError(
      "INVALID_IDENTITY",
      `${label}.startUtc must be one process-start line`,
    );
  }
}

export function identitiesEqual(left, right) {
  return left?.pid === right?.pid && left?.startUtc === right?.startUtc;
}

export function jsonSize(value, label, maximumBytes = 256 * 1024) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${label} must be JSON serializable: ${error.message}`,
    );
  }
  if (Buffer.byteLength(encoded) > maximumBytes) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${label} exceeds ${maximumBytes} bytes`,
    );
  }
}

export function fingerprintHash(fingerprint) {
  text(fingerprint, "fingerprint", 64 * 1024);
  return createHash("sha256").update(fingerprint).digest("hex");
}

export function hashRequestCapability(capability) {
  if (typeof capability !== "string" || !/^[a-f0-9]{64}$/u.test(capability)) {
    throw new CoordinatorError(
      "INVALID_REQUEST_CAPABILITY",
      "request capability must be 32 random bytes encoded as lowercase hex",
    );
  }
  return createHash("sha256").update(capability).digest("hex");
}

export function normalizeResources(values = []) {
  if (!Array.isArray(values)) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "resources must be an array",
    );
  }
  const normalized = [...new Set(values)].sort();
  for (const value of normalized) {
    if (!isResourceNameValue(value)) {
      throw new CoordinatorError(
        "INVALID_ARGUMENT",
        `invalid resource name: ${value}`,
      );
    }
  }
  return normalized;
}
