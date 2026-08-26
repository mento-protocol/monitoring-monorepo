import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { validateRetainedResults } from "./quality-gate-coordinator-results.mjs";
import {
  PROTOCOL_VERSION,
  isAtomicWriteTemporaryName,
  isImmutableWriteStagingName,
  stateIsIdle,
  validateState,
  writeAtomicJson,
} from "./quality-gate-coordinator-state.mjs";

export const RECORD_RETENTION_MS = 2 * 60 * 60 * 1_000;
const MAX_OLD_NAMESPACES_PER_START = 128;
const namespacePattern = /^v([0-9]+)\.([0-9]+)-([a-f0-9]{64})-c([1-9][0-9]*)$/u;
const fingerprintHashPattern = /^[a-f0-9]{64}$/u;
const deletionMarkerName = ".deleting-v1";
const deletionMarkerStagingName = ".deleting-v1.staging";
const deletionMarkerContent = "quality-gate-namespace-deletion-v1\n";

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncFile(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function jsonFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(path, entry.name));
}

function expiredResult(path, now, retentionMs) {
  let result;
  try {
    result = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  const completedAt = Date.parse(result?.completedAt);
  const age = now - completedAt;
  return Number.isFinite(completedAt) && age >= 0 && age > retentionMs;
}

function expiredArtifact(path, now, retentionMs, lstatFile) {
  let metadata;
  try {
    metadata = lstatFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    return false;
  const age = now - metadata.mtimeMs;
  return Number.isFinite(metadata.mtimeMs) && age >= 0 && age > retentionMs;
}

export function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function pruneArtifacts(
  directory,
  matches,
  now,
  retentionMs,
  unlinkFile = unlinkIfPresent,
  lstatFile = lstatSync,
) {
  if (!existsSync(directory)) return 0;
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !matches(entry.name)) continue;
    const path = join(directory, entry.name);
    if (!expiredArtifact(path, now, retentionMs, lstatFile)) continue;
    if (unlinkFile(path)) removed += 1;
  }
  if (removed) syncDirectory(directory);
  return removed;
}

export function pruneExpiredSuccessIndexes({
  state,
  now,
  retentionMs = RECORD_RETENTION_MS,
}) {
  let successIndexes = 0;
  for (const [hash, indexed] of Object.entries(state.successIndex)) {
    const completedAt = Date.parse(indexed.completedAt);
    const age = now - completedAt;
    if (!Number.isFinite(completedAt) || age < 0 || age <= retentionMs)
      continue;
    delete state.successIndex[hash];
    successIndexes += 1;
  }
  return successIndexes;
}

export function prunePersistentRecords({
  stateDirectory,
  requestsDirectory,
  resultsDirectory,
  state,
  now,
  retentionMs = RECORD_RETENTION_MS,
  unlinkFile = unlinkIfPresent,
  lstatFile = lstatSync,
}) {
  assertOwnedDirectory(stateDirectory);
  assertOwnedDirectory(requestsDirectory);
  assertOwnedDirectory(resultsDirectory);
  const activeRequests = new Set(Object.keys(state.requests));
  const activeResultPaths = new Set(
    [
      ...Object.values(state.requests).map((request) => [
        request.fingerprintHash,
        request.executionId,
      ]),
      ...Object.entries(state.successIndex).map(([hash, indexed]) => [
        hash,
        indexed.executionId,
      ]),
    ].map(([hash, executionId]) =>
      join(resultsDirectory, hash, `${executionId}.json`),
    ),
  );
  let requestRecords = 0;
  for (const path of jsonFiles(requestsDirectory)) {
    const requestId = path.slice(path.lastIndexOf("/") + 1, -5);
    if (activeRequests.has(requestId)) continue;
    if (unlinkFile(path)) requestRecords += 1;
  }
  if (requestRecords) syncDirectory(requestsDirectory);

  let temporaryRecords = pruneArtifacts(
    stateDirectory,
    (name) => isAtomicWriteTemporaryName(name, "journal.json"),
    now,
    retentionMs,
    unlinkFile,
    lstatFile,
  );
  temporaryRecords += pruneArtifacts(
    requestsDirectory,
    isImmutableWriteStagingName,
    now,
    retentionMs,
    unlinkFile,
    lstatFile,
  );

  let resultRecords = 0;
  let resultDirectories = 0;
  for (const directory of readdirSync(resultsDirectory, {
    withFileTypes: true,
  })) {
    if (
      !directory.isDirectory() ||
      !fingerprintHashPattern.test(directory.name)
    )
      continue;
    const path = join(resultsDirectory, directory.name);
    assertOwnedDirectory(path);
    let directoryResultRecords = 0;
    for (const resultPath of jsonFiles(path)) {
      if (activeResultPaths.has(resultPath)) continue;
      if (!expiredResult(resultPath, now, retentionMs)) continue;
      if (unlinkFile(resultPath)) {
        resultRecords += 1;
        directoryResultRecords += 1;
      }
    }
    if (directoryResultRecords) syncDirectory(path);
    temporaryRecords += pruneArtifacts(
      path,
      isImmutableWriteStagingName,
      now,
      retentionMs,
      unlinkFile,
      lstatFile,
    );
    try {
      rmdirSync(path);
      resultDirectories += 1;
    } catch (error) {
      if (error.code !== "ENOTEMPTY") throw error;
    }
  }
  if (resultRecords || resultDirectories) syncDirectory(resultsDirectory);

  return {
    changed: requestRecords + resultRecords + temporaryRecords > 0,
    requestRecords,
    resultRecords,
    temporaryRecords,
  };
}

function parseNamespaceIdentity(name) {
  const match = namespacePattern.exec(name);
  if (!match) throw new Error("namespace identity is malformed");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const policyHash = match[3];
  const capacity = Number(match[4]);
  if (
    !Number.isSafeInteger(major) ||
    major < 1 ||
    !Number.isSafeInteger(minor) ||
    minor < 0 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1
  ) {
    throw new Error("namespace identity is malformed");
  }
  const canonical = `v${major}.${minor}-${policyHash}-c${capacity}`;
  if (canonical !== name) {
    throw new Error("namespace identity is not canonical");
  }
  if (major !== PROTOCOL_VERSION.major || minor !== PROTOCOL_VERSION.minor) {
    throw new Error(`unsupported namespace protocol v${major}.${minor}`);
  }
  return { policyHash, capacity };
}

function assertOwnedDirectory(path) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("namespace path is not a real directory");
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error("namespace path has a different owner");
  }
}

function assertOwnedFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("namespace entry is not a real file");
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error("namespace entry has a different owner");
  }
  return metadata;
}

function createDeletionMarker(path) {
  const markerPath = join(path, deletionMarkerName);
  const stagingPath = join(path, deletionMarkerStagingName);
  const descriptor = openSync(stagingPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, deletionMarkerContent, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  linkSync(stagingPath, markerPath);
  syncDirectory(path);
  unlinkSync(stagingPath);
  syncDirectory(path);
}

function validateDeletionMarker(path, { allowStaging = false } = {}) {
  const markerPath = join(path, deletionMarkerName);
  assertOwnedFile(markerPath);
  if (readFileSync(markerPath, "utf8") !== deletionMarkerContent) {
    throw new Error("namespace deletion marker is invalid");
  }
  const allowed = new Set([
    deletionMarkerName,
    "journal.json",
    "requests",
    "results",
  ]);
  if (allowStaging) allowed.add(deletionMarkerStagingName);
  const unexpected = readdirSync(path).filter((name) => !allowed.has(name));
  if (unexpected.length) {
    throw new Error(
      `namespace deletion has unexpected entry: ${unexpected[0]}`,
    );
  }
}

function removeOwnedFileIfPresent(path) {
  if (!existsSync(path)) return;
  assertOwnedFile(path);
  unlinkSync(path);
}

function removeEmptyDirectoryIfPresent(path) {
  if (!existsSync(path)) return;
  assertOwnedDirectory(path);
  if (readdirSync(path).length) {
    throw new Error("namespace deletion directory is not empty");
  }
  rmdirSync(path);
}

function finishNamespaceDeletion(path, stateDirectory) {
  validateDeletionMarker(path);
  // Repair a marker that became visible before its creator completed either
  // fsync. No protected entry is removed until this proof is durable.
  syncFile(join(path, deletionMarkerName));
  syncDirectory(path);
  removeOwnedFileIfPresent(join(path, "journal.json"));
  removeEmptyDirectoryIfPresent(join(path, "requests"));
  removeEmptyDirectoryIfPresent(join(path, "results"));
  // Persist every protected entry removal while the durable marker still
  // proves that restart may resume this exact deletion.
  syncDirectory(path);
  unlinkSync(join(path, deletionMarkerName));
  syncDirectory(path);
  rmdirSync(path);
  syncDirectory(stateDirectory);
}

function removeEmptyNamespace(path, state, stateDirectory) {
  if (Object.keys(state.successIndex).length) return false;
  const requestsDirectory = join(path, "requests");
  const resultsDirectory = join(path, "results");
  if (
    readdirSync(requestsDirectory).length ||
    readdirSync(resultsDirectory).length
  )
    return false;
  const names = readdirSync(path).sort();
  if (names.join("\n") !== "journal.json\nrequests\nresults") return false;
  createDeletionMarker(path);
  finishNamespaceDeletion(path, stateDirectory);
  return true;
}

function resumeNamespaceDeletion(path, stateDirectory) {
  let names = readdirSync(path);
  if (names.length === 0) {
    rmdirSync(path);
    syncDirectory(stateDirectory);
    return true;
  }
  if (names.includes(deletionMarkerStagingName)) {
    const stagingPath = join(path, deletionMarkerStagingName);
    const stagingMetadata = assertOwnedFile(stagingPath);
    if (!names.includes(deletionMarkerName)) {
      const expected = [
        deletionMarkerStagingName,
        "journal.json",
        "requests",
        "results",
      ].sort();
      if (names.sort().join("\n") !== expected.join("\n")) {
        throw new Error("namespace deletion staging state is invalid");
      }
      unlinkSync(stagingPath);
      syncDirectory(path);
      return false;
    }
    const markerMetadata = assertOwnedFile(join(path, deletionMarkerName));
    if (
      markerMetadata.dev !== stagingMetadata.dev ||
      markerMetadata.ino !== stagingMetadata.ino
    ) {
      throw new Error("namespace deletion links do not share one inode");
    }
    validateDeletionMarker(path, { allowStaging: true });
    syncFile(join(path, deletionMarkerName));
    syncDirectory(path);
    unlinkSync(stagingPath);
    syncDirectory(path);
    names = readdirSync(path);
  }
  if (!names.includes(deletionMarkerName)) return false;
  finishNamespaceDeletion(path, stateDirectory);
  return true;
}

export function pruneInactiveNamespaces({
  root,
  activeStateRoot,
  now,
  maximumNamespaces = MAX_OLD_NAMESPACES_PER_START,
  journalWriter = writeAtomicJson,
}) {
  const stateDirectory = join(resolve(root), "state");
  if (!existsSync(stateDirectory))
    return { scanned: 0, removed: 0, warnings: [] };
  assertOwnedDirectory(stateDirectory);
  const active = resolve(activeStateRoot);
  const candidates = readdirSync(stateDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && namespacePattern.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: join(stateDirectory, entry.name),
    }))
    .filter((entry) => resolve(entry.path) !== active)
    .sort(
      (left, right) =>
        lstatSync(left.path).mtimeMs - lstatSync(right.path).mtimeMs,
    )
    .slice(0, maximumNamespaces);
  const outcome = { scanned: 0, removed: 0, warnings: [] };
  for (const candidate of candidates) {
    outcome.scanned += 1;
    try {
      assertOwnedDirectory(candidate.path);
      const namespace = parseNamespaceIdentity(candidate.name);
      if (resumeNamespaceDeletion(candidate.path, stateDirectory)) {
        outcome.removed += 1;
        continue;
      }
      const requestsDirectory = join(candidate.path, "requests");
      const resultsDirectory = join(candidate.path, "results");
      assertOwnedDirectory(requestsDirectory);
      assertOwnedDirectory(resultsDirectory);
      const journalPath = join(candidate.path, "journal.json");
      assertOwnedFile(journalPath);
      const state = JSON.parse(readFileSync(journalPath, "utf8"));
      validateState(state, namespace.capacity, namespace.policyHash);
      if (!stateIsIdle(state)) {
        outcome.warnings.push(`${candidate.name}: journal is not idle`);
        continue;
      }
      validateRetainedResults({
        resultsDirectory,
        successIndex: state.successIndex,
        policyHash: namespace.policyHash,
      });
      const successIndexes = pruneExpiredSuccessIndexes({ state, now });
      if (successIndexes) {
        state.revision = Number.isSafeInteger(state.revision)
          ? state.revision + 1
          : 1;
        journalWriter(journalPath, state);
      }
      prunePersistentRecords({
        stateDirectory: candidate.path,
        requestsDirectory,
        resultsDirectory,
        state,
        now,
      });
      if (removeEmptyNamespace(candidate.path, state, stateDirectory)) {
        outcome.removed += 1;
      }
    } catch (error) {
      outcome.warnings.push(`${candidate.name}: ${error.message}`);
    }
  }
  return outcome;
}
