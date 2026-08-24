import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
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

function ownerFieldsFromText(value) {
  const fields = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0)
      fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
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
    `host=${record.host}`,
    `started_at=${record.startedAt}`,
    "start_utc=",
    `coordinator_start_utc=${record.startUtc}`,
    `worktree=${record.worktree}`,
    `token=${record.token}`,
    "",
  ].join("\n");
}

function writeText(path, value) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, value, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeOwner(path, record) {
  writeText(path, legacyOwnerRecordText(record));
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeInertLegacyOwnerStages(lockDirectory) {
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
    const snapshot = processSnapshot(stagePid);
    if (snapshot && !snapshot.state.startsWith("Z")) continue;
    if (!snapshot) {
      try {
        process.kill(stagePid, 0);
        continue;
      } catch (error) {
        if (error.code !== "ESRCH") continue;
      }
    }
    try {
      unlinkSync(path);
      removed = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
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

function restoreTakenOwner(takenPath, ownerPath, lockDirectory, lockRoot) {
  try {
    linkSync(takenPath, ownerPath);
    fsyncDirectory(lockDirectory);
  } catch (error) {
    if (error.code === "EEXIST") {
      recordCondemnedRun(lockRoot, ownerFields(takenPath).token);
      unlinkSync(takenPath);
      fsyncDirectory(lockDirectory);
      return false;
    }
    throw error;
  }
  unlinkSync(takenPath);
  fsyncDirectory(lockDirectory);
  return true;
}

function takeExpectedOwner({
  lockRoot,
  lockDirectory,
  ownerPath,
  expectedToken,
  phase,
}) {
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
  if (ownerFields(takenPath).token === expectedToken) return takenPath;
  restoreTakenOwner(takenPath, ownerPath, lockDirectory, lockRoot);
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
  worktree = "quality-gate-coordinator",
  beforeOwnerPublish = null,
  beforeReleaseOwnerTake = null,
  afterReleaseOwnerVisibleTake = null,
  afterReleaseOwnerTake = null,
  beforeReleaseOwnerRestore = null,
}) {
  validateLegacyToken(expectedOwnerToken, "expected legacy owner token");
  validateLegacyToken(generationToken, "coordinator generation token");
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
  const previousOwnerText = readFileSync(ownerPath, "utf8");
  if (ownerFieldsFromText(previousOwnerText).token !== expectedOwnerToken) {
    throw new CoordinatorError(
      "LEGACY_HANDOFF_MISMATCH",
      "legacy owner token changed before coordinator handoff",
    );
  }
  const markerPath = join(lockRoot, `holder.${generationToken}`);
  let markerDescriptor;
  try {
    markerDescriptor = openSync(markerPath, "wx", 0o600);
    writeFileSync(markerDescriptor, `${generationToken}\n`, "utf8");
    fsyncSync(markerDescriptor);
    fsyncDirectory(lockRoot);
  } catch (error) {
    if (markerDescriptor !== undefined) closeSync(markerDescriptor);
    if (existsSync(markerPath)) unlinkSync(markerPath);
    throw error;
  }
  const stagedOwner = join(lockDirectory, `owner.coordinator.${process.pid}`);
  const record = {
    pid: coordinatorIdentity.pid,
    host: hostname(),
    startedAt: Math.floor(Date.now() / 1000),
    startUtc: coordinatorIdentity.startUtc,
    worktree,
    token: generationToken,
  };
  let published = false;
  let takenOwner = null;
  try {
    writeOwner(stagedOwner, record);
    takenOwner = takeExpectedOwner({
      lockRoot,
      lockDirectory,
      ownerPath,
      expectedToken: expectedOwnerToken,
      phase: "coordinator handoff",
    });
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
    if (ownerFields(ownerPath).token !== generationToken) {
      throw new CoordinatorError(
        "LEGACY_HANDOFF_FAILED",
        "coordinator owner record did not publish",
      );
    }
    unlinkSync(stagedOwner);
    unlinkSync(takenOwner);
    takenOwner = null;
    fsyncDirectory(lockDirectory);
  } catch (error) {
    let failure = error;
    try {
      if (existsSync(stagedOwner)) unlinkSync(stagedOwner);
      if (takenOwner && existsSync(takenOwner)) {
        restoreTakenOwner(takenOwner, ownerPath, lockDirectory, lockRoot);
      }
    } catch (recoveryError) {
      failure = recoveryError;
    } finally {
      closeSync(markerDescriptor);
      if (!published && existsSync(markerPath)) unlinkSync(markerPath);
    }
    throw failure;
  }

  let markerOpen = true;
  function authority() {
    const observed = ownerFields(ownerPath);
    let markerValid;
    try {
      markerValid = readFileSync(markerPath, "utf8").trim() === generationToken;
    } catch {
      markerValid = false;
    }
    return {
      owned:
        markerValid &&
        observed.token === generationToken &&
        observed.pid === String(coordinatorIdentity.pid) &&
        observed.coordinator_start_utc === coordinatorIdentity.startUtc,
      lockRoot,
      lockDirectory,
      ownerPath,
      generationToken,
      markerPath,
      markerValid,
      owner: observed,
    };
  }
  function closeMarker() {
    if (!markerOpen) return;
    closeSync(markerDescriptor);
    markerOpen = false;
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
    try {
      writeText(staged, previousOwnerText);
      takenOwner = takeExpectedOwner({
        lockRoot,
        lockDirectory,
        ownerPath,
        expectedToken: generationToken,
        phase: "startup rollback",
      });
      linkSync(staged, ownerPath);
      fsyncDirectory(lockDirectory);
      if (ownerFields(ownerPath).token !== expectedOwnerToken) {
        throw new CoordinatorError(
          "LEGACY_HANDOFF_FAILED",
          "previous legacy owner record did not publish during rollback",
        );
      }
      unlinkSync(staged);
      unlinkSync(takenOwner);
      takenOwner = null;
      fsyncDirectory(lockDirectory);
      closeMarker();
      if (
        existsSync(markerPath) &&
        readFileSync(markerPath, "utf8").trim() === generationToken
      ) {
        unlinkSync(markerPath);
        fsyncDirectory(lockRoot);
      }
      return { rolledBack: true, generationToken };
    } catch (error) {
      if (takenOwner && existsSync(takenOwner)) {
        restoreTakenOwner(takenOwner, ownerPath, lockDirectory, lockRoot);
      }
      abandon();
      return {
        rolledBack: false,
        reason: "rollback-failed",
        error: error.message,
      };
    } finally {
      if (existsSync(staged)) unlinkSync(staged);
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
    const settleSuccessorOwner = () => {
      unlinkSync(releaseOwner);
      fsyncDirectory(releaseDirectory);
      rmdirSync(releaseDirectory);
      fsyncDirectory(lockRoot);
      abandon();
      return { released: false, reason: "authority-changed", ...authority() };
    };
    let takenOwner = null;
    try {
      if (beforeReleaseOwnerTake) beforeReleaseOwnerTake({ ownerPath });
      // Keep an unvalidated take inside run.lock. Legacy recovery scans this
      // namespace, so a crash cannot hide a live successor in private state.
      renameSync(ownerPath, releaseTaken);
      takenOwner = releaseTaken;
      fsyncDirectory(lockDirectory);
      if (afterReleaseOwnerVisibleTake)
        afterReleaseOwnerVisibleTake({ ownerPath, releaseTaken });
      if (ownerFields(releaseTaken).token !== generationToken) {
        restoreTakenOwner(releaseTaken, ownerPath, lockDirectory, lockRoot);
        takenOwner = null;
        abandon();
        return { released: false, reason: "authority-changed", ...authority() };
      }
      mkdirSync(releaseDirectory, { mode: 0o700 });
      fsyncDirectory(lockRoot);
      renameSync(releaseTaken, releaseOwner);
      takenOwner = releaseOwner;
      fsyncDirectory(lockDirectory);
      fsyncDirectory(releaseDirectory);
      if (afterReleaseOwnerTake)
        afterReleaseOwnerTake({ ownerPath, releaseOwner });
    } catch (error) {
      if (takenOwner && existsSync(takenOwner) && existsSync(lockDirectory)) {
        restoreTakenOwner(takenOwner, ownerPath, lockDirectory, lockRoot);
        if (takenOwner === releaseOwner && existsSync(releaseDirectory)) {
          fsyncDirectory(releaseDirectory);
        }
      }
      if (existsSync(releaseDirectory)) rmdirSync(releaseDirectory);
      fsyncDirectory(lockRoot);
      abandon();
      throw error;
    }
    try {
      // These exact paths are unpublished owner stages. Remove only stages
      // whose publishing PID is gone. A live handoff or rollback still needs
      // its stage and must make this release restore or yield its owner.
      removeInertLegacyOwnerStages(lockDirectory);
      rmdirSync(lockDirectory);
    } catch (error) {
      if (existsSync(ownerPath)) {
        return settleSuccessorOwner();
      }
      try {
        if (beforeReleaseOwnerRestore)
          beforeReleaseOwnerRestore({ ownerPath, releaseOwner });
        linkSync(releaseOwner, ownerPath);
      } catch (restoreError) {
        if (restoreError.code === "EEXIST" || existsSync(ownerPath)) {
          return settleSuccessorOwner();
        }
        abandon();
        throw new CoordinatorError(
          "LEGACY_RELEASE_FAILED",
          `could not remove legacy run.lock: ${error.message}; owner restoration failed: ${restoreError.message}`,
        );
      }
      fsyncDirectory(lockDirectory);
      unlinkSync(releaseOwner);
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
    unlinkSync(releaseOwner);
    fsyncDirectory(releaseDirectory);
    rmdirSync(releaseDirectory);
    fsyncDirectory(lockRoot);
    closeMarker();
    if (
      existsSync(markerPath) &&
      readFileSync(markerPath, "utf8").trim() === generationToken
    ) {
      unlinkSync(markerPath);
      fsyncDirectory(lockRoot);
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
