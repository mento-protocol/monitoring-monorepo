const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const runTokenPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}-[0-9]{1,10}-[0-9]{1,12}$/u;
const resourcePattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export const DARWIN_COHERENT_LIFECYCLE_CONTRACT = "darwin-coherent-lineage-v2";
export const DARWIN_LEGACY_LIFECYCLE_CONTRACT = "darwin-unique-lineage-v1";

export const LEASE_LIFECYCLE_CONTRACTS = Object.freeze([
  "portable-marker-v1",
  DARWIN_COHERENT_LIFECYCLE_CONTRACT,
]);

export const PERSISTED_LEASE_LIFECYCLE_CONTRACTS = Object.freeze([
  ...LEASE_LIFECYCLE_CONTRACTS,
  DARWIN_LEGACY_LIFECYCLE_CONTRACT,
]);

export const PERSISTED_DARWIN_LIFECYCLE_CONTRACTS = Object.freeze([
  DARWIN_COHERENT_LIFECYCLE_CONTRACT,
  DARWIN_LEGACY_LIFECYCLE_CONTRACT,
]);

export class JournalValidationError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = "JournalValidationError";
    this.path = path;
    this.reason = reason;
  }
}

export function reject(path, reason) {
  throw new JournalValidationError(path, reason);
}

export function isPlainRecordValue(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isIdentifierValue(value) {
  return typeof value === "string" && identifierPattern.test(value);
}

export function isRunTokenValue(value) {
  return typeof value === "string" && runTokenPattern.test(value);
}

export function isResourceNameValue(value) {
  return typeof value === "string" && resourcePattern.test(value);
}

export function record(value, path) {
  if (!isPlainRecordValue(value)) reject(path, "must be a plain object map");
  return value;
}

export function array(value, path) {
  if (!Array.isArray(value)) reject(path, "must be an array");
  return value;
}

export function identifier(value, path) {
  if (!isIdentifierValue(value)) reject(path, "must be a valid identifier");
}

export function runToken(value, path) {
  if (!isRunTokenValue(value)) reject(path, "must be a valid run token");
}

export function sha256(value, path) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    reject(path, "must be a lowercase SHA-256 digest");
  }
}

export function text(value, path, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    reject(path, `must be non-empty text of at most ${maximumBytes} bytes`);
  }
}

export function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    reject(path, "must be a positive safe integer");
  }
}

export function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject(path, "must be a non-negative safe integer");
  }
}

export function utcTimestamp(value, path) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    reject(path, "must be a canonical UTC timestamp");
  }
}

export function identity(value, path) {
  record(value, path);
  positiveInteger(value.pid, `${path}.pid`);
  text(value.startUtc, `${path}.startUtc`, 256);
  if (/\r|\n/u.test(value.startUtc)) {
    reject(`${path}.startUtc`, "must be one process-start line");
  }
}

export function identitiesEqual(left, right) {
  return left?.pid === right?.pid && left?.startUtc === right?.startUtc;
}

export function boundedJson(value, path) {
  validateJson(value, path, new Set());
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) {
    reject(path, "exceeds 262144 bytes");
  }
}

function validateJson(value, path, seen) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject(path, "contains a non-finite number");
    return;
  }
  if (typeof value !== "object") reject(path, "is not JSON data");
  if (seen.has(value)) reject(path, "contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateJson(item, `${path}[${index}]`, seen),
    );
  } else {
    record(value, path);
    for (const [key, item] of Object.entries(value)) {
      validateJson(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) {
    reject(path, `must be one of ${allowed.join(", ")}`);
  }
}

export function lifecycleContract(value, path) {
  oneOf(value, PERSISTED_LEASE_LIFECYCLE_CONTRACTS, path);
}

export function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}
