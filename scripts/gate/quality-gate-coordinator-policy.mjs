import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CoordinatorError,
  DEFAULT_POLICY_HASH,
  positiveInteger,
} from "./quality-gate-coordinator-state.mjs";

const coordinatorDirectory = dirname(fileURLToPath(import.meta.url));
const productionModulePattern =
  /^quality-gate-coordinator(?!.*\.test\.mjs$).*\.mjs$/u;
const adapterNames = [
  "quality-gate-coordinator.sh",
  "quality-gate-coordinator-support.sh",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceIdentityError(message) {
  return new CoordinatorError("POLICY_IDENTITY_CHANGED", message);
}

function sourceNames(directory, readDirectory) {
  const modules = readDirectory(directory)
    .filter((name) => productionModulePattern.test(name))
    .sort();
  const names = [...modules, ...adapterNames];
  if (new Set(names).size !== names.length) {
    throw sourceIdentityError(
      "coordinator source manifest contains duplicates",
    );
  }
  return names;
}

function sameSourceIdentity(left, right) {
  return [
    "dev",
    "ino",
    "mode",
    "uid",
    "gid",
    "size",
    "mtimeNs",
    "ctimeNs",
  ].every((field) => left[field] === right[field]);
}

function stableFileDigest(path, { readSource, sourceStat }) {
  const before = sourceStat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw sourceIdentityError("coordinator source path is not a regular file");
  }
  const bytes = readSource(path);
  const after = sourceStat(path, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameSourceIdentity(before, after) ||
    BigInt(bytes.length) !== after.size
  ) {
    throw sourceIdentityError("coordinator source changed while it was read");
  }
  return sha256(bytes);
}

function sourceSnapshot(directory, names, operations) {
  return names.map((name) => ({
    name,
    relativePath: `gate/${name}`,
    digest: stableFileDigest(join(directory, name), operations),
  }));
}

function equalSnapshots(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.name === right[index].name &&
        entry.digest === right[index].digest,
    )
  );
}

export function coordinatorSourceSnapshot({
  directory = coordinatorDirectory,
  readDirectory = (path) => readdirSync(path),
  readSource = (path) => readFileSync(path),
  sourceStat = (path, options) => lstatSync(path, options),
} = {}) {
  const operations = { readSource, sourceStat };
  const initialNames = sourceNames(directory, readDirectory);
  const first = sourceSnapshot(directory, initialNames, operations);
  const secondNames = sourceNames(directory, readDirectory);
  if (initialNames.join("\0") !== secondNames.join("\0")) {
    throw sourceIdentityError(
      "coordinator source set changed while it was read",
    );
  }
  const second = sourceSnapshot(directory, secondNames, operations);
  const finalNames = sourceNames(directory, readDirectory);
  if (
    secondNames.join("\0") !== finalNames.join("\0") ||
    !equalSnapshots(first, second)
  ) {
    throw sourceIdentityError("coordinator source changed while it was hashed");
  }
  return second;
}

export function coordinatorSourceSignature(options = {}) {
  const snapshot = options.snapshot ?? coordinatorSourceSnapshot(options);
  return sha256(
    snapshot.map((entry) => `${entry.relativePath} ${entry.digest}\n`).join(""),
  );
}

export function coordinatorNodeRuntimeHash({
  executable = process.execPath,
  version = process.version,
  platform = process.platform,
  architecture = process.arch,
  nodeOptions = process.env.NODE_OPTIONS ?? "",
} = {}) {
  return sha256(
    JSON.stringify([executable, version, platform, architecture, nodeOptions]),
  );
}

function adapterHashesFromSnapshot(snapshot) {
  const byName = new Map(snapshot.map((entry) => [entry.name, entry.digest]));
  if ([...byName.values()].some((digest) => !/^[a-f0-9]{64}$/u.test(digest))) {
    throw sourceIdentityError("coordinator source digest is incomplete");
  }
  const main = byName.get(adapterNames[0]);
  const support = byName.get(adapterNames[1]);
  if (![main, support].every((digest) => /^[a-f0-9]{64}$/u.test(digest))) {
    throw sourceIdentityError("coordinator adapter digest is incomplete");
  }
  return { main, support };
}

export function coordinatorAdapterHashes(options = {}) {
  const snapshot = options.snapshot ?? coordinatorSourceSnapshot(options);
  return adapterHashesFromSnapshot(snapshot);
}

function assertLoadedAdapterHashes(actual, expected) {
  if (expected === undefined) return;
  if (
    ![expected.main, expected.support].every((digest) =>
      /^[a-f0-9]{64}$/u.test(digest ?? ""),
    )
  ) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "loaded adapter hashes must be lowercase SHA-256 digests",
    );
  }
  if (actual.main !== expected.main || actual.support !== expected.support) {
    throw sourceIdentityError(
      "loaded coordinator adapter differs from the current source",
    );
  }
}

export function effectiveCoordinatorPolicyHash(capacity, options = {}) {
  positiveInteger(capacity, "capacity");
  if (capacity > 64) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "capacity must be at most 64",
    );
  }
  const snapshot = options.snapshot ?? coordinatorSourceSnapshot(options);
  const adapterHashes = adapterHashesFromSnapshot(snapshot);
  assertLoadedAdapterHashes(adapterHashes, options.loadedAdapterHashes);
  const adapterHash = sha256(
    `${adapterHashes.main}\n${adapterHashes.support}\n`,
  );
  const runtimeHash = coordinatorSourceSignature({ snapshot });
  const nodeRuntimeHash = coordinatorNodeRuntimeHash(options);
  return sha256(
    `node-policy=${DEFAULT_POLICY_HASH}\n` +
      `node-runtime=${nodeRuntimeHash}\n` +
      `adapter=${adapterHash}\n` +
      `runtime=${runtimeHash}\n` +
      `capacity=${capacity}\n`,
  );
}

export function assertEffectiveCoordinatorPolicy(expected, capacity, options) {
  if (!/^[a-f0-9]{64}$/u.test(expected ?? "")) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "--policy-hash must be a lowercase SHA-256 digest",
    );
  }
  const actual = effectiveCoordinatorPolicyHash(capacity, options);
  if (actual !== expected) {
    throw sourceIdentityError(
      "coordinator runtime or source changed after policy selection",
    );
  }
  return actual;
}

export function createCoordinatorPolicyAttestor(expected, capacity) {
  assertEffectiveCoordinatorPolicy(expected, capacity);
  const attestor = () => assertEffectiveCoordinatorPolicy(expected, capacity);
  return Object.freeze(attestor);
}
