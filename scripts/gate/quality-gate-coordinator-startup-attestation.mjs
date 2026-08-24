import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { coordinatorRpc } from "./quality-gate-coordinator-client.mjs";
import {
  socketPathForRoot,
  validateLegacyToken,
} from "./quality-gate-coordinator-legacy.mjs";
import {
  CoordinatorError,
  PROTOCOL_VERSION,
  positiveInteger,
  syncDirectory,
  validatePolicyHash,
} from "./quality-gate-coordinator-state.mjs";
import { pruneInactiveNamespaces } from "./quality-gate-coordinator-retention.mjs";

export function stateNamespace(root, policyHash, capacity) {
  validatePolicyHash(policyHash);
  positiveInteger(capacity, "capacity");
  return join(
    resolve(root),
    "state",
    `v${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}-${policyHash}-c${capacity}`,
  );
}

export function validateStartupAttestationCallbacks(
  sourceAttestor,
  beforeSourceAttestation,
  readyMetadataWriter,
) {
  for (const [name, callback] of [
    ["sourceAttestor", sourceAttestor],
    ["beforeSourceAttestation", beforeSourceAttestation],
  ]) {
    if (callback !== null && typeof callback !== "function") {
      throw new CoordinatorError(
        "INVALID_ARGUMENT",
        `${name} must be a function or null`,
      );
    }
  }
  if (typeof readyMetadataWriter !== "function") {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "readyMetadataWriter must be a function",
    );
  }
}

function readyMismatch(message) {
  return new CoordinatorError("COORDINATOR_READY_MISMATCH", message);
}

function sameProtocol(protocol) {
  return (
    protocol?.major === PROTOCOL_VERSION.major &&
    protocol?.minor === PROTOCOL_VERSION.minor
  );
}

function sameCoordinatorIdentity(left, right) {
  return left?.pid === right?.pid && left?.startUtc === right?.startUtc;
}

function assertReadyAuthority(authority, identity, generationToken, required) {
  if (authority?.generationToken !== generationToken) {
    throw readyMismatch("ready authority generation does not match");
  }
  if (!required) {
    if (authority.owned !== false || authority.mode !== "no-legacy-lock") {
      throw readyMismatch("ready authority mode does not match");
    }
    return;
  }
  if (
    authority.owned !== true ||
    authority.owner?.pid !== String(identity.pid) ||
    authority.owner?.coordinator_start_utc !== identity.startUtc
  ) {
    throw readyMismatch("coordinator does not hold its published authority");
  }
}

function parseReadyMetadata(path) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw readyMismatch("ready metadata is not valid JSON");
    }
    throw error;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw readyMismatch("ready metadata must be an object");
  }
  return metadata;
}

function assertDetachedReadyMetadata({
  metadata,
  root,
  policyHash,
  capacity,
  childPid,
  requireLegacyAuthority,
}) {
  if (!sameProtocol(metadata.protocol)) {
    throw readyMismatch("ready protocol does not match");
  }
  if (metadata.policyHash !== policyHash || metadata.capacity !== capacity) {
    throw readyMismatch("ready policy or capacity does not match");
  }
  if (
    metadata.socketPath !== socketPathForRoot(root) ||
    metadata.stateRoot !== stateNamespace(root, policyHash, capacity)
  ) {
    throw readyMismatch("ready state namespace does not match");
  }
  if (
    metadata.coordinatorIdentity?.pid !== childPid ||
    typeof metadata.coordinatorIdentity?.startUtc !== "string" ||
    metadata.coordinatorIdentity.startUtc.length === 0
  ) {
    throw readyMismatch("ready child identity does not match");
  }
  try {
    validateLegacyToken(metadata.generationToken, "ready generation token");
  } catch {
    throw readyMismatch("ready generation token is malformed");
  }
  assertReadyAuthority(
    metadata.authority,
    metadata.coordinatorIdentity,
    metadata.generationToken,
    requireLegacyAuthority,
  );
}

function assertLiveReadySnapshot(live, metadata, requireLegacyAuthority) {
  if (
    !sameProtocol(live?.protocol) ||
    live.policyHash !== metadata.policyHash ||
    live.capacity !== metadata.capacity ||
    live.stateRoot !== metadata.stateRoot ||
    !sameCoordinatorIdentity(
      live.coordinatorIdentity,
      metadata.coordinatorIdentity,
    )
  ) {
    throw readyMismatch("live coordinator identity does not match metadata");
  }
  assertReadyAuthority(
    live.authority,
    metadata.coordinatorIdentity,
    metadata.generationToken,
    requireLegacyAuthority,
  );
}

export async function verifyDetachedCoordinatorReady({
  readyFile,
  root,
  policyHash,
  capacity,
  childPid,
  requireLegacyAuthority,
  rpcTimeoutMs,
  rpc = coordinatorRpc,
}) {
  const metadata = parseReadyMetadata(readyFile);
  if (!metadata) return null;
  assertDetachedReadyMetadata({
    metadata,
    root,
    policyHash,
    capacity,
    childPid,
    requireLegacyAuthority,
  });
  const live = await rpc({ root, policyHash, rpcTimeoutMs }, "inspect");
  assertLiveReadySnapshot(live, metadata, requireLegacyAuthority);
  return metadata;
}

function samePublishedGeneration(current, expected) {
  return (
    current?.policyHash === expected.policyHash &&
    current?.generationToken === expected.generationToken &&
    sameCoordinatorIdentity(
      current?.coordinatorIdentity,
      expected.coordinatorIdentity,
    )
  );
}

function sameFileIdentity(left, right) {
  return ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].every(
    (field) => left[field] === right[field],
  );
}

function removePublishedReadyPath(path, metadata, directorySync) {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) return "retained";
  let current;
  try {
    current = parseReadyMetadata(path);
  } catch (error) {
    if (error.code !== "COORDINATOR_READY_MISMATCH") throw error;
    return "retained";
  }
  let after;
  try {
    after = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
  if (
    !sameFileIdentity(before, after) ||
    !samePublishedGeneration(current, metadata)
  ) {
    return "retained";
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
  directorySync(dirname(path));
  return "removed";
}

export function removePublishedReadyMetadata({
  paths,
  metadata,
  directorySync = syncDirectory,
}) {
  const removed = [];
  const retained = [];
  let failure = null;
  for (const path of new Set(paths.filter(Boolean))) {
    try {
      const outcome = removePublishedReadyPath(path, metadata, directorySync);
      if (outcome === "removed") removed.push(path);
      else if (outcome === "retained") retained.push(path);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return { removed, retained };
}

export async function rollbackReadyPublication({
  paths,
  metadata,
  directorySync,
  rollbackAuthority,
  closeServer,
}) {
  let failure = null;
  for (const action of [
    () => removePublishedReadyMetadata({ paths, metadata, directorySync }),
    rollbackAuthority,
    closeServer,
  ]) {
    try {
      await action();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

async function runStartupAttestationHook(
  beforeSourceAttestation,
  phase,
  context,
) {
  if (beforeSourceAttestation) {
    await beforeSourceAttestation({ phase, ...context });
  }
}

function assertStartupSourceAttestation(sourceAttestor, policyHash, phase) {
  if (!sourceAttestor) return;
  const attestedPolicyHash = sourceAttestor(phase);
  if (attestedPolicyHash !== policyHash) {
    throw new CoordinatorError(
      "POLICY_IDENTITY_CHANGED",
      `coordinator source attestation failed before ${phase}`,
    );
  }
}

export async function runAttestedStartupTransition({
  beforeSourceAttestation,
  sourceAttestor,
  policyHash,
  phase,
  context,
  transition,
}) {
  await runStartupAttestationHook(beforeSourceAttestation, phase, context);
  assertStartupSourceAttestation(sourceAttestor, policyHash, phase);
  return transition();
}

export function runCoordinatorStartupMaintenance({
  runMaintenance,
  core,
  root,
  stateRoot,
  now,
  journalWriter,
}) {
  const activePrune = runMaintenance("startup-prune-records", () =>
    core.pruneRecords(),
  );
  if (!activePrune.ran) {
    throw (
      activePrune.error ??
      new CoordinatorError(
        "COORDINATOR_STOPPING",
        "coordinator stopped during startup record pruning",
      )
    );
  }
  const namespacePrune = runMaintenance("startup-prune-namespaces", () =>
    pruneInactiveNamespaces({
      root,
      activeStateRoot: stateRoot,
      now: now(),
      journalWriter,
    }),
  );
  if (!namespacePrune.ran) {
    throw (
      namespacePrune.error ??
      new CoordinatorError(
        "COORDINATOR_STOPPING",
        "coordinator stopped during startup namespace pruning",
      )
    );
  }
  for (const warning of namespacePrune.value.warnings) {
    process.stderr.write(`quality-gate namespace retained: ${warning}\n`);
  }
  core.reschedule();
}
