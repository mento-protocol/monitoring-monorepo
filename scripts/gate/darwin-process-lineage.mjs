#!/usr/bin/env node

import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  DarwinNativeContentionError,
  DarwinNativeRuntimeReceiptMissingError,
  DarwinSnapshotContentionError,
  armDarwinPrivateWatcherControl,
  darwinNativeHelperTrustForTest,
  nativeHelper,
  readDarwinPrivateCancelMarker,
  readDarwinPrivatePeerFile,
  requireNativeHelperRuntime,
  runNative,
  runNativeSnapshot,
  validateNativeHelperRuntime,
} from "./darwin-process-identity-helper.mjs";
import {
  BOOT_ID,
  LIFECYCLE_CONTRACT,
  RUN_TOKEN,
  SNAPSHOT_HEADER,
  STATE_SCHEMA,
  classifyDarwinLineageCandidates,
  classifySnapshot,
  hasExactDarwinAncestry,
  isExactDarwinChild,
  matchesExactDarwinIdentity,
  mergeWatchedDarwinLineageTombstones,
  parseCommandOptions,
  parseDarwinProcessIdentity,
  parseDarwinProcessSnapshot,
  positiveInteger,
  requiredOption as required,
  signalOrder,
  unsignedDecimal,
  validateState,
} from "./darwin-process-lineage-model.mjs";
import {
  DarwinTransitionConflictError,
  createState,
  discardSettledState,
  discardState,
  readCanonicalTransitionValue,
  readState,
  readStateForSettlement,
  replaceState,
  transitionPaths,
  validateDiscardTombstone,
} from "./darwin-process-lineage-state.mjs";

export { classifyDarwinLineageCandidates, parseDarwinProcessSnapshot };
export { darwinNativeHelperTrustForTest };

const MODULE_PATH = fileURLToPath(import.meta.url);
const EXACT_IDENTITY_PREFIX = "agentqg-darwin-exact-v1";
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const QUIET_SCAN_DELAY_MS = 200;
const WATCH_SETTLEMENT_TIMEOUT_SECONDS = 30;
const WATCH_BOOTSTRAP_TIMEOUT_MS = 8_000;
const WATCH_CENSUS_TIMEOUT_MS = 2_000;
const NATIVE_OPERATION_TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 4_000;
const MAX_COHORT_STATES = 64;
const MAX_REMAINING_IDENTITY_DETAILS = 32;

function fail(message) {
  throw new Error(message);
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("current UID is unavailable");
  return process.getuid();
}

function settlementTimeout(value, label) {
  return positiveInteger(value, label, 86_400);
}

function validateDirectory(path, label) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid()
  ) {
    fail(`${label} is not a current-user real directory`);
  }
  return stat;
}

function validateStatePath(path, token) {
  if (typeof path !== "string" || basename(path) !== `lineage.${token}.json`) {
    fail("Darwin lineage state path does not match its token");
  }
  validateDirectory(dirname(path), "Darwin lineage state directory");
}

function tokenFromStatePath(path) {
  const match = /^lineage\.(.+)\.json$/u.exec(basename(path));
  if (!match || !RUN_TOKEN.test(match[1])) {
    fail("Darwin lineage state path has no valid token");
  }
  return match[1];
}

function validateCohortStatePaths(statePaths) {
  if (
    !Array.isArray(statePaths) ||
    statePaths.length === 0 ||
    statePaths.length > MAX_COHORT_STATES
  ) {
    fail(
      `Darwin lineage cohort must contain from 1 through ${MAX_COHORT_STATES} state paths`,
    );
  }
  const seenPaths = new Set();
  const seenTokens = new Set();
  let stateDirectory = null;
  return statePaths.map((inputPath) => {
    if (typeof inputPath !== "string" || inputPath.includes("\0")) {
      fail("Darwin lineage cohort state path is malformed");
    }
    const statePath = resolve(inputPath);
    const token = tokenFromStatePath(statePath);
    validateStatePath(statePath, token);
    const directory = dirname(statePath);
    if (stateDirectory === null) stateDirectory = directory;
    if (directory !== stateDirectory) {
      fail("Darwin lineage cohort states must share one real directory");
    }
    if (seenPaths.has(statePath) || seenTokens.has(token)) {
      fail("Darwin lineage cohort contains a duplicate state token or path");
    }
    seenPaths.add(statePath);
    seenTokens.add(token);
    return { statePath, token };
  });
}

function parseCohortTokens(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("Darwin lineage cohort token list is malformed");
  }
  const tokens = value.split(",");
  if (
    tokens.length === 0 ||
    tokens.length > MAX_COHORT_STATES ||
    tokens.some((token) => !RUN_TOKEN.test(token)) ||
    new Set(tokens).size !== tokens.length
  ) {
    fail(
      "Darwin lineage cohort token list is malformed or contains duplicates",
    );
  }
  return tokens;
}

function parseRetainState(value) {
  if (value !== "0" && value !== "1") {
    fail("Darwin lineage retain-state flag must be 0 or 1");
  }
  return value === "1";
}

function bootIdentity(helper, timeoutMs = 30_000) {
  const bootId = runNative(helper, ["boot-id"], { timeoutMs }).stdout.trimEnd();
  if (!BOOT_ID.test(bootId)) fail("Darwin boot identity has an invalid shape");
  return bootId;
}

function nativeRetryProfile(timeoutMs, maxAttempts) {
  const boundedTimeoutMs = Math.max(1, Math.min(60_000, Math.floor(timeoutMs)));
  return {
    timeoutMs: boundedTimeoutMs,
    maxAttempts,
    maxSpawnTimeoutMs: Math.min(NATIVE_OPERATION_TIMEOUT_MS, boundedTimeoutMs),
  };
}

function snapshot(helper, retryProfile = {}) {
  return timestampSnapshot(runNativeSnapshot(helper, retryProfile));
}

function timestampSnapshot(result) {
  return {
    records: result.records,
    proof: { ...result.proof, capturedAt: Date.now() },
  };
}

function identity(helper, pid) {
  const result = runNative(helper, ["identity", String(pid)], {
    acceptedStatuses: [0, 3],
  });
  return result.status === 3 ? null : parseDarwinProcessIdentity(result.stdout);
}

function encodeExactIdentity({ bootId, pid, uniqueId, parentUniqueId }) {
  return [
    EXACT_IDENTITY_PREFIX,
    bootId,
    String(pid),
    uniqueId,
    parentUniqueId,
  ].join(":");
}

function captureExactRelation(helper, childPid, parentPid, allowGone, label) {
  const beforeBootId = bootIdentity(helper);
  const parent = identity(helper, parentPid);
  const child = identity(helper, childPid);
  const afterBootId = bootIdentity(helper);
  if (beforeBootId !== afterBootId) {
    fail(`Darwin boot identity changed during ${label}`);
  }
  if (parent === null || (child === null && !allowGone)) {
    fail(`Darwin ${label} process exited during identity capture`);
  }
  if (child === null) return null;
  if (!isExactDarwinChild(child, parent)) {
    fail(`Darwin ${label} has an inconsistent kernel parent`);
  }
  return { bootId: beforeBootId, parent, child };
}

export function parseDarwinExactIdentity(value) {
  if (typeof value !== "string" || value.length > 256) {
    fail("Darwin exact process identity is malformed");
  }
  const [prefix, bootId, pid, uniqueId, parentUniqueId, ...remainder] =
    value.split(":");
  if (
    prefix !== EXACT_IDENTITY_PREFIX ||
    parentUniqueId === undefined ||
    remainder.length !== 0
  ) {
    fail("Darwin exact process identity is malformed");
  }
  if (!BOOT_ID.test(bootId)) {
    fail("Darwin exact process identity has an invalid boot identity");
  }
  const identity = {
    bootId,
    pid: positiveInteger(pid, "Darwin exact process PID", 2_147_483_647),
    uniqueId: unsignedDecimal(uniqueId, "Darwin exact process unique ID"),
    parentUniqueId: unsignedDecimal(
      parentUniqueId,
      "Darwin exact process parent unique ID",
      { allowZero: true },
    ),
  };
  if (
    identity.parentUniqueId !== "0" &&
    BigInt(identity.parentUniqueId) >= BigInt(identity.uniqueId)
  ) {
    fail(
      "Darwin exact process identity has non-monotonic parent and child unique IDs",
    );
  }
  return identity;
}

export function captureDarwinExactParent({ scratchDirectory, pid }) {
  if (process.platform !== "darwin") return { active: false, identity: "" };
  const parsedParentPid = positiveInteger(
    pid,
    "Darwin exact parent PID",
    2_147_483_647,
  );
  if (parsedParentPid !== process.ppid) {
    fail("Darwin exact parent PID is not this process's direct parent");
  }
  const helper = nativeHelper(scratchDirectory);
  requireNativeHelperRuntime(scratchDirectory, helper);
  const { bootId, parent, child } = captureExactRelation(
    helper,
    process.pid,
    parsedParentPid,
    false,
    "exact parent capture",
  );
  if (child.pid !== process.pid) fail("Darwin capture PID changed");
  return {
    active: true,
    identity: encodeExactIdentity({
      bootId,
      pid: parent.pid,
      uniqueId: parent.uniqueId,
      parentUniqueId: parent.parentUniqueId,
    }),
  };
}

function captureDarwinExactChildRecord({
  scratchDirectory,
  pid,
  parentPid,
  allowGone,
}) {
  if (process.platform !== "darwin") return { active: false, identity: "" };
  const parsedPid = positiveInteger(
    pid,
    "Darwin exact child PID",
    2_147_483_647,
  );
  const parsedParentPid = positiveInteger(
    parentPid,
    "Darwin exact child parent PID",
    2_147_483_647,
  );
  const helper = nativeHelper(scratchDirectory);
  requireNativeHelperRuntime(scratchDirectory, helper);
  const captured = captureExactRelation(
    helper,
    parsedPid,
    parsedParentPid,
    allowGone,
    "exact child capture",
  );
  if (captured === null) return { active: false, identity: "" };
  const { bootId, child } = captured;
  return {
    active: true,
    identity: encodeExactIdentity({
      bootId,
      pid: child.pid,
      uniqueId: child.uniqueId,
      parentUniqueId: child.parentUniqueId,
    }),
  };
}

export function captureDarwinExactChild(options) {
  return captureDarwinExactChildRecord({ ...options, allowGone: false });
}

export function captureDarwinExactChildOrGone(options) {
  return captureDarwinExactChildRecord({ ...options, allowGone: true });
}

export function prepareDarwinExactIdentityHelper({ scratchDirectory }) {
  if (process.platform !== "darwin") return { active: false };
  const helper = nativeHelper(scratchDirectory);
  validateNativeHelperRuntime(scratchDirectory, helper);
  return { active: true };
}

export function signalDarwinExactIdentity({
  scratchDirectory,
  exactIdentity,
  signal,
}) {
  if (process.platform !== "darwin") {
    fail(
      "a Darwin exact process identity cannot be signalled on this platform",
    );
  }
  const expected = parseDarwinExactIdentity(exactIdentity);
  const signalNumber = positiveInteger(
    signal,
    "Darwin exact process signal",
    64,
  );
  if (
    ![
      osConstants.signals.SIGSTOP,
      osConstants.signals.SIGTERM,
      osConstants.signals.SIGKILL,
    ].includes(signalNumber)
  ) {
    fail("Darwin exact process signal must be STOP, TERM, or KILL");
  }
  const helper = nativeHelper(scratchDirectory);
  requireNativeHelperRuntime(scratchDirectory, helper);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (bootIdentity(helper) !== expected.bootId) {
      fail("Darwin exact process identity belongs to a different boot");
    }
    const current = identity(helper, expected.pid);
    if (current === null || current.uniqueId !== expected.uniqueId) {
      return { gone: true, signalled: false };
    }
    const status = signalIdentity(helper, current, signalNumber);
    if (status === 0) return { gone: false, signalled: true };
    if (status === 3) return { gone: true, signalled: false };
  }
  fail(
    "Darwin exact process identity changed during every atomic signal attempt",
  );
}

export function statusDarwinExactIdentity({ scratchDirectory, exactIdentity }) {
  if (process.platform !== "darwin") {
    fail("a Darwin exact process identity cannot be checked on this platform");
  }
  const expected = parseDarwinExactIdentity(exactIdentity);
  const helper = nativeHelper(scratchDirectory);
  requireNativeHelperRuntime(scratchDirectory, helper);
  return { status: exactIdentityStatus(helper, expected) };
}

function exactIdentityStatus(helper, expected, currentBootId) {
  const bootId = currentBootId ?? bootIdentity(helper);
  if (bootId !== expected.bootId) {
    fail("Darwin exact process identity belongs to a different boot");
  }
  const current = identity(helper, expected.pid);
  if (
    current === null ||
    current.uniqueId !== expected.uniqueId ||
    current.parentUniqueId !== expected.parentUniqueId
  ) {
    return "gone";
  }
  // SZOMB is 5 on Darwin. A zombie cannot execute or create descendants.
  return current.status === 5 ? "zombie" : "live";
}

function readPrivateWatchState(statePath, stateDirectory) {
  const token = tokenFromStatePath(statePath);
  validateStatePath(statePath, token);
  const { bytes } = readDarwinPrivatePeerFile(
    statePath,
    stateDirectory,
    "Darwin settlement watcher state",
    { expectedModes: [0o600], maximumBytes: MAX_STATE_BYTES },
  );
  return validateState(JSON.parse(bytes.toString("utf8")), token);
}

function recordWatchedDarwinLineageCensus(statePath, helper, retryProfile) {
  while (true) {
    const state = readState(statePath);
    if (state.settledAt !== null || state.settledReason !== null) return;
    if (state.launcher === null || state.root === null) {
      fail("Darwin settlement watcher lost its bound lineage");
    }
    const { records } = snapshot(helper, retryProfile);
    const classified = classifySnapshot(state, records, {
      controlPid: process.pid,
      now: Date.now(),
    });
    const tombstones = mergeWatchedDarwinLineageTombstones(
      state.tombstones,
      classified.tombstones,
    );
    if (JSON.stringify(tombstones) === JSON.stringify(state.tombstones)) {
      return;
    }
    try {
      replaceState(statePath, state, {
        ...state,
        tombstones,
      });
      return;
    } catch (error) {
      if (!(error instanceof DarwinTransitionConflictError)) throw error;
    }
  }
}

async function settleWatchedDarwinLineage(
  statePath,
  scratchDirectory,
  timeoutSeconds,
) {
  const result = await settleDarwinLineage({
    statePath,
    scratchDirectory,
    timeoutSeconds,
    retainState: true,
  });
  if (!result.active || !result.settled || result.retained !== true) {
    fail("Darwin settlement watcher did not prove an empty coherent exact set");
  }
  return { active: true, status: "settled" };
}

export async function watchDarwinLineageSettlement({
  statePath,
  scratchDirectory,
  stateDirectory = scratchDirectory,
  controllerIdentity,
  cancelFile,
  armedFile,
  timeoutSeconds,
}) {
  if (process.platform !== "darwin") {
    fail("a Darwin lineage watcher cannot run on this platform");
  }
  const timeout = settlementTimeout(
    timeoutSeconds,
    "Darwin settlement watcher timeout",
  );
  const deadline = performance.now() + timeout * 1_000;
  const settleTimeout = Math.min(timeout, WATCH_SETTLEMENT_TIMEOUT_SECONDS);
  const state = readPrivateWatchState(statePath, stateDirectory);
  if (state.launcher === null || state.root === null) {
    fail("Darwin settlement watcher requires a bound lineage");
  }
  const settle = () =>
    settleWatchedDarwinLineage(statePath, scratchDirectory, settleTimeout);
  let controlDirectory;
  let controller;
  let launcher;
  let helper;
  try {
    helper = nativeHelper(scratchDirectory);
    const bootstrapReceiptTimeout = Math.min(
      WATCH_BOOTSTRAP_TIMEOUT_MS,
      deadline - performance.now(),
    );
    if (bootstrapReceiptTimeout <= 0) return await settle();
    const capability = requireNativeHelperRuntime(
      scratchDirectory,
      helper,
      nativeRetryProfile(bootstrapReceiptTimeout, 1),
    );
    if (capability.bootId !== state.bootId) return await settle();
    controller = parseDarwinExactIdentity(controllerIdentity);
    const launcherIdentity = encodeExactIdentity({
      bootId: state.bootId,
      ...state.launcher,
    });
    launcher = parseDarwinExactIdentity(launcherIdentity);
    const beforeBootId = bootIdentity(helper);
    const bootstrapSnapshotTimeout = Math.min(
      WATCH_BOOTSTRAP_TIMEOUT_MS,
      deadline - performance.now(),
    );
    if (bootstrapSnapshotTimeout <= 0) return await settle();
    const { records } = snapshot(
      helper,
      nativeRetryProfile(bootstrapSnapshotTimeout, 6),
    );
    const afterBootId = bootIdentity(helper);
    const controllerRow = records.find(({ pid }) => pid === controller.pid);
    const launcherRow = records.find(({ pid }) => pid === launcher.pid);
    const watcherRow = records.find(({ pid }) => pid === process.pid);
    if (
      beforeBootId !== afterBootId ||
      beforeBootId !== controller.bootId ||
      beforeBootId !== launcher.bootId ||
      !matchesExactDarwinIdentity(controllerRow, controller) ||
      !matchesExactDarwinIdentity(launcherRow, launcher) ||
      watcherRow?.pid !== process.pid ||
      controllerRow.status === 5 ||
      launcherRow.status === 5 ||
      watcherRow.status === 5 ||
      !isExactDarwinChild(watcherRow, launcherRow) ||
      !hasExactDarwinAncestry(records, watcherRow, controllerRow, currentUid())
    ) {
      return await settle();
    }
  } catch {
    return await settle();
  }

  try {
    const control = armDarwinPrivateWatcherControl({
      cancelFile,
      armedFile,
      scratchDirectory,
    });
    controlDirectory = control.directory;
    if (control.status === "cancelled") {
      return { active: true, status: "cancelled" };
    }
    if (control.status === "settle") {
      return await settle();
    }
  } catch {
    return await settle();
  }

  while (true) {
    try {
      const action = readDarwinPrivateCancelMarker(
        cancelFile,
        controlDirectory,
        "Darwin settlement watcher action marker",
      );
      if (action === "cancelled" || action === "settle") {
        return await settle();
      }
      const bootId = bootIdentity(helper);
      if (
        exactIdentityStatus(helper, controller, bootId) !== "live" ||
        exactIdentityStatus(helper, launcher, bootId) !== "live"
      ) {
        return await settle();
      }
      const censusTimeout = Math.min(
        WATCH_CENSUS_TIMEOUT_MS,
        deadline - performance.now(),
      );
      if (censusTimeout <= 0) return await settle();
      // Persist exact descendants while their complete parent chain is still
      // visible. Settlement can then retain the owned classification after a
      // short-lived intermediate process exits and breaks the live chain.
      recordWatchedDarwinLineageCensus(
        statePath,
        helper,
        nativeRetryProfile(censusTimeout, 1),
      );
      const actionAfterCensus = readDarwinPrivateCancelMarker(
        cancelFile,
        controlDirectory,
        "Darwin settlement watcher action marker",
      );
      if (actionAfterCensus === "cancelled" || actionAfterCensus === "settle") {
        return await settle();
      }
    } catch (error) {
      if (error instanceof DarwinSnapshotContentionError) {
        try {
          const action = readDarwinPrivateCancelMarker(
            cancelFile,
            controlDirectory,
            "Darwin settlement watcher action marker",
          );
          if (action === "cancelled" || action === "settle") {
            return await settle();
          }
          const bootId = bootIdentity(helper);
          if (
            exactIdentityStatus(helper, controller, bootId) !== "live" ||
            exactIdentityStatus(helper, launcher, bootId) !== "live"
          ) {
            return await settle();
          }
        } catch {
          return await settle();
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) return await settle();
        await delay(Math.min(QUIET_SCAN_DELAY_MS, remaining));
        continue;
      }
      return await settle();
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return await settle();
    await delay(Math.min(QUIET_SCAN_DELAY_MS, remaining));
  }
}

function signalIdentity(helper, candidate, signal) {
  return runNative(
    helper,
    ["signal", String(candidate.pid), candidate.uniqueId, String(signal)],
    { acceptedStatuses: [0, 3, 4] },
  ).status;
}

function uidMatches(record) {
  const uid = currentUid();
  return [record.uid, record.realUid, record.savedUid].includes(uid);
}

async function waitAtDarwinCensusTestBarrier() {
  const barrier = process.env.AGENT_QUALITY_GATE_TEST_DRAIN_REFRESH_BARRIER;
  if (!barrier) return;
  if (
    process.env.NODE_ENV !== "test" ||
    typeof barrier !== "string" ||
    !barrier.startsWith("/") ||
    barrier.length > 1024 ||
    barrier.includes("\0")
  ) {
    fail("Darwin census test barrier is unsafe");
  }
  try {
    writeFileSync(`${barrier}.used`, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") return;
    throw error;
  }
  writeFileSync(`${barrier}.ready`, "", { flag: "wx", mode: 0o600 });
  const controllerPid = process.ppid;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(`${barrier}.release`)) return;
    if (process.ppid !== controllerPid) {
      fail("Darwin census test controller exited before barrier release");
    }
    await delay(20);
  }
  fail("Darwin census test barrier did not release");
}

function sortedBaseline(records) {
  return records
    .map((record) => record.uniqueId)
    .sort((left, right) => {
      const leftId = BigInt(left);
      const rightId = BigInt(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

function captureBaseline(helper) {
  const beforeBootId = bootIdentity(helper);
  const { records } = snapshot(helper);
  const baseline = sortedBaseline(records);
  const afterBootId = bootIdentity(helper);
  if (beforeBootId !== afterBootId) {
    fail("Darwin boot identity changed during the process baseline");
  }
  return { bootId: beforeBootId, baseline };
}

export function prepareDarwinLineage({ statePath, scratchDirectory, token }) {
  if (process.platform !== "darwin") return { active: false };
  if (!RUN_TOKEN.test(token)) fail("Darwin lineage token is malformed");
  validateStatePath(statePath, token);
  const helper = nativeHelper(scratchDirectory);
  const capability = validateNativeHelperRuntime(scratchDirectory, helper);
  const bootId = capability.bootId;
  const baseline = sortedBaseline(capability.snapshot.records);
  createState(statePath, {
    schema: STATE_SCHEMA,
    lifecycleContract: LIFECYCLE_CONTRACT,
    token,
    bootId,
    baseline,
    root: null,
    launcher: null,
    tombstones: [],
    settledAt: null,
    settledReason: null,
    settlementProof: null,
    createdAt: Date.now(),
    revision: 0,
  });
  return { active: true, baselineCount: baseline.length, bootId };
}

export function refreshDarwinLineageBaseline({ statePath, scratchDirectory }) {
  if (process.platform !== "darwin") return { active: false };
  const state = readState(statePath);
  if (
    state.root !== null ||
    state.launcher !== null ||
    state.tombstones.length !== 0 ||
    state.settledAt !== null ||
    state.settledReason !== null ||
    state.settlementProof !== null
  ) {
    fail("only an unbound Darwin lineage can refresh its process baseline");
  }
  const helper = nativeHelper(scratchDirectory);
  requireNativeHelperRuntime(scratchDirectory, helper);
  const { bootId, baseline } = captureBaseline(helper);
  replaceState(statePath, state, { ...state, bootId, baseline });
  return { active: true, baselineCount: baseline.length, bootId };
}

export function resumeDarwinOwnerLineage({ statePath, scratchDirectory }) {
  if (process.platform !== "darwin") return { active: false };
  const state = readState(statePath);
  if (
    state.root === null &&
    state.launcher === null &&
    state.tombstones.length === 0 &&
    state.settledAt === null &&
    state.settledReason === null &&
    state.settlementProof === null
  ) {
    return { active: true, rearmed: false };
  }
  if (state.settledAt === null || state.settledReason === null) {
    fail(
      "only an unbound or settled Darwin owner lineage can resume mapped work",
    );
  }
  const helper = nativeHelper(scratchDirectory);
  const capability = validateNativeHelperRuntime(scratchDirectory, helper);
  const replacement = replaceState(statePath, state, {
    ...state,
    bootId: capability.bootId,
    baseline: sortedBaseline(capability.snapshot.records),
    root: null,
    launcher: null,
    tombstones: [],
    settledAt: null,
    settledReason: null,
    settlementProof: null,
    createdAt: Date.now(),
  });
  return {
    active: true,
    rearmed: true,
    baselineCount: replacement.baseline.length,
    bootId: replacement.bootId,
  };
}

export function bindDarwinLineageRoot({
  statePath,
  scratchDirectory,
  pid,
  parentPid,
}) {
  if (process.platform !== "darwin") return { active: false };
  const state = readState(statePath);
  if (state.root !== null) fail("Darwin lineage root is already bound");
  if (state.settledAt !== null) {
    fail("a settled Darwin lineage cannot start mapped work");
  }
  const helper = nativeHelper(scratchDirectory);
  const capability = requireNativeHelperRuntime(scratchDirectory, helper);
  if (capability.bootId !== state.bootId) {
    fail("Darwin boot identity changed before mapped-command START");
  }
  const root = identity(
    helper,
    positiveInteger(pid, "mapped-command root PID", 2_147_483_647),
  );
  const parent = identity(
    helper,
    positiveInteger(parentPid, "mapped-command parent PID", 2_147_483_647),
  );
  if (
    root === null ||
    parent === null ||
    root.ppid !== parent.pid ||
    root.parentUniqueId !== parent.uniqueId ||
    BigInt(root.uniqueId) <= BigInt(parent.uniqueId) ||
    root.resourceCoalitionId !== parent.resourceCoalitionId ||
    root.jetsamCoalitionId !== parent.jetsamCoalitionId ||
    !uidMatches(root) ||
    !uidMatches(parent)
  ) {
    fail("mapped-command root is not the exact child behind the START barrier");
  }
  replaceState(statePath, state, {
    ...state,
    root: {
      pid: root.pid,
      uniqueId: root.uniqueId,
      parentUniqueId: root.parentUniqueId,
      resourceCoalitionId: root.resourceCoalitionId,
      jetsamCoalitionId: root.jetsamCoalitionId,
    },
    launcher: {
      pid: parent.pid,
      uniqueId: parent.uniqueId,
      parentUniqueId: parent.parentUniqueId,
      resourceCoalitionId: parent.resourceCoalitionId,
      jetsamCoalitionId: parent.jetsamCoalitionId,
    },
  });
  return { active: true, rootUniqueId: root.uniqueId };
}

function readCohortStates(descriptors, forSettlement = false) {
  return descriptors.map(({ statePath, token }) => ({
    statePath,
    token,
    state: forSettlement
      ? readStateForSettlement(statePath)
      : readState(statePath),
  }));
}

function completeCohortSettlement(entries, retainState) {
  if (
    entries.some(
      ({ state }) => state.settledAt === null || state.settledReason === null,
    )
  ) {
    fail("Darwin lineage cohort did not durably settle every state");
  }
  const settlements = entries.map(({ statePath, token, state }) => ({
    statePath,
    token,
    reason: state.settledReason,
  }));
  // Callers that need successor recovery use retainState. Keep every proof
  // until the complete cohort is durable; only then apply the legacy
  // non-retained behavior one state at a time.
  if (!retainState) {
    for (const { statePath, state } of entries) {
      discardState(statePath, state);
    }
  }
  return {
    active: true,
    settled: true,
    retained: retainState,
    settlements,
  };
}

function cohortSignalPlan(epochEntries) {
  const identities = new Map();
  const tombstones = new Map();
  for (const entry of epochEntries) {
    for (const tombstone of entry.state.tombstones) {
      const existing = tombstones.get(tombstone.uniqueId);
      if (
        existing &&
        (existing.pid !== tombstone.pid ||
          existing.parentUniqueId !== tombstone.parentUniqueId)
      ) {
        fail("Darwin lineage cohort contains inconsistent exact identities");
      }
      tombstones.set(tombstone.uniqueId, existing ?? tombstone);
    }
    for (const candidate of entry.classified.candidates) {
      const existing = identities.get(candidate.uniqueId);
      if (
        existing &&
        (existing.candidate.pid !== candidate.pid ||
          existing.candidate.parentUniqueId !== candidate.parentUniqueId)
      ) {
        fail("Darwin lineage cohort classified an inconsistent exact identity");
      }
      const identity = existing ?? {
        candidate,
        classifications: [],
        ownerPaths: new Set(),
      };
      identity.classifications.push(candidate.classification);
      if (candidate.classification === "owned") {
        identity.ownerPaths.add(entry.statePath);
        identity.candidate = { ...candidate, classification: "owned" };
      }
      identities.set(candidate.uniqueId, identity);
    }
  }
  const ownedCandidates = [...identities.values()]
    .filter(({ ownerPaths }) => ownerPaths.size > 0)
    .map(({ candidate }) => candidate);
  return {
    identities,
    orderedOwned: signalOrder(ownedCandidates, [...tombstones.values()]),
    ownedCount: ownedCandidates.length,
    ambiguousCount: [...identities.values()].filter(
      ({ ownerPaths }) => ownerPaths.size === 0,
    ).length,
  };
}

function remainingCohortDetails(epochEntries) {
  const includeToken = epochEntries.length > 1;
  const details = epochEntries.flatMap(({ token, classified }) =>
    classified.candidates.map((item) => {
      const detail = `${item.pid}/${item.uniqueId}:${item.classification}`;
      return includeToken ? `${token}:${detail}` : detail;
    }),
  );
  const retained = details.slice(0, MAX_REMAINING_IDENTITY_DETAILS);
  if (details.length > retained.length) {
    retained.push(`${details.length - retained.length} more`);
  }
  return retained.join(", ");
}

export async function settleDarwinLineageCohort({
  statePaths,
  scratchDirectory,
  timeoutSeconds,
  retainState = false,
}) {
  if (typeof retainState !== "boolean") {
    fail("Darwin lineage retain-state value must be boolean");
  }
  const descriptors = validateCohortStatePaths(statePaths);
  if (descriptors.length > 1 && !retainState) {
    fail("Darwin lineage cohort settlement must retain every state");
  }
  for (const { statePath } of descriptors) {
    if (!existsSync(statePath)) {
      fail("required Darwin lineage cohort state is missing");
    }
  }
  if (process.platform !== "darwin") {
    fail("a Darwin lineage cohort cannot be settled on this platform");
  }
  let entries = readCohortStates(descriptors, true);
  if (entries.every(({ state }) => state.settledReason !== null)) {
    return completeCohortSettlement(entries, retainState);
  }

  const timeout = settlementTimeout(timeoutSeconds, "lineage timeout");
  const deadline = performance.now() + timeout * 1_000;
  let helper = null;
  let currentBootId = null;
  let runtimeReceiptValidated = false;
  let runtimeValidationSnapshot = null;
  let announced = false;

  while (true) {
    entries = readCohortStates(descriptors);
    if (entries.every(({ state }) => state.settledReason !== null)) {
      return completeCohortSettlement(entries, retainState);
    }
    for (const { state } of entries) {
      if (
        state.settledReason === null &&
        (state.settledAt !== null || state.settlementProof !== null)
      ) {
        fail("Darwin lineage changed to invalid settlement evidence");
      }
    }

    let restart = false;
    for (const entry of entries) {
      if (
        entry.state.settledReason !== null ||
        !isVerifiedUnboundAbandonmentState(entry.state)
      ) {
        continue;
      }
      try {
        replaceState(entry.statePath, entry.state, {
          ...entry.state,
          settledAt: Date.now(),
          settledReason: "verified-unbound-abandonment",
          settlementProof: null,
        });
      } catch (error) {
        if (!(error instanceof DarwinTransitionConflictError)) throw error;
        if (performance.now() >= deadline) throw error;
      }
      restart = true;
    }
    if (restart) continue;

    if (helper === null) {
      const initialRemaining = deadline - performance.now();
      if (initialRemaining <= 0) {
        fail("Darwin lineage recovery exceeded its monotonic deadline");
      }
      helper = nativeHelper(scratchDirectory);
      currentBootId = bootIdentity(
        helper,
        Math.max(
          1,
          Math.floor(Math.min(NATIVE_OPERATION_TIMEOUT_MS, initialRemaining)),
        ),
      );
    }

    for (const entry of entries) {
      if (
        entry.state.settledReason !== null ||
        entry.state.bootId === currentBootId
      ) {
        continue;
      }
      try {
        replaceState(entry.statePath, entry.state, {
          ...entry.state,
          settledAt: Date.now(),
          settledReason: "verified-boot-change",
          settlementProof: null,
        });
      } catch (error) {
        if (!(error instanceof DarwinTransitionConflictError)) throw error;
        if (performance.now() >= deadline) throw error;
      }
      restart = true;
    }
    if (restart) continue;

    const activeEntries = entries.filter(
      ({ state }) => state.settledReason === null,
    );
    if (!runtimeReceiptValidated) {
      const receiptRemaining = deadline - performance.now();
      if (receiptRemaining <= 0) {
        fail("Darwin lineage recovery exceeded its monotonic deadline");
      }
      let capability;
      try {
        capability = requireNativeHelperRuntime(
          scratchDirectory,
          helper,
          nativeRetryProfile(receiptRemaining, 1),
        );
      } catch (error) {
        if (!(error instanceof DarwinNativeRuntimeReceiptMissingError)) {
          throw error;
        }
        const validationRemaining = deadline - performance.now();
        if (validationRemaining <= 0) {
          fail("Darwin lineage recovery exceeded its monotonic deadline");
        }
        try {
          capability = validateNativeHelperRuntime(
            scratchDirectory,
            helper,
            nativeRetryProfile(validationRemaining, 6),
          );
          runtimeValidationSnapshot = timestampSnapshot(capability.snapshot);
        } catch (validationError) {
          if (!(validationError instanceof DarwinNativeContentionError)) {
            throw validationError;
          }
          const contentionRemaining = deadline - performance.now();
          if (contentionRemaining <= 0) {
            fail(
              "Darwin lineage recovery stayed fail-closed because runtime capability contention reached its deadline",
            );
          }
          await delay(Math.min(QUIET_SCAN_DELAY_MS, contentionRemaining));
          continue;
        }
      }
      if (
        activeEntries.some(({ state }) => state.bootId !== capability.bootId)
      ) {
        currentBootId = capability.bootId;
        runtimeValidationSnapshot = null;
        continue;
      }
      runtimeReceiptValidated = true;
    }

    const snapshotRemaining = deadline - performance.now();
    if (snapshotRemaining <= 0) {
      fail(
        "Darwin lineage recovery stayed fail-closed because no coherent snapshot was available before its deadline",
      );
    }
    let coherentSnapshot;
    if (runtimeValidationSnapshot !== null) {
      coherentSnapshot = runtimeValidationSnapshot;
      runtimeValidationSnapshot = null;
    } else {
      try {
        coherentSnapshot = snapshot(
          helper,
          nativeRetryProfile(
            Math.min(NATIVE_OPERATION_TIMEOUT_MS, snapshotRemaining),
            1,
          ),
        );
      } catch (error) {
        if (!(error instanceof DarwinSnapshotContentionError)) throw error;
        const contentionRemaining = deadline - performance.now();
        if (contentionRemaining <= 0) {
          fail(
            "Darwin lineage recovery stayed fail-closed because snapshot contention reached its deadline",
          );
        }
        await delay(Math.min(QUIET_SCAN_DELAY_MS, contentionRemaining));
        continue;
      }
    }

    const classifiedAt = Date.now();
    const epochEntries = activeEntries.map((entry) => {
      const classified = classifySnapshot(
        entry.state,
        coherentSnapshot.records,
        {
          controlPid: process.pid,
          now: classifiedAt,
        },
      );
      let replacement = {
        ...entry.state,
        tombstones: classified.tombstones,
        settledAt: null,
        settledReason: null,
        settlementProof: null,
      };
      if (classified.candidates.length === 0) {
        replacement = {
          ...replacement,
          settledAt: Date.now(),
          settledReason: "empty-coherent-exact-set",
          settlementProof: coherentSnapshot.proof,
        };
      }
      return { ...entry, classified, replacement };
    });

    restart = false;
    for (const entry of epochEntries) {
      try {
        entry.state = replaceState(
          entry.statePath,
          entry.state,
          entry.replacement,
        );
      } catch (error) {
        if (!(error instanceof DarwinTransitionConflictError)) throw error;
        if (performance.now() >= deadline) throw error;
        restart = true;
        break;
      }
    }
    if (restart) continue;

    if (epochEntries.every(({ state }) => state.settledReason !== null)) {
      const settledByPath = new Map(
        epochEntries.map((entry) => [entry.statePath, entry]),
      );
      entries = entries.map(
        (entry) => settledByPath.get(entry.statePath) ?? entry,
      );
      return completeCohortSettlement(entries, retainState);
    }

    const plan = cohortSignalPlan(
      epochEntries.filter(({ state }) => state.settledReason === null),
    );
    if (!announced) {
      if (plan.ownedCount > 0) {
        process.stderr.write(
          `Darwin lineage recovery found ${plan.ownedCount} exact mapped-command descendant(s).\n`,
        );
      }
      if (plan.ambiguousCount > 0) {
        process.stderr.write(
          `Darwin lineage recovery found ${plan.ambiguousCount} process(es) with an incomplete parent chain. They will not be signalled.\n`,
        );
      }
      announced = true;
    }

    // Test-only crash seam. Every cohort state's classified tombstones are
    // durable before any exact identity receives a signal.
    await waitAtDarwinCensusTestBarrier();

    const signalNow = Date.now();
    const successfulSignals = new Map();
    for (const candidate of plan.orderedOwned) {
      const identityPlan = plan.identities.get(candidate.uniqueId);
      const ownerRecords = epochEntries
        .filter(
          ({ statePath, state }) =>
            identityPlan.ownerPaths.has(statePath) &&
            state.settledReason === null,
        )
        .map(({ state }) =>
          state.tombstones.find((item) => item.uniqueId === candidate.uniqueId),
        );
      if (
        ownerRecords.length !== identityPlan.ownerPaths.size ||
        ownerRecords.some((record) => record?.classification !== "owned")
      ) {
        fail("Darwin lineage cohort lost exact signal authority");
      }
      let signal = null;
      let field = null;
      if (ownerRecords.some(({ termSentAt }) => termSentAt === null)) {
        signal = 15;
        field = "termSentAt";
      } else if (
        ownerRecords.some(({ killSentAt }) => killSentAt === null) &&
        signalNow -
          Math.max(...ownerRecords.map(({ termSentAt }) => termSentAt)) >=
          TERM_GRACE_MS
      ) {
        signal = 9;
        field = "killSentAt";
      }
      if (signal === null) continue;
      const status = signalIdentity(helper, candidate, signal);
      if (status === 0) {
        successfulSignals.set(candidate.uniqueId, {
          field,
          sentAt: Date.now(),
        });
      }
      // Status 3 means the exact identity is gone. Status 4 means it exec'd
      // during the atomic signal and must be retried from a fresh census.
    }

    for (const entry of epochEntries) {
      if (entry.state.settledReason !== null) continue;
      let changed = false;
      const tombstones = entry.state.tombstones.map((item) => {
        const signal = successfulSignals.get(item.uniqueId);
        const identityPlan = plan.identities.get(item.uniqueId);
        if (
          !signal ||
          !identityPlan?.ownerPaths.has(entry.statePath) ||
          item[signal.field] !== null
        ) {
          return item;
        }
        changed = true;
        return { ...item, [signal.field]: signal.sentAt };
      });
      if (!changed) continue;
      try {
        entry.state = replaceState(entry.statePath, entry.state, {
          ...entry.state,
          tombstones,
        });
      } catch (error) {
        if (!(error instanceof DarwinTransitionConflictError)) throw error;
        if (performance.now() >= deadline) throw error;
        restart = true;
        break;
      }
    }
    if (restart) continue;

    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      fail(
        `Darwin lineage recovery stayed fail-closed because exact process identities remain: ${remainingCohortDetails(epochEntries)}`,
      );
    }
    await delay(Math.min(QUIET_SCAN_DELAY_MS, remaining));
  }
}

export async function settleDarwinLineage({
  statePath,
  scratchDirectory,
  timeoutSeconds,
  retainState = false,
}) {
  const result = await settleDarwinLineageCohort({
    statePaths: [statePath],
    scratchDirectory,
    timeoutSeconds,
    retainState,
  });
  return {
    active: result.active,
    settled: result.settled,
    retained: result.retained,
    reason: result.settlements[0].reason,
  };
}

function isVerifiedUnboundAbandonmentState(state) {
  return (
    state.root === null &&
    state.launcher === null &&
    state.tombstones.length === 0 &&
    state.settlementProof === null
  );
}

export function abandonUnstartedDarwinLineage({ statePath }) {
  if (!existsSync(statePath)) fail("required Darwin lineage state is missing");
  if (process.platform !== "darwin") {
    fail("a Darwin lineage obligation cannot be abandoned on this platform");
  }
  let state = readState(statePath);
  if (!isVerifiedUnboundAbandonmentState(state)) {
    fail("only an exact unbound Darwin lineage can be abandoned as unstarted");
  }
  if (state.settledReason === "verified-unbound-abandonment") {
    discardState(statePath, state);
    return {
      active: true,
      abandoned: true,
      reason: state.settledReason,
    };
  }
  if (state.settledAt !== null || state.settledReason !== null) {
    fail("an already settled Darwin lineage cannot be abandoned as unstarted");
  }
  state = replaceState(statePath, state, {
    ...state,
    settledAt: Date.now(),
    settledReason: "verified-unbound-abandonment",
    settlementProof: null,
  });
  discardState(statePath, state);
  return {
    active: true,
    abandoned: true,
    reason: state.settledReason,
  };
}

export function retireDarwinOwnerLineage({ statePath }) {
  if (!existsSync(statePath)) fail("required Darwin lineage state is missing");
  if (process.platform !== "darwin") {
    fail("a Darwin owner lineage cannot be retired on this platform");
  }
  let state = readState(statePath);
  if (state.settledAt !== null && state.settledReason !== null) {
    const reason = state.settledReason;
    discardSettledState(statePath);
    return { active: true, retired: true, reason };
  }
  if (!isVerifiedUnboundAbandonmentState(state)) {
    fail("only an exact unbound or settled Darwin owner lineage can retire");
  }
  state = replaceState(statePath, state, {
    ...state,
    settledAt: Date.now(),
    settledReason: "verified-unbound-abandonment",
    settlementProof: null,
  });
  discardState(statePath, state);
  return {
    active: true,
    retired: true,
    reason: "verified-unbound-abandonment",
  };
}

export function discardSettledDarwinLineage({ statePath }) {
  discardSettledState(statePath);
  return { active: true, discarded: true };
}

async function main() {
  const command = process.argv[2];
  const options = parseCommandOptions(process.argv.slice(3));
  if (command === "prepare-exact") {
    const result = prepareDarwinExactIdentityHelper({
      scratchDirectory: required(options, "--scratch"),
    });
    process.stdout.write(`${result.active ? "ready" : "inactive"}\n`);
    return;
  }
  if (command === "capture-exact-parent") {
    const result = captureDarwinExactParent({
      scratchDirectory: required(options, "--scratch"),
      pid: required(options, "--pid"),
    });
    process.stdout.write(`${result.active ? result.identity : "inactive"}\n`);
    return;
  }
  if (
    command === "capture-exact-child" ||
    command === "capture-exact-child-or-gone"
  ) {
    const capture =
      command === "capture-exact-child"
        ? captureDarwinExactChild
        : captureDarwinExactChildOrGone;
    const result = capture({
      scratchDirectory: required(options, "--scratch"),
      pid: required(options, "--pid"),
      parentPid: required(options, "--parent-pid"),
    });
    process.stdout.write(`${result.active ? result.identity : "gone"}\n`);
    return;
  }
  if (command === "watch-settle") {
    const result = await watchDarwinLineageSettlement({
      statePath: required(options, "--state"),
      scratchDirectory: required(options, "--scratch"),
      stateDirectory: options.get("--state-directory"),
      controllerIdentity: required(options, "--controller-identity"),
      cancelFile: required(options, "--cancel-file"),
      armedFile: required(options, "--armed-file"),
      timeoutSeconds: required(options, "--timeout-seconds"),
    });
    process.stdout.write(`${result.status}\n`);
    return;
  }
  if (command === "signal-exact") {
    const signalName = required(options, "--signal");
    const signalNumber =
      signalName === "STOP"
        ? osConstants.signals.SIGSTOP
        : signalName === "TERM"
          ? osConstants.signals.SIGTERM
          : signalName === "KILL"
            ? osConstants.signals.SIGKILL
            : 0;
    const result = signalDarwinExactIdentity({
      scratchDirectory: required(options, "--scratch"),
      exactIdentity: required(options, "--identity"),
      signal: signalNumber,
    });
    process.stdout.write(`${result.gone ? "gone" : "signalled"}\n`);
    return;
  }
  if (command === "status-exact") {
    const result = statusDarwinExactIdentity({
      scratchDirectory: required(options, "--scratch"),
      exactIdentity: required(options, "--identity"),
    });
    process.stdout.write(`${result.status}\n`);
    return;
  }
  if (command === "settle-cohort") {
    const allowedOptions = new Set([
      "--retain-state",
      "--scratch",
      "--state-directory",
      "--timeout-seconds",
      "--tokens",
    ]);
    if ([...options.keys()].some((name) => !allowedOptions.has(name))) {
      fail("Darwin lineage cohort command options are malformed");
    }
    const stateDirectory = resolve(required(options, "--state-directory"));
    validateDirectory(stateDirectory, "Darwin lineage cohort state directory");
    const tokens = parseCohortTokens(required(options, "--tokens"));
    const retainState = parseRetainState(required(options, "--retain-state"));
    if (!retainState) {
      fail("Darwin lineage cohort settlement must retain every state");
    }
    const result = await settleDarwinLineageCohort({
      statePaths: tokens.map((token) =>
        join(stateDirectory, `lineage.${token}.json`),
      ),
      scratchDirectory: required(options, "--scratch"),
      timeoutSeconds: required(options, "--timeout-seconds"),
      retainState,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const statePath = required(options, "--state");
  if (command === "abandon-unstarted") {
    const result = abandonUnstartedDarwinLineage({ statePath });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "retire-owner") {
    const result = retireDarwinOwnerLineage({ statePath });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const scratchDirectory = required(options, "--scratch");
  let result;
  if (command === "prepare") {
    result = prepareDarwinLineage({
      statePath,
      scratchDirectory,
      token: required(options, "--token"),
    });
  } else if (command === "resume-owner") {
    result = resumeDarwinOwnerLineage({
      statePath,
      scratchDirectory,
    });
  } else if (command === "refresh") {
    result = refreshDarwinLineageBaseline({
      statePath,
      scratchDirectory,
    });
  } else if (command === "bind") {
    result = bindDarwinLineageRoot({
      statePath,
      scratchDirectory,
      pid: required(options, "--pid"),
      parentPid: required(options, "--parent-pid"),
    });
  } else if (command === "settle") {
    result = await settleDarwinLineage({
      statePath,
      scratchDirectory,
      timeoutSeconds: required(options, "--timeout-seconds"),
      retainState: parseRetainState(required(options, "--retain-state")),
    });
  } else if (command === "discard-settled") {
    result = discardSettledDarwinLineage({ statePath });
  } else {
    fail(
      "usage: darwin-process-lineage.mjs <prepare-exact|capture-exact-parent|capture-exact-child|capture-exact-child-or-gone|watch-settle|signal-exact|status-exact|prepare|resume-owner|refresh|bind|settle|settle-cohort|abandon-unstarted|retire-owner|discard-settled> [options]",
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  });
}

export const darwinLineageTransitionForTest = Object.freeze({
  createState,
  discardState,
  readCanonicalTransitionValue,
  replaceState,
  transitionPaths,
  validateDiscardTombstone,
});

export const darwinLineageWatchForTest = Object.freeze({
  readPrivateWatchState,
});

export const darwinLineageConstantsForTest = Object.freeze({
  schema: STATE_SCHEMA,
  lifecycleContract: LIFECYCLE_CONTRACT,
  snapshotHeader: SNAPSHOT_HEADER,
});
