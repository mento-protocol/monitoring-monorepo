import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import {
  CoordinatorError,
  validateIdentity,
  validateRunToken,
} from "./quality-gate-coordinator-state.mjs";

export const LEGACY_RUN_LOCK_INTEGRATION = Object.freeze({
  mode: "atomic-bash-owner-handoff",
  coordinatorHoldsLockUntilIdle: true,
  markerHeldOpen: true,
});

const LEGACY_COORDINATOR_OWNER_IDENTITY = "coordinator-owner-v1";
const OWNER_QUARANTINE_PREFIX = "owner.reclaiming.quarantine.v2";
const HOLDER_QUARANTINE_PREFIX = "holder.reclaiming.quarantine.v1";
const NO_MACHINE_IDENTITY = "<no-machine-identity>";
const MACHINE_IDENTITY_PATTERN =
  /^(?:override|machineid|ioplatform|kernuuid):[A-Za-z0-9._-]{1,128}$/u;
const MACHINE_SOURCE_PATTERN =
  /^(?:none|override|machineid|ioplatform|kernuuid)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const QUARANTINE_NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{5,79}$/u;

function processSnapshot(pid) {
  try {
    const output = execFileSync(
      "ps",
      ["-o", "lstart=", "-o", "stat=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const match = output.match(/^(.*\S)\s+(\S+)$/);
    if (!match) return null;
    return { startUtc: match[1], state: match[2] };
  } catch {
    return null;
  }
}

export function processStartUtc(pid) {
  return processSnapshot(pid)?.startUtc ?? null;
}

export function observeProcessIdentity(identity) {
  validateIdentity(identity);
  const snapshot = processSnapshot(identity.pid);
  if (snapshot) {
    if (snapshot.startUtc !== identity.startUtc) {
      return { state: "reused", startUtc: snapshot.startUtc };
    }
    return {
      state: snapshot.state.startsWith("Z") ? "dead" : "live",
      startUtc: snapshot.startUtc,
    };
  }
  try {
    process.kill(identity.pid, 0);
    return { state: "unknown", startUtc: null };
  } catch (error) {
    return error.code === "ESRCH"
      ? { state: "dead", startUtc: null }
      : { state: "unknown", startUtc: null };
  }
}

export function currentProcessIdentity() {
  const startUtc = processStartUtc(process.pid);
  if (!startUtc) {
    throw new CoordinatorError(
      "PROCESS_IDENTITY_UNAVAILABLE",
      "could not read this coordinator's UTC process-start identity",
    );
  }
  return { pid: process.pid, startUtc };
}

export function generatedToken(pid) {
  const host =
    hostname()
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 150) || "localhost";
  return `${host}-${pid}-${Math.floor(Date.now() / 1000)}`;
}

export function validateLegacyToken(token, label = "legacy token") {
  validateRunToken(token, label);
}

function validateLegacyMachineIdentity(identity) {
  if (identity === "") return;
  if (
    typeof identity !== "string" ||
    !MACHINE_IDENTITY_PATTERN.test(identity)
  ) {
    throw new CoordinatorError(
      "INVALID_MACHINE_IDENTITY",
      "legacy machine identity is not a tagged gate machine identity",
    );
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function quarantineCreatorMachine(machineIdentity) {
  validateLegacyMachineIdentity(machineIdentity);
  if (machineIdentity === "") {
    return {
      source: "none",
      fingerprint: sha256(NO_MACHINE_IDENTITY),
    };
  }
  return {
    source: machineIdentity.slice(0, machineIdentity.indexOf(":")),
    fingerprint: sha256(machineIdentity),
  };
}

export function legacyOwnerQuarantineName({
  machineIdentity = "",
  host = hostname(),
  createdAtEpoch = Math.floor(Date.now() / 1_000),
  pid = process.pid,
  nonce = randomUUID(),
} = {}) {
  if (typeof host !== "string" || host.length === 0) {
    throw new CoordinatorError(
      "INVALID_QUARANTINE_IDENTITY",
      "legacy owner quarantine host identity is empty",
    );
  }
  if (
    !Number.isSafeInteger(createdAtEpoch) ||
    createdAtEpoch < 1 ||
    createdAtEpoch > 999_999_999_999
  ) {
    throw new CoordinatorError(
      "INVALID_QUARANTINE_IDENTITY",
      "legacy owner quarantine creation epoch is invalid",
    );
  }
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new CoordinatorError(
      "INVALID_QUARANTINE_IDENTITY",
      "legacy owner quarantine creator pid is invalid",
    );
  }
  if (typeof nonce !== "string" || !QUARANTINE_NONCE_PATTERN.test(nonce)) {
    throw new CoordinatorError(
      "INVALID_QUARANTINE_IDENTITY",
      "legacy owner quarantine nonce is invalid",
    );
  }
  const machine = quarantineCreatorMachine(machineIdentity);
  return [
    OWNER_QUARANTINE_PREFIX,
    machine.source,
    machine.fingerprint,
    sha256(host),
    createdAtEpoch,
    pid,
    nonce,
  ].join(".");
}

export function parseLegacyOwnerQuarantineName(name) {
  if (typeof name !== "string" || name.includes("/")) return null;
  const v2 = name.match(
    /^owner\.reclaiming\.quarantine\.v2\.(none|override|machineid|ioplatform|kernuuid)\.([0-9a-f]{64})\.([0-9a-f]{64})\.([1-9][0-9]{0,11})\.([1-9][0-9]*)\.([A-Za-z0-9][A-Za-z0-9.-]{5,79})$/u,
  );
  if (v2) {
    const evidence = {
      version: 2,
      machineSource: v2[1],
      machineFingerprint: v2[2],
      hostFingerprint: v2[3],
      createdAtEpoch: Number(v2[4]),
      pid: Number(v2[5]),
      nonce: v2[6],
    };
    if (
      !MACHINE_SOURCE_PATTERN.test(evidence.machineSource) ||
      !SHA256_PATTERN.test(evidence.machineFingerprint) ||
      !SHA256_PATTERN.test(evidence.hostFingerprint) ||
      !Number.isSafeInteger(evidence.createdAtEpoch) ||
      !Number.isSafeInteger(evidence.pid) ||
      (evidence.machineSource === "none" &&
        evidence.machineFingerprint !== sha256(NO_MACHINE_IDENTITY))
    ) {
      return null;
    }
    return evidence;
  }
  const v1 = name.match(
    /^owner\.reclaiming\.quarantine\.v1\.([0-9a-f]{64})\.([1-9][0-9]*)\.([A-Za-z0-9][A-Za-z0-9.-]{5,79})$/u,
  );
  if (!v1) return null;
  const evidence = {
    version: 1,
    machineSource: null,
    machineFingerprint: null,
    hostFingerprint: v1[1],
    createdAtEpoch: null,
    pid: Number(v1[2]),
    nonce: v1[3],
  };
  return Number.isSafeInteger(evidence.pid) ? evidence : null;
}

function quarantineMachineVerdict(
  evidence,
  { machineIdentity, host, rootIsPerMachine },
) {
  const localMachine = quarantineCreatorMachine(machineIdentity);
  const localHostFingerprint = sha256(host);
  if (
    evidence.version === 2 &&
    evidence.machineSource !== "none" &&
    localMachine.source !== "none"
  ) {
    if (
      evidence.machineSource === localMachine.source &&
      evidence.machineFingerprint === localMachine.fingerprint
    ) {
      return rootIsPerMachine ||
        evidence.hostFingerprint === localHostFingerprint
        ? "same"
        : "unverified";
    }
    return evidence.machineSource === localMachine.source && !rootIsPerMachine
      ? "other"
      : "unverified";
  }
  return evidence.hostFingerprint === localHostFingerprint
    ? "same"
    : "unverified";
}

export function legacyOwnerQuarantineRecoveryDecision(
  name,
  {
    machineIdentity = "",
    host = hostname(),
    rootIsPerMachine = false,
    nowEpoch = Math.floor(Date.now() / 1_000),
    unverifiedGraceSeconds = 600,
    legacyCreatedAtEpoch = null,
    creatorMayOwn = processMayOwnInertStage,
  } = {},
) {
  const evidence = parseLegacyOwnerQuarantineName(name);
  if (!evidence) {
    return {
      action: "retain",
      machineVerdict: "invalid",
      localPidChecked: false,
      reason: "invalid-name",
    };
  }
  validateLegacyMachineIdentity(machineIdentity);
  if (typeof host !== "string" || host.length === 0) {
    throw new CoordinatorError(
      "INVALID_QUARANTINE_IDENTITY",
      "legacy owner quarantine recovery host identity is empty",
    );
  }
  if (
    !Number.isSafeInteger(nowEpoch) ||
    nowEpoch < 1 ||
    !Number.isSafeInteger(unverifiedGraceSeconds) ||
    unverifiedGraceSeconds < 0
  ) {
    throw new CoordinatorError(
      "INVALID_QUARANTINE_IDENTITY",
      "legacy owner quarantine recovery time is invalid",
    );
  }
  const machineVerdict = quarantineMachineVerdict(evidence, {
    machineIdentity,
    host,
    rootIsPerMachine: rootIsPerMachine === true,
  });
  if (machineVerdict === "other") {
    return {
      action: "retain",
      machineVerdict,
      localPidChecked: false,
      reason: "other-machine",
      evidence,
    };
  }
  if (machineVerdict === "unverified" && rootIsPerMachine !== true) {
    return {
      action: "retain",
      machineVerdict,
      localPidChecked: false,
      reason: "unverified-shared-root",
      evidence,
    };
  }
  if (machineVerdict === "unverified") {
    const createdAtEpoch =
      evidence.createdAtEpoch ?? legacyCreatedAtEpoch ?? null;
    const ageSeconds =
      Number.isSafeInteger(createdAtEpoch) &&
      createdAtEpoch >= 1 &&
      createdAtEpoch <= nowEpoch
        ? nowEpoch - createdAtEpoch
        : null;
    if (ageSeconds === null || ageSeconds < unverifiedGraceSeconds) {
      return {
        action: "retain",
        machineVerdict,
        localPidChecked: false,
        reason: ageSeconds === null ? "unverified-age" : "unverified-grace",
        ageSeconds,
        evidence,
      };
    }
  }
  const mayOwn = creatorMayOwn(evidence.pid);
  return {
    action: mayOwn ? "retain" : "recover",
    machineVerdict,
    localPidChecked: true,
    reason: mayOwn ? "creator-live" : "creator-dead",
    evidence,
  };
}

function ownerFieldsFromText(value) {
  const fields = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0)
      fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
}

function legacyOwnerAuthorityToken(fields) {
  return fields.coordinator_token || fields.token;
}

function requireNoFollowSupport() {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      "this platform does not provide O_NOFOLLOW for legacy owner validation",
    );
  }
}

function requireCurrentUserRegularFile(
  stat,
  label = "legacy owner",
  expectedUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : null,
) {
  if (!stat.isFile()) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      `${label} is not a regular file`,
    );
  }
  if (expectedUid !== null && stat.uid !== expectedUid) {
    throw new CoordinatorError(
      "LEGACY_LOCK_FOREIGN_OWNER",
      `${label} is not a current-user regular file`,
    );
  }
}

function sameInode(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function quarantineHostFingerprint() {
  return createHash("sha256").update(hostname(), "utf8").digest("hex");
}

function currentUserOwnerSnapshot(path, afterRead = null, expectedUid = null) {
  let descriptor;
  let pathDescriptor;
  try {
    requireNoFollowSupport();
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    const requiredUid =
      expectedUid ??
      (typeof process.getuid === "function" ? BigInt(process.getuid()) : null);
    requireCurrentUserRegularFile(before, "legacy owner", requiredUid);
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    requireCurrentUserRegularFile(after, "legacy owner", requiredUid);
    if (!sameInode(before, after)) {
      throw new CoordinatorError(
        "LEGACY_LOCK_UNSAFE",
        "legacy owner identity changed while it was read",
      );
    }
    if (afterRead) afterRead({ path, stat: after });
    pathDescriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const pathStat = fstatSync(pathDescriptor, { bigint: true });
    requireCurrentUserRegularFile(pathStat, "legacy owner", requiredUid);
    if (!sameInode(after, pathStat)) {
      throw new CoordinatorError(
        "LEGACY_LOCK_UNSAFE",
        "legacy owner pathname changed while it was read",
      );
    }
    const uidLines = text.match(/^uid=.*$/gm) ?? [];
    const coordinatorTokenLines = text.match(/^coordinator_token=.*$/gm) ?? [];
    const tokenLines = text.match(/^token=.*$/gm) ?? [];
    if (
      uidLines.length > 1 ||
      coordinatorTokenLines.length > 1 ||
      tokenLines.length > 1
    ) {
      throw new CoordinatorError(
        "LEGACY_LOCK_UNSAFE",
        "legacy owner contains duplicate authority fields",
      );
    }
    const fields = ownerFieldsFromText(text);
    if (uidLines.length === 1) {
      const currentUid = process.getuid?.();
      if (!/^(?:0|[1-9][0-9]*)$/.test(fields.uid ?? "")) {
        throw new CoordinatorError(
          "LEGACY_LOCK_FOREIGN_OWNER",
          "legacy owner uid metadata is invalid",
        );
      }
      if (currentUid !== undefined && fields.uid !== String(currentUid)) {
        throw new CoordinatorError(
          "LEGACY_LOCK_FOREIGN_OWNER",
          "legacy owner uid does not match the current user",
        );
      }
    }
    return { fields, stat: after, text };
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    if (error.code === "ENOENT") throw error;
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      `could not read one stable legacy owner: ${error.message}`,
    );
  } finally {
    if (pathDescriptor !== undefined) closeSync(pathDescriptor);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function pathMatchesSnapshot(path, snapshot) {
  try {
    const stat = lstatSync(path, { bigint: true });
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === snapshot.stat.dev &&
      stat.ino === snapshot.stat.ino
    );
  } catch {
    return false;
  }
}

function requireMatchingOwnerSnapshot(snapshot, expected, phase) {
  if (
    !sameInode(snapshot.stat, expected.stat) ||
    snapshot.text !== expected.text ||
    legacyOwnerAuthorityToken(snapshot.fields) !==
      legacyOwnerAuthorityToken(expected.fields)
  ) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      `legacy owner inode or authority changed during ${phase}`,
    );
  }
}

function requireMatchingMarkerSnapshot(
  snapshot,
  expectedStat,
  expectedText,
  phase,
) {
  if (
    !sameInode(snapshot.stat, expectedStat) ||
    snapshot.text !== expectedText
  ) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      `legacy holder marker inode or content changed during ${phase}`,
    );
  }
}

export function ownerFields(path) {
  if (!existsSync(path)) return {};
  return ownerFieldsFromText(readFileSync(path, "utf8"));
}

export function legacyOwnerRecordText(record) {
  // Old Bash readers fetch fields in separate processes. Keeping start_utc
  // empty makes every old/new snapshot combination fall back to PID liveness.
  // New coordinators read coordinator_start_utc from one file snapshot.
  return [
    `pid=${record.pid}`,
    `uid=${record.uid ?? ""}`,
    `host=${record.host}`,
    `machine=${record.machineIdentity ?? ""}`,
    `started_at=${record.startedAt}`,
    "start_utc=",
    `coordinator_start_utc=${record.startUtc}`,
    `worktree=${record.worktree}`,
    `coordinator_token=${record.token}`,
    `token=${LEGACY_COORDINATOR_OWNER_IDENTITY}`,
    "",
  ].join("\n");
}

function writeText(path, value, mode = 0o600) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, value, "utf8");
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeOwner(path, record) {
  writeText(path, legacyOwnerRecordText(record));
}

function legacyOwnerCompatibilityMode(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      "legacy owner is not a regular file",
    );
  }
  return 0o600 | (stat.mode & 0o044);
}

function setTextMode(path, mode) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new CoordinatorError(
        "LEGACY_LOCK_UNSAFE",
        "legacy owner stage is not a current-user regular file",
      );
    }
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requirePrivateQuarantineDirectory(
  path,
  expectedStat = null,
  expectedUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : null,
) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (expectedUid !== null && stat.uid !== expectedUid) ||
    (stat.mode & 0o777n) !== 0o700n ||
    (expectedStat && !sameInode(stat, expectedStat))
  ) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      `legacy owner quarantine is not one current-user mode-0700 directory: ${path}`,
    );
  }
  return stat;
}

function createOwnerQuarantine(
  lockDirectory,
  expectedUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : null,
  quarantinePrefix = OWNER_QUARANTINE_PREFIX,
  machineIdentity = "",
) {
  requireNoFollowSupport();
  if (!Number.isInteger(constants.O_DIRECTORY)) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      "this platform does not provide O_DIRECTORY for owner quarantine",
    );
  }
  const name =
    quarantinePrefix === OWNER_QUARANTINE_PREFIX
      ? legacyOwnerQuarantineName({ machineIdentity })
      : `${quarantinePrefix}.${quarantineHostFingerprint()}.${process.pid}.${randomUUID()}`;
  const path = join(lockDirectory, name);
  mkdirSync(path, { mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let stat = fstatSync(descriptor, { bigint: true });
    if (
      !stat.isDirectory() ||
      (expectedUid !== null && stat.uid !== expectedUid)
    ) {
      throw new CoordinatorError(
        "LEGACY_LOCK_UNSAFE",
        "legacy owner quarantine is not a current-user directory",
      );
    }
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
    stat = fstatSync(descriptor, { bigint: true });
    requirePrivateQuarantineDirectory(path, stat, expectedUid);
    return { path, stat };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function quarantineAndDiscardOwner({
  sourcePath,
  expectedSnapshot,
  lockDirectory,
  sourceDirectory = lockDirectory,
  canonicalPath = null,
  phase,
  shouldTake = null,
  afterWitness = null,
  beforeTake = null,
  afterTake = null,
  quarantinePrefix = OWNER_QUARANTINE_PREFIX,
  machineIdentity = "",
}) {
  const expectedToken =
    legacyOwnerAuthorityToken(expectedSnapshot.fields) ?? "";
  const expectedUid = expectedSnapshot.stat.uid;
  const initial = currentUserOwnerSnapshot(sourcePath, null, expectedUid);
  requireMatchingOwnerSnapshot(initial, expectedSnapshot, phase);
  const quarantine = createOwnerQuarantine(
    lockDirectory,
    expectedUid,
    quarantinePrefix,
    machineIdentity,
  );
  const anchorPath = join(quarantine.path, "anchor");
  const takenPath = join(quarantine.path, "record");
  const fallbackPath = join(quarantine.path, "fallback-ready");
  let evidenceCreated = false;
  try {
    linkSync(sourcePath, anchorPath);
    evidenceCreated = true;
    fsyncDirectory(quarantine.path);
    const anchorSnapshot = currentUserOwnerSnapshot(
      anchorPath,
      null,
      expectedUid,
    );
    requireMatchingOwnerSnapshot(anchorSnapshot, expectedSnapshot, phase);
    if (afterWitness) {
      afterWitness({
        sourcePath,
        quarantinePath: quarantine.path,
        anchorPath,
        takenPath,
      });
    }
    const witnessedCanonicalPath =
      typeof canonicalPath === "function" ? canonicalPath() : canonicalPath;
    if (witnessedCanonicalPath) {
      const canonicalSnapshot = currentUserOwnerSnapshot(
        witnessedCanonicalPath,
        null,
        expectedUid,
      );
      requireMatchingOwnerSnapshot(canonicalSnapshot, expectedSnapshot, phase);
    }
    if (
      shouldTake &&
      !shouldTake({
        sourcePath,
        quarantinePath: quarantine.path,
        anchorPath,
        takenPath,
      })
    ) {
      const currentSource = currentUserOwnerSnapshot(
        sourcePath,
        null,
        expectedUid,
      );
      requireMatchingOwnerSnapshot(currentSource, expectedSnapshot, phase);
      unlinkSync(anchorPath);
      fsyncDirectory(quarantine.path);
      rmdirSync(quarantine.path);
      fsyncDirectory(lockDirectory);
      return false;
    }
    writeText(fallbackPath, `${expectedToken}\n`);
    fsyncDirectory(quarantine.path);
    if (beforeTake) {
      beforeTake({
        sourcePath,
        quarantinePath: quarantine.path,
        anchorPath,
        takenPath,
      });
    }
    renameSync(sourcePath, takenPath);
    if (sourceDirectory !== lockDirectory) fsyncDirectory(sourceDirectory);
    fsyncDirectory(lockDirectory);
    fsyncDirectory(quarantine.path);
    const takenSnapshot = currentUserOwnerSnapshot(
      takenPath,
      null,
      expectedUid,
    );
    requireMatchingOwnerSnapshot(takenSnapshot, expectedSnapshot, phase);
    if (afterTake) {
      afterTake({
        sourcePath,
        quarantinePath: quarantine.path,
        anchorPath,
        takenPath,
      });
    }
    const verifiedTaken = currentUserOwnerSnapshot(
      takenPath,
      null,
      expectedUid,
    );
    requireMatchingOwnerSnapshot(verifiedTaken, expectedSnapshot, phase);
    requirePrivateQuarantineDirectory(
      quarantine.path,
      quarantine.stat,
      expectedUid,
    );
    const finalCanonicalPath =
      typeof canonicalPath === "function" ? canonicalPath() : canonicalPath;
    if (finalCanonicalPath) {
      const canonicalSnapshot = currentUserOwnerSnapshot(
        finalCanonicalPath,
        null,
        expectedUid,
      );
      requireMatchingOwnerSnapshot(canonicalSnapshot, expectedSnapshot, phase);
    }
    if (pathEntryExists(sourcePath)) {
      throw new CoordinatorError(
        "LEGACY_LOCK_UNSAFE",
        `replacement legacy owner evidence appeared after ${phase}; retained ${sourcePath}`,
      );
    }
    unlinkSync(takenPath);
    unlinkSync(anchorPath);
    unlinkSync(fallbackPath);
    fsyncDirectory(quarantine.path);
    rmdirSync(quarantine.path);
    fsyncDirectory(lockDirectory);
    return true;
  } catch (error) {
    if (!evidenceCreated) {
      try {
        if (readdirSync(quarantine.path).length === 0) {
          rmdirSync(quarantine.path);
          fsyncDirectory(lockDirectory);
        }
      } catch {
        // Retain any path that is no longer the empty quarantine we created.
      }
    }
    throw error;
  }
}

function processMayOwnInertStage(pid) {
  const snapshot = processSnapshot(pid);
  if (snapshot) return !snapshot.state.startsWith("Z");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function removeInertLegacyOwnerStages(
  lockDirectory,
  {
    publisherMayOwn = processMayOwnInertStage,
    beforeWitnessedPublisherCheck = null,
    machineIdentity = "",
  } = {},
) {
  let removed = false;
  for (const name of readdirSync(lockDirectory)) {
    if (!/^owner\.(?:claiming|coordinator|rollback)\.[1-9][0-9]*$/.test(name)) {
      continue;
    }
    const path = join(lockDirectory, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      continue;
    }
    const stagePid = Number(name.slice(name.lastIndexOf(".") + 1));
    if (publisherMayOwn(stagePid)) continue;
    let ownerSnapshot;
    try {
      ownerSnapshot = currentUserOwnerSnapshot(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const stageRemoved = quarantineAndDiscardOwner({
      sourcePath: path,
      expectedSnapshot: ownerSnapshot,
      lockDirectory,
      phase: "inert owner stage cleanup",
      machineIdentity,
      // Recheck after the hard-link witness binds the stage inode. A reused
      // PID can publish a new stage after the first liveness verdict.
      shouldTake: (context) => {
        if (beforeWitnessedPublisherCheck) {
          beforeWitnessedPublisherCheck({ ...context, stagePid });
        }
        return !publisherMayOwn(stagePid);
      },
    });
    if (stageRemoved) removed = true;
  }
  if (removed) fsyncDirectory(lockDirectory);
}

function validateLegacyLockRoot(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      `cannot inspect the legacy lock root: ${error.message}`,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      "legacy lock root is not a real directory",
    );
  }
  try {
    accessSync(path, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      `legacy lock root is not writable: ${error.message}`,
    );
  }
}

function recordCondemnedRun(lockRoot, token) {
  validateLegacyToken(token, "condemned run token");
  const directory = join(lockRoot, "condemned.d");
  try {
    mkdirSync(directory, { mode: 0o770 });
    fsyncDirectory(lockRoot);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw new CoordinatorError(
        "LEGACY_OBLIGATION_UNWRITABLE",
        `could not create the condemned-run directory: ${error.message}`,
      );
    }
  }
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new CoordinatorError(
      "LEGACY_OBLIGATION_UNWRITABLE",
      "condemned.d is not a real directory",
    );
  }
  const stagedPath = join(
    directory,
    `.staging.coordinator.${process.pid}.${randomUUID()}`,
  );
  try {
    writeText(stagedPath, `${token}\n`);
    renameSync(stagedPath, join(directory, token));
    fsyncDirectory(directory);
  } catch (error) {
    if (existsSync(stagedPath)) unlinkSync(stagedPath);
    throw new CoordinatorError(
      "LEGACY_OBLIGATION_UNWRITABLE",
      `could not record the condemned run: ${error.message}`,
    );
  }
}

function restoreTakenOwner(
  takenPath,
  ownerPath,
  lockDirectory,
  lockRoot,
  expectedSnapshot = null,
  {
    quarantineDirectory = lockDirectory,
    sourceDirectory = lockDirectory,
    condemnOnConflict = true,
    machineIdentity = "",
    ...discardHooks
  } = {},
) {
  const takenSnapshot = expectedSnapshot ?? currentUserOwnerSnapshot(takenPath);
  const discardAfterWitness = discardHooks.afterWitness ?? null;
  let restored = false;
  quarantineAndDiscardOwner({
    ...discardHooks,
    sourcePath: takenPath,
    expectedSnapshot: takenSnapshot,
    lockDirectory: quarantineDirectory,
    sourceDirectory,
    canonicalPath: () => (restored ? ownerPath : null),
    phase: "owner restoration cleanup",
    machineIdentity,
    afterWitness: (context) => {
      try {
        // Publish from the verified hard-link witness. A replacement at the
        // source pathname can never become the restored canonical owner.
        linkSync(context.anchorPath, ownerPath);
        fsyncDirectory(lockDirectory);
        restored = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (pathMatchesSnapshot(ownerPath, takenSnapshot)) {
          restored = true;
        } else if (condemnOnConflict) {
          recordCondemnedRun(
            lockRoot,
            legacyOwnerAuthorityToken(takenSnapshot.fields),
          );
        }
      }
      if (restored) {
        const restoredSnapshot = currentUserOwnerSnapshot(
          ownerPath,
          null,
          takenSnapshot.stat.uid,
        );
        requireMatchingOwnerSnapshot(
          restoredSnapshot,
          takenSnapshot,
          "owner restoration",
        );
      }
      if (discardAfterWitness) {
        discardAfterWitness({ ...context, restored });
      }
    },
  });
  return restored;
}

function takeExpectedOwner({
  lockRoot,
  lockDirectory,
  ownerPath,
  expectedToken,
  phase,
  machineIdentity = "",
}) {
  const expectedSnapshot = currentUserOwnerSnapshot(ownerPath);
  if (legacyOwnerAuthorityToken(expectedSnapshot.fields) !== expectedToken) {
    throw new CoordinatorError(
      "LEGACY_HANDOFF_MISMATCH",
      `legacy owner changed before ${phase}`,
    );
  }
  const takenPath = join(
    lockDirectory,
    `owner.reclaiming.coordinator.${process.pid}.${randomUUID()}`,
  );
  try {
    renameSync(ownerPath, takenPath);
    fsyncDirectory(lockDirectory);
  } catch (error) {
    throw new CoordinatorError(
      "LEGACY_HANDOFF_MISMATCH",
      `legacy owner could not be taken for ${phase}: ${error.message}`,
    );
  }
  let snapshot;
  try {
    snapshot = currentUserOwnerSnapshot(takenPath);
  } catch (error) {
    restoreTakenOwner(takenPath, ownerPath, lockDirectory, lockRoot, null, {
      machineIdentity,
    });
    throw error;
  }
  if (
    legacyOwnerAuthorityToken(snapshot.fields) === expectedToken &&
    sameInode(snapshot.stat, expectedSnapshot.stat)
  ) {
    return { path: takenPath, snapshot };
  }
  restoreTakenOwner(takenPath, ownerPath, lockDirectory, lockRoot, snapshot, {
    machineIdentity,
  });
  throw new CoordinatorError(
    "LEGACY_HANDOFF_MISMATCH",
    `legacy owner changed during ${phase}`,
  );
}

export function socketPathForRoot(root) {
  const path = join(resolve(root), "coordinator.sock");
  if (Buffer.byteLength(path) > 100) {
    throw new CoordinatorError(
      "SOCKET_PATH_TOO_LONG",
      `coordinator socket path exceeds 100 bytes: ${path}`,
    );
  }
  return path;
}

export function adoptLegacyRunLock({
  lockRoot,
  expectedOwnerToken,
  generationToken,
  coordinatorIdentity,
  machineIdentity = "",
  worktree = "quality-gate-coordinator",
  beforeOwnerStageModeSet = null,
  beforeOwnerPublish = null,
  beforeOwnerDiscardTake = null,
  afterOwnerDiscardTake = null,
  afterAuthorityOwnerRead = null,
  afterAuthorityMarkerRead = null,
  afterMarkerDiscardWitness = null,
  beforeMarkerDiscardTake = null,
  afterMarkerDiscardTake = null,
  beforeReleaseOwnerTake = null,
  afterReleaseOwnerVisibleTake = null,
  afterReleaseOwnerTake = null,
  beforeReleaseOwnerRestore = null,
  inertStagePublisherMayOwn = processMayOwnInertStage,
  beforeInertStagePublisherCheck = null,
}) {
  validateLegacyToken(expectedOwnerToken, "expected legacy owner token");
  validateLegacyToken(generationToken, "coordinator generation token");
  validateLegacyMachineIdentity(machineIdentity);
  validateLegacyLockRoot(lockRoot);
  const lockDirectory = join(lockRoot, "run.lock");
  const stat = lstatSync(lockDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CoordinatorError(
      "LEGACY_LOCK_UNSAFE",
      "run.lock is not a real directory",
    );
  }
  const ownerPath = join(lockDirectory, "owner");
  let previousOwnerText = "";
  const markerPath = join(lockRoot, `holder.${generationToken}`);
  const markerText = `${generationToken}\n`;
  let markerDescriptor;
  let markerDescriptorStat = null;
  let publishedMarkerSnapshot = null;
  let markerOpen = false;

  function closeMarker() {
    if (!markerOpen) return;
    closeSync(markerDescriptor);
    markerOpen = false;
  }

  function discardMarkerSnapshot(expectedSnapshot, phase) {
    return quarantineAndDiscardOwner({
      sourcePath: markerPath,
      expectedSnapshot,
      lockDirectory: lockRoot,
      sourceDirectory: lockRoot,
      phase,
      quarantinePrefix: HOLDER_QUARANTINE_PREFIX,
      afterWitness: afterMarkerDiscardWitness
        ? (context) =>
            afterMarkerDiscardWitness({ ...context, markerPath, phase })
        : null,
      beforeTake: beforeMarkerDiscardTake
        ? (context) =>
            beforeMarkerDiscardTake({ ...context, markerPath, phase })
        : null,
      afterTake: afterMarkerDiscardTake
        ? (context) => afterMarkerDiscardTake({ ...context, markerPath, phase })
        : null,
    });
  }

  function discardCreatedMarkerIfStillPublished(phase) {
    if (
      markerDescriptorStat === null ||
      !pathMatchesSnapshot(markerPath, { stat: markerDescriptorStat })
    ) {
      return false;
    }
    let currentSnapshot;
    try {
      currentSnapshot = currentUserOwnerSnapshot(
        markerPath,
        null,
        markerDescriptorStat.uid,
      );
    } catch (error) {
      if (!pathMatchesSnapshot(markerPath, { stat: markerDescriptorStat })) {
        return false;
      }
      throw error;
    }
    if (!sameInode(currentSnapshot.stat, markerDescriptorStat)) return false;
    return discardMarkerSnapshot(currentSnapshot, phase);
  }

  function discardPublishedMarker(phase) {
    const currentSnapshot = currentUserOwnerSnapshot(
      markerPath,
      null,
      publishedMarkerSnapshot.stat.uid,
    );
    requireMatchingOwnerSnapshot(
      currentSnapshot,
      publishedMarkerSnapshot,
      phase,
    );
    return discardMarkerSnapshot(publishedMarkerSnapshot, phase);
  }

  try {
    markerDescriptor = openSync(markerPath, "wx", 0o600);
    markerOpen = true;
    markerDescriptorStat = fstatSync(markerDescriptor, { bigint: true });
    requireCurrentUserRegularFile(
      markerDescriptorStat,
      "legacy holder marker",
      markerDescriptorStat.uid,
    );
    writeFileSync(markerDescriptor, markerText, "utf8");
    fsyncSync(markerDescriptor);
    publishedMarkerSnapshot = currentUserOwnerSnapshot(
      markerPath,
      null,
      markerDescriptorStat.uid,
    );
    requireMatchingMarkerSnapshot(
      publishedMarkerSnapshot,
      markerDescriptorStat,
      markerText,
      "holder marker publication",
    );
    fsyncDirectory(lockRoot);
  } catch (error) {
    let failure = error;
    try {
      discardCreatedMarkerIfStillPublished(
        "failed holder marker publication cleanup",
      );
    } catch (cleanupError) {
      failure = cleanupError;
    } finally {
      closeMarker();
    }
    throw failure;
  }
  const stagedOwner = join(lockDirectory, `owner.coordinator.${process.pid}`);
  const record = {
    pid: coordinatorIdentity.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    host: hostname(),
    machineIdentity,
    startedAt: Math.floor(Date.now() / 1000),
    startUtc: coordinatorIdentity.startUtc,
    worktree,
    token: generationToken,
  };
  let published = false;
  let takenOwner = null;
  let publishedOwnerSnapshot = null;
  let previousOwnerMode = 0o600;
  let stagedOwnerSnapshot;
  try {
    writeOwner(stagedOwner, record);
    const taken = takeExpectedOwner({
      lockRoot,
      lockDirectory,
      ownerPath,
      expectedToken: expectedOwnerToken,
      phase: "coordinator handoff",
      machineIdentity,
    });
    takenOwner = taken;
    previousOwnerText = taken.snapshot.text;
    previousOwnerMode = legacyOwnerCompatibilityMode(taken.path);
    if (beforeOwnerStageModeSet) {
      beforeOwnerStageModeSet({ lockDirectory, ownerPath, stagedOwner });
    }
    setTextMode(stagedOwner, previousOwnerMode);
    stagedOwnerSnapshot = currentUserOwnerSnapshot(stagedOwner);
    if (beforeOwnerPublish) beforeOwnerPublish({ lockDirectory, ownerPath });
    try {
      linkSync(stagedOwner, ownerPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new CoordinatorError(
          "LEGACY_HANDOFF_MISMATCH",
          "another owner published during coordinator handoff",
        );
      }
      throw error;
    }
    fsyncDirectory(lockDirectory);
    published = true;
    publishedOwnerSnapshot = currentUserOwnerSnapshot(ownerPath);
    if (
      legacyOwnerAuthorityToken(publishedOwnerSnapshot.fields) !==
      generationToken
    ) {
      throw new CoordinatorError(
        "LEGACY_HANDOFF_FAILED",
        "coordinator owner record did not publish",
      );
    }
    requireMatchingOwnerSnapshot(
      publishedOwnerSnapshot,
      stagedOwnerSnapshot,
      "coordinator owner publication",
    );
    quarantineAndDiscardOwner({
      sourcePath: stagedOwner,
      expectedSnapshot: stagedOwnerSnapshot,
      lockDirectory,
      canonicalPath: ownerPath,
      phase: "coordinator owner stage cleanup",
      machineIdentity,
    });
    const priorOwner = takenOwner;
    takenOwner = null;
    quarantineAndDiscardOwner({
      sourcePath: priorOwner.path,
      expectedSnapshot: priorOwner.snapshot,
      lockDirectory,
      phase: "coordinator handoff owner cleanup",
      machineIdentity,
      beforeTake: beforeOwnerDiscardTake,
      afterTake: afterOwnerDiscardTake,
    });
  } catch (error) {
    let failure = error;
    try {
      if (pathEntryExists(stagedOwner)) {
        const stagedSnapshot = currentUserOwnerSnapshot(stagedOwner);
        quarantineAndDiscardOwner({
          sourcePath: stagedOwner,
          expectedSnapshot: stagedSnapshot,
          lockDirectory,
          phase: "failed coordinator owner stage cleanup",
          machineIdentity,
        });
      }
      if (takenOwner && pathEntryExists(takenOwner.path)) {
        restoreTakenOwner(
          takenOwner.path,
          ownerPath,
          lockDirectory,
          lockRoot,
          takenOwner.snapshot,
          { machineIdentity },
        );
      }
    } catch (recoveryError) {
      failure = recoveryError;
    }
    try {
      closeMarker();
      if (!published && pathEntryExists(markerPath)) {
        discardPublishedMarker("failed coordinator adoption marker cleanup");
      }
    } catch (recoveryError) {
      failure = recoveryError;
    }
    throw failure;
  }

  function authority() {
    let observed = {};
    let ownerCurrentUser = false;
    let ownerSnapshot = null;
    try {
      ownerSnapshot = currentUserOwnerSnapshot(
        ownerPath,
        afterAuthorityOwnerRead,
      );
      observed = ownerSnapshot.fields;
      ownerCurrentUser = true;
    } catch (error) {
      if (
        error.code !== "ENOENT" &&
        error.code !== "LEGACY_LOCK_FOREIGN_OWNER"
      ) {
        throw error;
      }
    }
    let markerValid = false;
    if (markerOpen && publishedMarkerSnapshot !== null) {
      try {
        const descriptorStat = fstatSync(markerDescriptor, { bigint: true });
        requireCurrentUserRegularFile(descriptorStat, "legacy holder marker");
        const markerSnapshot = currentUserOwnerSnapshot(
          markerPath,
          afterAuthorityMarkerRead,
        );
        markerValid =
          sameInode(descriptorStat, publishedMarkerSnapshot.stat) &&
          sameInode(markerSnapshot.stat, descriptorStat) &&
          markerSnapshot.text === markerText &&
          pathMatchesSnapshot(markerPath, markerSnapshot);
      } catch (error) {
        if (
          error.code !== "ENOENT" &&
          error.code !== "LEGACY_LOCK_FOREIGN_OWNER"
        ) {
          throw error;
        }
      }
    }
    const ownerPathStillPublished =
      ownerSnapshot !== null &&
      publishedOwnerSnapshot !== null &&
      sameInode(ownerSnapshot.stat, publishedOwnerSnapshot.stat) &&
      pathMatchesSnapshot(ownerPath, ownerSnapshot);
    return {
      owned:
        markerValid &&
        ownerCurrentUser &&
        ownerPathStillPublished &&
        legacyOwnerAuthorityToken(observed) === generationToken &&
        observed.pid === String(coordinatorIdentity.pid) &&
        observed.coordinator_start_utc === coordinatorIdentity.startUtc,
      lockRoot,
      lockDirectory,
      ownerPath,
      generationToken,
      markerPath,
      markerValid,
      owner: observed,
      ownerAuthorityToken: legacyOwnerAuthorityToken(observed) ?? null,
    };
  }
  function abandon() {
    closeMarker();
  }
  function rollbackHandoff() {
    const probe = authority();
    if (!probe.owned) {
      abandon();
      return { rolledBack: false, reason: "authority-lost", ...probe };
    }
    const staged = join(lockDirectory, `owner.rollback.${process.pid}`);
    let takenOwner = null;
    let stagedSnapshot;
    try {
      writeText(staged, previousOwnerText, previousOwnerMode);
      stagedSnapshot = currentUserOwnerSnapshot(staged);
      const taken = takeExpectedOwner({
        lockRoot,
        lockDirectory,
        ownerPath,
        expectedToken: generationToken,
        phase: "startup rollback",
        machineIdentity,
      });
      takenOwner = taken;
      linkSync(staged, ownerPath);
      fsyncDirectory(lockDirectory);
      const restoredPrevious = currentUserOwnerSnapshot(ownerPath);
      if (
        legacyOwnerAuthorityToken(restoredPrevious.fields) !==
        expectedOwnerToken
      ) {
        throw new CoordinatorError(
          "LEGACY_HANDOFF_FAILED",
          "previous legacy owner record did not publish during rollback",
        );
      }
      requireMatchingOwnerSnapshot(
        restoredPrevious,
        stagedSnapshot,
        "rollback owner publication",
      );
      quarantineAndDiscardOwner({
        sourcePath: staged,
        expectedSnapshot: stagedSnapshot,
        lockDirectory,
        canonicalPath: ownerPath,
        phase: "rollback owner stage cleanup",
        machineIdentity,
      });
      const coordinatorOwner = takenOwner;
      takenOwner = null;
      quarantineAndDiscardOwner({
        sourcePath: coordinatorOwner.path,
        expectedSnapshot: coordinatorOwner.snapshot,
        lockDirectory,
        phase: "rollback coordinator owner cleanup",
        machineIdentity,
      });
      closeMarker();
      if (pathEntryExists(markerPath)) {
        discardPublishedMarker("startup rollback marker cleanup");
      }
      return { rolledBack: true, generationToken };
    } catch (error) {
      if (takenOwner && pathEntryExists(takenOwner.path)) {
        restoreTakenOwner(
          takenOwner.path,
          ownerPath,
          lockDirectory,
          lockRoot,
          takenOwner.snapshot,
          { machineIdentity },
        );
      }
      abandon();
      return {
        rolledBack: false,
        reason: "rollback-failed",
        error: error.message,
      };
    } finally {
      if (pathEntryExists(staged)) {
        const remainingStage = currentUserOwnerSnapshot(staged);
        quarantineAndDiscardOwner({
          sourcePath: staged,
          expectedSnapshot: remainingStage,
          lockDirectory,
          phase: "rollback residual stage cleanup",
          machineIdentity,
        });
      }
    }
  }
  function releaseIfOwned() {
    const probe = authority();
    if (!probe.owned) {
      abandon();
      return { released: false, reason: "authority-lost", ...probe };
    }
    const releaseDirectory = join(
      lockRoot,
      `.owner-release.${process.pid}.${randomUUID()}`,
    );
    const releaseTaken = join(
      lockDirectory,
      `owner.reclaiming.release.coordinator.${process.pid}.${randomUUID()}`,
    );
    const releaseOwner = join(releaseDirectory, "owner");
    let privateReleaseSnapshot = null;
    const discardPrivateReleaseOwner = (phase) => {
      if (privateReleaseSnapshot === null) {
        throw new CoordinatorError(
          "LEGACY_LOCK_UNSAFE",
          "private coordinator owner release has no stable snapshot",
        );
      }
      quarantineAndDiscardOwner({
        sourcePath: releaseOwner,
        expectedSnapshot: privateReleaseSnapshot,
        lockDirectory: releaseDirectory,
        phase,
        machineIdentity,
      });
    };
    const settleSuccessorOwner = ({ ownerAlreadyDiscarded = false } = {}) => {
      try {
        if (!ownerAlreadyDiscarded) {
          discardPrivateReleaseOwner("successor settlement owner cleanup");
        }
        fsyncDirectory(releaseDirectory);
        rmdirSync(releaseDirectory);
        fsyncDirectory(lockRoot);
      } finally {
        abandon();
      }
      return { released: false, reason: "authority-changed", ...authority() };
    };
    let takenOwner = null;
    const expectedReleaseSnapshot = currentUserOwnerSnapshot(ownerPath);
    requireMatchingOwnerSnapshot(
      expectedReleaseSnapshot,
      publishedOwnerSnapshot,
      "coordinator owner release",
    );
    try {
      if (beforeReleaseOwnerTake) beforeReleaseOwnerTake({ ownerPath });
      // Keep an unvalidated take inside run.lock. Legacy recovery scans this
      // namespace, so a crash cannot hide a live successor in private state.
      renameSync(ownerPath, releaseTaken);
      takenOwner = { path: releaseTaken, snapshot: expectedReleaseSnapshot };
      fsyncDirectory(lockDirectory);
      if (afterReleaseOwnerVisibleTake)
        afterReleaseOwnerVisibleTake({ ownerPath, releaseTaken });
      const visibleReleaseSnapshot = currentUserOwnerSnapshot(releaseTaken);
      if (
        legacyOwnerAuthorityToken(visibleReleaseSnapshot.fields) !==
          generationToken ||
        !sameInode(visibleReleaseSnapshot.stat, expectedReleaseSnapshot.stat)
      ) {
        restoreTakenOwner(
          releaseTaken,
          ownerPath,
          lockDirectory,
          lockRoot,
          visibleReleaseSnapshot,
          { machineIdentity },
        );
        takenOwner = null;
        abandon();
        return { released: false, reason: "authority-changed", ...authority() };
      }
      mkdirSync(releaseDirectory, { mode: 0o700 });
      fsyncDirectory(lockRoot);
      renameSync(releaseTaken, releaseOwner);
      privateReleaseSnapshot = currentUserOwnerSnapshot(releaseOwner);
      requireMatchingOwnerSnapshot(
        privateReleaseSnapshot,
        expectedReleaseSnapshot,
        "private coordinator owner release",
      );
      takenOwner = { path: releaseOwner, snapshot: privateReleaseSnapshot };
      fsyncDirectory(lockDirectory);
      fsyncDirectory(releaseDirectory);
      if (afterReleaseOwnerTake)
        afterReleaseOwnerTake({ ownerPath, releaseOwner });
      const verifiedPrivateReleaseSnapshot = currentUserOwnerSnapshot(
        releaseOwner,
        null,
        privateReleaseSnapshot.stat.uid,
      );
      requireMatchingOwnerSnapshot(
        verifiedPrivateReleaseSnapshot,
        privateReleaseSnapshot,
        "private coordinator owner release hook",
      );
    } catch (error) {
      let failure = error;
      if (
        takenOwner &&
        pathEntryExists(takenOwner.path) &&
        existsSync(lockDirectory)
      ) {
        try {
          restoreTakenOwner(
            takenOwner.path,
            ownerPath,
            lockDirectory,
            lockRoot,
            takenOwner.snapshot,
            takenOwner.path === releaseOwner
              ? {
                  quarantineDirectory: releaseDirectory,
                  sourceDirectory: releaseDirectory,
                  condemnOnConflict: false,
                  machineIdentity,
                }
              : { machineIdentity },
          );
          if (
            takenOwner.path === releaseOwner &&
            existsSync(releaseDirectory)
          ) {
            fsyncDirectory(releaseDirectory);
          }
        } catch (recoveryError) {
          failure = recoveryError;
        }
      }
      try {
        if (existsSync(releaseDirectory)) rmdirSync(releaseDirectory);
      } catch {
        // Retain non-empty private recovery evidence.
      }
      fsyncDirectory(lockRoot);
      abandon();
      throw failure;
    }
    try {
      // These exact paths are unpublished owner stages. Remove only stages
      // whose publishing PID is gone. A live handoff or rollback still needs
      // its stage and must make this release restore or yield its owner.
      removeInertLegacyOwnerStages(lockDirectory, {
        publisherMayOwn: inertStagePublisherMayOwn,
        beforeWitnessedPublisherCheck: beforeInertStagePublisherCheck,
        machineIdentity,
      });
      rmdirSync(lockDirectory);
    } catch (error) {
      if (existsSync(ownerPath)) {
        return settleSuccessorOwner();
      }
      try {
        if (beforeReleaseOwnerRestore)
          beforeReleaseOwnerRestore({ ownerPath, releaseOwner });
        const restored = restoreTakenOwner(
          releaseOwner,
          ownerPath,
          lockDirectory,
          lockRoot,
          privateReleaseSnapshot,
          {
            quarantineDirectory: releaseDirectory,
            sourceDirectory: releaseDirectory,
            condemnOnConflict: false,
            machineIdentity,
          },
        );
        if (!restored) {
          return settleSuccessorOwner({ ownerAlreadyDiscarded: true });
        }
      } catch (restoreError) {
        abandon();
        throw new CoordinatorError(
          "LEGACY_RELEASE_FAILED",
          `could not remove legacy run.lock: ${error.message}; owner restoration failed: ${restoreError.message}`,
        );
      }
      fsyncDirectory(releaseDirectory);
      rmdirSync(releaseDirectory);
      fsyncDirectory(lockRoot);
      abandon();
      throw new CoordinatorError(
        "LEGACY_RELEASE_FAILED",
        `could not remove legacy run.lock: ${error.message}`,
      );
    }
    fsyncDirectory(lockRoot);
    try {
      discardPrivateReleaseOwner("private coordinator owner release cleanup");
      fsyncDirectory(releaseDirectory);
      closeMarker();
      if (pathEntryExists(markerPath)) {
        discardPublishedMarker("coordinator release marker cleanup");
      }
      rmdirSync(releaseDirectory);
      fsyncDirectory(lockRoot);
    } catch (error) {
      abandon();
      throw error;
    }
    return { released: true, generationToken };
  }
  return {
    authority,
    abandon,
    rollbackHandoff,
    releaseIfOwned,
    record,
    markerPath,
    generationToken,
  };
}
