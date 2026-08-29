import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
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
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  BOOT_ID,
  MAX_NATIVE_OUTPUT_BYTES,
  parseDarwinProcessSnapshot,
} from "./darwin-process-lineage-model.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(MODULE_PATH), "..", "..");
const NATIVE_SOURCES = Object.freeze([
  Object.freeze({
    cacheName: "source.c",
    path: join(REPOSITORY_ROOT, "scripts/gate/darwin-process-identity.c"),
  }),
  Object.freeze({
    cacheName: "darwin-process-identity-runtime.inc.c",
    path: join(
      REPOSITORY_ROOT,
      "scripts/gate/darwin-process-identity-runtime.inc.c",
    ),
  }),
]);
const PROBE_OUTPUT = "agentqg-darwin-process-identity-v3";
const NATIVE_CACHE_SCHEMA = "agentqg-darwin-native-helper-cache-v3";
const NATIVE_RUNTIME_RECEIPT_SCHEMA =
  "agentqg-darwin-native-runtime-receipt-v1";
const NATIVE_CONTENTION_RETRY_STATUS = 5;
const NATIVE_RETRY_WAIT = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const DEFAULT_NATIVE_RETRY_PROFILE = Object.freeze({
  timeoutMs: 15_000,
  maxAttempts: 6,
  maxSpawnTimeoutMs: 5_000,
  initialDelayMs: 50,
  maxDelayMs: 800,
});
const MAX_NATIVE_SOURCE_BYTES = 1024 * 1024;
const MAX_NATIVE_SOURCE_AGGREGATE_BYTES = 2 * 1024 * 1024;
const NATIVE_COMPILER_ARGUMENTS = Object.freeze([
  "--sdk",
  "macosx",
  "clang",
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "__SOURCE__",
  "-o",
  "__OUTPUT__",
]);

export class DarwinNativeContentionError extends Error {}

export class DarwinProbeContentionError extends DarwinNativeContentionError {}

export class DarwinSnapshotContentionError extends DarwinNativeContentionError {}

export class DarwinNativeRuntimeReceiptMissingError extends Error {}

function fail(message) {
  throw new Error(message);
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("current UID is unavailable");
  return process.getuid();
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

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sameStableFileIdentity(left, right) {
  return [
    "dev",
    "ino",
    "mode",
    "nlink",
    "uid",
    "gid",
    "rdev",
    "size",
    "mtimeNs",
    "ctimeNs",
  ].every((field) => left[field] === right[field]);
}

function validateStableFileStat(
  stat,
  label,
  {
    expectedLinks = 1,
    expectedMode = null,
    expectedModes = null,
    maximumBytes = null,
  } = {},
) {
  const fileMode = stat.mode & 0o7777n;
  if (
    !stat.isFile() ||
    stat.uid !== BigInt(currentUid()) ||
    stat.nlink !== BigInt(expectedLinks) ||
    (stat.mode & 0o7022n) !== 0n ||
    (expectedMode !== null && fileMode !== BigInt(expectedMode)) ||
    (expectedModes !== null &&
      !expectedModes.some((mode) => fileMode === BigInt(mode))) ||
    (maximumBytes !== null && stat.size > BigInt(maximumBytes))
  ) {
    fail(`${label} is not a safe current-user regular file`);
  }
}

function readStableFile(
  path,
  label,
  {
    expectedMode = null,
    expectedLinks = 1,
    expectedModes = null,
    maximumBytes = null,
    withMetadata = false,
  } = {},
) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    const pathBefore = lstatSync(path, { bigint: true });
    validateStableFileStat(before, label, {
      expectedMode,
      expectedLinks,
      expectedModes,
      maximumBytes,
    });
    if (!sameStableFileIdentity(before, pathBefore)) {
      fail(`${label} path does not name the opened file`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !sameStableFileIdentity(before, after) ||
      !sameStableFileIdentity(before, pathAfter) ||
      BigInt(bytes.length) !== after.size
    ) {
      fail(`${label} changed while it was read`);
    }
    return withMetadata
      ? { bytes, mode: Number(after.mode & 0o7777n), stat: after }
      : bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readDarwinPrivateFile(
  path,
  label,
  { expectedLinks = 1, expectedModes, maximumBytes },
) {
  return readStableFile(path, label, {
    expectedLinks,
    expectedModes,
    maximumBytes,
    withMetadata: true,
  });
}

function validateNativeSources() {
  const sources = NATIVE_SOURCES.map(({ cacheName, path }) => ({
    cacheName,
    path,
    bytes: readStableFile(path, `Darwin process identity source ${cacheName}`, {
      maximumBytes: MAX_NATIVE_SOURCE_BYTES,
    }),
  }));
  const aggregateBytes = sources.reduce(
    (total, source) => total + source.bytes.length,
    0,
  );
  if (aggregateBytes > MAX_NATIVE_SOURCE_AGGREGATE_BYTES) {
    fail("Darwin process identity sources exceed their aggregate size limit");
  }
  return sources;
}

function validateNativeDirectory(path, label, { requirePrivate = false } = {}) {
  const stat = validateDirectory(path, label);
  if (
    (stat.mode & 0o7022) !== 0 ||
    (requirePrivate && (stat.mode & 0o7777) !== 0o700)
  ) {
    fail(`${label} has an unsafe mode`);
  }
  return stat;
}

export function validateDarwinPrivateDirectory(path, label) {
  return validateNativeDirectory(path, label, { requirePrivate: true });
}

export function readDarwinPrivatePeerFile(path, directory, label, options) {
  if (
    typeof directory !== "string" ||
    resolve(directory) !== directory ||
    typeof path !== "string" ||
    resolve(path) !== path ||
    dirname(path) !== directory
  ) {
    fail(`${label} path is not a private peer`);
  }
  validateDarwinPrivateDirectory(directory, `${label} directory`);
  return readDarwinPrivateFile(path, label, options);
}

export function readDarwinPrivateCancelMarker(path, directory, label) {
  const cancelPath = `${path}.cancel.staged`;
  const settlePath = `${path}.settle.staged`;
  const cancelBytes = Buffer.from("cancel\n", "utf8");
  const settleBytes = Buffer.from("settle\n", "utf8");
  if (!pathEntryExists(path)) {
    const cancel = readDarwinPrivatePeerFile(
      cancelPath,
      directory,
      `${label} cancel stage`,
      { expectedLinks: 1, expectedModes: [0o400], maximumBytes: 7 },
    );
    const settle = readDarwinPrivatePeerFile(
      settlePath,
      directory,
      `${label} settle stage`,
      { expectedLinks: 1, expectedModes: [0o400], maximumBytes: 7 },
    );
    if (
      !cancel.bytes.equals(cancelBytes) ||
      !settle.bytes.equals(settleBytes)
    ) {
      fail(`${label} stages are malformed`);
    }
    return "pending";
  }
  const action = readDarwinPrivatePeerFile(path, directory, label, {
    expectedLinks: 2,
    expectedModes: [0o400],
    maximumBytes: 7,
  });
  const isCancel = action.bytes.equals(cancelBytes);
  const isSettle = action.bytes.equals(settleBytes);
  if (!isCancel && !isSettle) fail(`${label} is malformed`);
  const selected = readDarwinPrivatePeerFile(
    isCancel ? cancelPath : settlePath,
    directory,
    `${label} selected stage`,
    { expectedLinks: 2, expectedModes: [0o400], maximumBytes: 7 },
  );
  const unselected = readDarwinPrivatePeerFile(
    isCancel ? settlePath : cancelPath,
    directory,
    `${label} unselected stage`,
    { expectedLinks: 1, expectedModes: [0o400], maximumBytes: 7 },
  );
  if (
    selected.stat.dev !== action.stat.dev ||
    selected.stat.ino !== action.stat.ino ||
    !selected.bytes.equals(action.bytes) ||
    (isCancel
      ? !unselected.bytes.equals(settleBytes)
      : !unselected.bytes.equals(cancelBytes))
  ) {
    fail(`${label} does not name its exact selected stage`);
  }
  return isCancel ? "cancelled" : "settle";
}

export function validateDarwinPrivateControlDirectory(
  peerPath,
  scratchDirectory,
  label,
) {
  if (
    typeof scratchDirectory !== "string" ||
    resolve(scratchDirectory) !== scratchDirectory ||
    typeof peerPath !== "string" ||
    resolve(peerPath) !== peerPath
  ) {
    fail(`${label} path is not absolute and normalized`);
  }
  validateDarwinPrivateDirectory(scratchDirectory, `${label} scratch`);
  const controlDirectory = dirname(peerPath);
  if (
    dirname(controlDirectory) !== scratchDirectory ||
    !basename(controlDirectory).startsWith("deadline-recovery.")
  ) {
    fail(`${label} is outside its private recovery directory`);
  }
  validateDarwinPrivateDirectory(controlDirectory, `${label} directory`);
  return controlDirectory;
}

export function readDarwinPrivateArmedMarker(path, directory, label) {
  const pendingPath = `${path}.pending`;
  if (!pathEntryExists(path)) {
    const pending = readDarwinPrivatePeerFile(
      pendingPath,
      directory,
      `${label} pending marker`,
      { expectedModes: [0o600], maximumBytes: 0 },
    );
    if (pending.bytes.length === 0) return "pending";
    fail(`${label} pending marker is malformed`);
  }
  const pending = readDarwinPrivatePeerFile(
    pendingPath,
    directory,
    `${label} pending marker`,
    { expectedModes: [0o600], maximumBytes: 0 },
  );
  if (pending.bytes.length !== 0) fail(`${label} pending marker is malformed`);
  const stagedPath = `${path}.staged`;
  const staged = readDarwinPrivatePeerFile(
    stagedPath,
    directory,
    `${label} staged marker`,
    { expectedLinks: 2, expectedModes: [0o400], maximumBytes: 6 },
  );
  const armed = readDarwinPrivatePeerFile(path, directory, label, {
    expectedLinks: 2,
    expectedModes: [0o400],
    maximumBytes: 6,
  });
  const expected = Buffer.from("armed\n", "utf8");
  if (
    !staged.bytes.equals(expected) ||
    !armed.bytes.equals(expected) ||
    staged.stat.dev !== armed.stat.dev ||
    staged.stat.ino !== armed.stat.ino
  ) {
    fail(`${label} is not the exact staged marker`);
  }
  return "armed";
}

export function publishDarwinPrivateArmedMarker(path, directory, label) {
  const pendingPath = `${path}.pending`;
  const stagedPath = `${path}.staged`;
  if (pathEntryExists(path)) fail(`${label} already exists`);
  const pending = readDarwinPrivatePeerFile(
    pendingPath,
    directory,
    `${label} pending marker`,
    { expectedModes: [0o600], maximumBytes: 0 },
  );
  if (pending.bytes.length !== 0) fail(`${label} pending marker is malformed`);
  const expected = Buffer.from("armed\n", "utf8");
  writeExclusiveFile(stagedPath, expected, 0o400, `${label} staged marker`);
  fsyncDirectory(directory);
  const staged = readDarwinPrivatePeerFile(
    stagedPath,
    directory,
    `${label} staged marker`,
    { expectedModes: [0o400], maximumBytes: 6 },
  );
  if (!staged.bytes.equals(expected)) {
    fail(`${label} staged marker is malformed`);
  }
  const pendingBeforePublication = readDarwinPrivatePeerFile(
    pendingPath,
    directory,
    `${label} pending marker before publication`,
    { expectedModes: [0o600], maximumBytes: 0 },
  );
  if (
    pendingBeforePublication.bytes.length !== 0 ||
    !sameStableFileIdentity(pending.stat, pendingBeforePublication.stat)
  ) {
    fail(`${label} pending marker changed before publication`);
  }
  // The parent validates and fsyncs the published pair before it releases
  // work. Keep the exclusive hard link as the watcher's last fallible step so
  // visible readiness cannot be followed by a watcher setup failure.
  linkSync(stagedPath, path);
}

export function armDarwinPrivateWatcherControl({
  cancelFile,
  armedFile,
  scratchDirectory,
}) {
  const directory = validateDarwinPrivateControlDirectory(
    cancelFile,
    scratchDirectory,
    "Darwin settlement watcher control",
  );
  if (dirname(armedFile) !== directory) {
    fail(
      "Darwin settlement watcher armed marker is outside its control directory",
    );
  }
  const cancelStatus = readDarwinPrivateCancelMarker(
    cancelFile,
    directory,
    "Darwin settlement watcher action marker",
  );
  if (cancelStatus !== "pending") {
    return { directory, status: cancelStatus };
  }
  if (
    readDarwinPrivateArmedMarker(
      armedFile,
      directory,
      "Darwin settlement watcher armed marker",
    ) !== "pending"
  ) {
    fail("Darwin settlement watcher armed marker is not pending");
  }
  publishDarwinPrivateArmedMarker(
    armedFile,
    directory,
    "Darwin settlement watcher armed marker",
  );
  return { directory, status: "armed" };
}

function writeExclusiveFile(path, bytes, mode, label) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const published = readStableFile(path, label, {
    expectedMode: mode,
    maximumBytes: Math.max(bytes.length, 1),
  });
  if (!published.equals(bytes)) fail(`${label} changed while it was published`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function nativeSourcesDigest(sources) {
  const digest = createHash("sha256");
  for (const source of sources) {
    digest.update(`${source.cacheName}\0${source.bytes.length}\0`, "utf8");
    digest.update(source.bytes);
  }
  return digest.digest("hex");
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function nativeCacheProvenance(sourceDigest, helperDigest) {
  return {
    schema: NATIVE_CACHE_SCHEMA,
    sourceDigest,
    helperDigest,
    compiler: "/usr/bin/xcrun",
    compilerArguments: NATIVE_COMPILER_ARGUMENTS,
  };
}

function stableIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
  });
}

function validateNativeHelperCache(cacheDirectory, sourceDigest) {
  validateNativeDirectory(
    cacheDirectory,
    "compiled Darwin process identity helper cache",
    { requirePrivate: true },
  );
  const directoryBefore = lstatSync(cacheDirectory, { bigint: true });
  const expectedEntries = [
    "darwin-process-identity-runtime.inc.c",
    "helper",
    "provenance.json",
    "source.c",
  ];
  if (
    JSON.stringify(readdirSync(cacheDirectory).sort()) !==
    JSON.stringify(expectedEntries)
  ) {
    fail("compiled Darwin process identity helper cache has unsafe entries");
  }
  const helperPath = join(cacheDirectory, "helper");
  const provenancePath = join(cacheDirectory, "provenance.json");
  const sources = NATIVE_SOURCES.map(({ cacheName }) => ({
    cacheName,
    bytes: readStableFile(
      join(cacheDirectory, cacheName),
      `cached Darwin process identity source ${cacheName}`,
      { expectedMode: 0o400, maximumBytes: MAX_NATIVE_SOURCE_BYTES },
    ),
  }));
  if (nativeSourcesDigest(sources) !== sourceDigest) {
    fail("cached Darwin process identity source-set digest is invalid");
  }
  const provenanceBytes = readStableFile(
    provenancePath,
    "Darwin process identity helper provenance",
    { expectedMode: 0o400, maximumBytes: 16 * 1024 },
  );
  let provenance;
  try {
    provenance = JSON.parse(provenanceBytes.toString("utf8"));
  } catch {
    fail("Darwin process identity helper provenance is malformed");
  }
  if (
    typeof provenance?.helperDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(provenance.helperDigest) ||
    `${JSON.stringify(provenance)}\n` !==
      `${JSON.stringify(
        nativeCacheProvenance(sourceDigest, provenance.helperDigest),
      )}\n`
  ) {
    fail("Darwin process identity helper provenance is invalid");
  }
  const helper = readStableFile(
    helperPath,
    "compiled Darwin process identity helper",
    {
      expectedMode: 0o500,
      maximumBytes: 8 * 1024 * 1024,
      withMetadata: true,
    },
  );
  if (sha256(helper.bytes) !== provenance.helperDigest) {
    fail("compiled Darwin process identity helper digest is invalid");
  }
  const helperAfter = readStableFile(
    helperPath,
    "compiled Darwin process identity helper",
    {
      expectedMode: 0o500,
      maximumBytes: 8 * 1024 * 1024,
      withMetadata: true,
    },
  );
  if (
    !sameStableFileIdentity(helper.stat, helperAfter.stat) ||
    !helper.bytes.equals(helperAfter.bytes) ||
    sha256(helperAfter.bytes) !== provenance.helperDigest ||
    !sources.every((source) =>
      readStableFile(
        join(cacheDirectory, source.cacheName),
        `cached Darwin process identity source ${source.cacheName}`,
        { expectedMode: 0o400, maximumBytes: MAX_NATIVE_SOURCE_BYTES },
      ).equals(source.bytes),
    ) ||
    !readStableFile(
      provenancePath,
      "Darwin process identity helper provenance",
      { expectedMode: 0o400, maximumBytes: 16 * 1024 },
    ).equals(provenanceBytes)
  ) {
    fail("Darwin process identity helper cache changed during validation");
  }
  validateNativeDirectory(
    cacheDirectory,
    "compiled Darwin process identity helper cache",
    { requirePrivate: true },
  );
  const directoryAfter = lstatSync(cacheDirectory, { bigint: true });
  if (
    directoryBefore.dev !== directoryAfter.dev ||
    directoryBefore.ino !== directoryAfter.ino ||
    JSON.stringify(readdirSync(cacheDirectory).sort()) !==
      JSON.stringify(expectedEntries)
  ) {
    fail(
      "compiled Darwin process identity helper cache changed during validation",
    );
  }
  return Object.freeze({
    cacheDirectory,
    cacheIdentity: stableIdentity(directoryAfter),
    helperDigest: provenance.helperDigest,
    helperIdentity: stableIdentity(helperAfter.stat),
    helperPath,
    sourceDigest,
  });
}

function buildNativeHelperCache(
  scratchDirectory,
  cacheDirectory,
  sources,
  sourceDigest,
) {
  const stagedDirectory = join(
    scratchDirectory,
    `.darwin-process-identity.${process.pid}.${randomUUID()}.staging`,
  );
  const stagedSource = join(stagedDirectory, "source.c");
  const stagedHelper = join(stagedDirectory, "helper");
  const stagedProvenance = join(stagedDirectory, "provenance.json");
  mkdirSync(stagedDirectory, { mode: 0o700 });
  chmodSync(stagedDirectory, 0o700);
  try {
    for (const source of sources) {
      writeExclusiveFile(
        join(stagedDirectory, source.cacheName),
        source.bytes,
        0o400,
        `staged Darwin process identity source ${source.cacheName}`,
      );
    }
    const compiler = spawnSync(
      "/usr/bin/xcrun",
      NATIVE_COMPILER_ARGUMENTS.map((argument) =>
        argument === "__SOURCE__"
          ? stagedSource
          : argument === "__OUTPUT__"
            ? stagedHelper
            : argument,
      ),
      {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          TMPDIR: scratchDirectory,
        },
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    if (compiler.status !== 0) {
      fail(
        `could not compile Darwin process identity helper: ${(
          compiler.stderr ||
          compiler.stdout ||
          compiler.error?.message ||
          "unknown error"
        ).trim()}`,
      );
    }
    const compiledSources = sources.map((source) => ({
      cacheName: source.cacheName,
      bytes: readStableFile(
        join(stagedDirectory, source.cacheName),
        `staged Darwin process identity source ${source.cacheName}`,
        { expectedMode: 0o400, maximumBytes: MAX_NATIVE_SOURCE_BYTES },
      ),
    }));
    if (nativeSourcesDigest(compiledSources) !== sourceDigest) {
      fail(
        "staged Darwin process identity source set changed during compilation",
      );
    }
    chmodSync(stagedHelper, 0o500);
    const helper = readStableFile(
      stagedHelper,
      "staged Darwin process identity helper",
      { expectedMode: 0o500, maximumBytes: 8 * 1024 * 1024 },
    );
    const helperDigest = sha256(helper);
    if (
      sha256(
        readStableFile(stagedHelper, "staged Darwin process identity helper", {
          expectedMode: 0o500,
          maximumBytes: 8 * 1024 * 1024,
        }),
      ) !== helperDigest
    ) {
      fail("staged Darwin process identity helper changed before publication");
    }
    writeExclusiveFile(
      stagedProvenance,
      Buffer.from(
        `${JSON.stringify(nativeCacheProvenance(sourceDigest, helperDigest))}\n`,
        "utf8",
      ),
      0o400,
      "Darwin process identity helper provenance",
    );
    fsyncDirectory(stagedDirectory);
    try {
      renameSync(stagedDirectory, cacheDirectory);
      fsyncDirectory(scratchDirectory);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    }
  } finally {
    if (pathEntryExists(stagedDirectory)) {
      validateNativeDirectory(
        stagedDirectory,
        "staged Darwin process identity helper directory",
        { requirePrivate: true },
      );
      rmSync(stagedDirectory, { recursive: true, force: true });
    }
  }
}

export function nativeHelper(scratchDirectory) {
  validateNativeDirectory(
    scratchDirectory,
    "Darwin process helper scratch directory",
  );
  const sources = validateNativeSources();
  const digest = nativeSourcesDigest(sources);
  const cacheDirectory = join(
    scratchDirectory,
    `darwin-process-identity.${digest}.cache-v3`,
  );
  if (!pathEntryExists(cacheDirectory)) {
    buildNativeHelperCache(scratchDirectory, cacheDirectory, sources, digest);
  }
  return validateNativeHelperCache(cacheDirectory, digest).helperPath;
}

function nativeRetryProfile(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("Darwin native retry profile is not an object");
  }
  const supported = Object.keys(DEFAULT_NATIVE_RETRY_PROFILE).sort();
  if (Object.keys(options).some((key) => !supported.includes(key))) {
    fail("Darwin native retry profile has an unsupported field");
  }
  const profile = { ...DEFAULT_NATIVE_RETRY_PROFILE, ...options };
  const limits = {
    timeoutMs: [1, 60_000],
    maxAttempts: [1, 16],
    maxSpawnTimeoutMs: [1, 30_000],
    initialDelayMs: [1, 5_000],
    maxDelayMs: [1, 5_000],
  };
  for (const [field, [minimum, maximum]] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(profile[field]) ||
      profile[field] < minimum ||
      profile[field] > maximum
    ) {
      fail(`Darwin native retry profile ${field} is outside its safe range`);
    }
  }
  if (
    profile.maxSpawnTimeoutMs > profile.timeoutMs ||
    profile.initialDelayMs > profile.maxDelayMs
  ) {
    fail("Darwin native retry profile bounds are inconsistent");
  }
  return Object.freeze(profile);
}

const NATIVE_RETRY_RUNTIME = Object.freeze({
  now: () => performance.now(),
  pid: process.pid,
  wait: (delayMs) => Atomics.wait(NATIVE_RETRY_WAIT, 0, 0, delayMs),
});

function createNativeRetryBudget(retryProfile, runtime) {
  const profile = nativeRetryProfile(retryProfile);
  return Object.freeze({
    deadlineMs: runtime.now() + profile.timeoutMs,
    profile,
  });
}

function remainingNativeSpawnTimeout(budget, runtime) {
  const remainingMs = Math.floor(budget.deadlineMs - runtime.now());
  if (remainingMs < 1) return 0;
  return Math.min(remainingMs, budget.profile.maxSpawnTimeoutMs);
}

function nativeRetryDelayMs(attempt, pid, profile) {
  const exponential = Math.min(
    profile.maxDelayMs,
    profile.initialDelayMs * 2 ** attempt,
  );
  const mixed =
    (Math.imul(pid >>> 0, 2_654_435_761) ^
      Math.imul((attempt + 1) >>> 0, 2_246_822_519)) >>>
    0;
  return exponential + (mixed % exponential);
}

export function runNative(
  helper,
  args,
  { acceptedStatuses = [0], timeoutMs = 30_000 } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    fail("Darwin native helper timeout is outside its safe range");
  }
  const result = spawnSync(helper, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
    timeout: timeoutMs,
  });
  if (!acceptedStatuses.includes(result.status)) {
    fail(
      `Darwin process identity helper failed (${args[0]}): ${(
        result.stderr ||
        result.stdout ||
        result.error?.message ||
        `status ${result.status}`
      ).trim()}`,
    );
  }
  return result;
}

function runNativeContentionCommand(
  {
    args,
    budget = null,
    contentionError,
    contentionMessage,
    helper,
    invoke = null,
    onContention = null,
    parseSuccess,
    partialEvidenceMessage,
    retryProfile = {},
  },
  runtime = NATIVE_RETRY_RUNTIME,
) {
  const activeBudget = budget ?? createNativeRetryBudget(retryProfile, runtime);
  let lastError = contentionMessage;
  let attempts = 0;
  for (
    let attempt = 0;
    attempt < activeBudget.profile.maxAttempts;
    attempt += 1
  ) {
    const timeoutMs = remainingNativeSpawnTimeout(activeBudget, runtime);
    if (timeoutMs === 0) break;
    const result = invoke
      ? invoke({ attempt, timeoutMs })
      : runNative(helper, args, {
          acceptedStatuses: [0, NATIVE_CONTENTION_RETRY_STATUS],
          timeoutMs,
        });
    attempts += 1;
    if (result.status === 0) {
      return Object.freeze({
        adopted: null,
        attempts,
        value: parseSuccess(result),
      });
    }
    if (result.status !== NATIVE_CONTENTION_RETRY_STATUS) {
      fail(
        `Darwin native test invocation returned unsupported status ${result.status}`,
      );
    }
    if (result.stdout !== "") {
      fail(partialEvidenceMessage);
    }
    lastError = result.stderr.trim() || lastError;
    const adopted = onContention?.();
    if (adopted !== null && adopted !== undefined) {
      return Object.freeze({ adopted, attempts, value: null });
    }
    if (attempt + 1 < activeBudget.profile.maxAttempts) {
      const delayMs = nativeRetryDelayMs(
        attempt,
        runtime.pid,
        activeBudget.profile,
      );
      const remainingMs = activeBudget.deadlineMs - runtime.now();
      if (delayMs >= remainingMs) break;
      runtime.wait(delayMs);
    }
  }
  throw new contentionError(`${contentionMessage}: ${lastError}`);
}

function parseNativeProbe(result) {
  if (result.stdout !== `${PROBE_OUTPUT}\n`) {
    fail("Darwin process identity helper probe returned invalid evidence");
  }
  return PROBE_OUTPUT;
}

function runNativeProbeWithBudget(
  helper,
  budget,
  { onContention = null } = {},
) {
  return runNativeContentionCommand({
    args: ["probe"],
    budget,
    contentionError: DarwinProbeContentionError,
    contentionMessage:
      "Darwin process identity probe stayed contended across its bounded retry profile",
    helper,
    onContention,
    parseSuccess: parseNativeProbe,
    partialEvidenceMessage:
      "contended Darwin process identity probe emitted partial evidence",
  });
}

export function runNativeProbe(helper, retryProfile = {}) {
  const budget = createNativeRetryBudget(retryProfile, NATIVE_RETRY_RUNTIME);
  return runNativeProbeWithBudget(helper, budget).value;
}

function runNativeSnapshotWithBudget(helper, budget) {
  return runNativeContentionCommand({
    args: ["snapshot"],
    budget,
    contentionError: DarwinSnapshotContentionError,
    contentionMessage:
      "Darwin process snapshot did not produce a coherent epoch",
    helper,
    parseSuccess: (result) => parseDarwinProcessSnapshot(result.stdout),
    partialEvidenceMessage:
      "contended Darwin process snapshot emitted partial evidence",
  }).value;
}

export function runNativeSnapshot(helper, retryProfile = {}) {
  const budget = createNativeRetryBudget(retryProfile, NATIVE_RETRY_RUNTIME);
  return runNativeSnapshotWithBudget(helper, budget);
}

function validateNativeRuntimeContext(scratchDirectory, helper) {
  if (
    typeof scratchDirectory !== "string" ||
    resolve(scratchDirectory) !== scratchDirectory ||
    typeof helper !== "string" ||
    resolve(helper) !== helper
  ) {
    fail("Darwin native runtime paths are not absolute and normalized");
  }
  validateNativeDirectory(
    scratchDirectory,
    "Darwin native runtime scratch directory",
  );
  const sources = validateNativeSources();
  const sourceDigest = nativeSourcesDigest(sources);
  const cacheDirectory = join(
    scratchDirectory,
    `darwin-process-identity.${sourceDigest}.cache-v3`,
  );
  if (helper !== join(cacheDirectory, "helper")) {
    fail("Darwin native runtime helper is outside its expected cache");
  }
  return validateNativeHelperCache(cacheDirectory, sourceDigest);
}

function sameNativeRuntimeEvidence(left, right) {
  return (
    left.cacheDirectory === right.cacheDirectory &&
    left.helperPath === right.helperPath &&
    left.sourceDigest === right.sourceDigest &&
    left.helperDigest === right.helperDigest &&
    left.cacheIdentity.dev === right.cacheIdentity.dev &&
    left.cacheIdentity.ino === right.cacheIdentity.ino &&
    left.helperIdentity.dev === right.helperIdentity.dev &&
    left.helperIdentity.ino === right.helperIdentity.ino
  );
}

function requireSameNativeRuntimeEvidence(before, after) {
  if (!sameNativeRuntimeEvidence(before, after)) {
    fail("Darwin native helper cache changed during runtime validation");
  }
}

function runtimeReceiptPath(scratchDirectory, evidence) {
  return join(
    scratchDirectory,
    `${basename(evidence.cacheDirectory)}.runtime-receipt-v1.json`,
  );
}

export function nativeHelperRuntimeReceiptPath(scratchDirectory, helper) {
  const evidence = validateNativeRuntimeContext(scratchDirectory, helper);
  return runtimeReceiptPath(scratchDirectory, evidence);
}

function nativeRuntimeReceipt(evidence, bootId) {
  return Object.freeze({
    schema: NATIVE_RUNTIME_RECEIPT_SCHEMA,
    sourceDigest: evidence.sourceDigest,
    helperDigest: evidence.helperDigest,
    cacheName: basename(evidence.cacheDirectory),
    cacheIdentity: evidence.cacheIdentity,
    helperIdentity: evidence.helperIdentity,
    bootId,
  });
}

function readNativeRuntimeReceipt(
  receiptPath,
  expected,
  { allowMissing = false } = {},
) {
  if (!pathEntryExists(receiptPath)) {
    if (allowMissing) return null;
    throw new DarwinNativeRuntimeReceiptMissingError(
      "Darwin native runtime capability receipt is missing",
    );
  }
  const bytes = readStableFile(
    receiptPath,
    "Darwin native runtime capability receipt",
    { expectedMode: 0o400, maximumBytes: 4 * 1024 },
  );
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("Darwin native runtime capability receipt is malformed");
  }
  const canonical = `${JSON.stringify(expected)}\n`;
  if (
    JSON.stringify(receipt) !== JSON.stringify(expected) ||
    bytes.toString("utf8") !== canonical
  ) {
    fail("Darwin native runtime capability receipt is invalid");
  }
  return Object.freeze({ ...expected });
}

function waitForPublishedReceipt(receiptPath, expected) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stat = lstatSync(receiptPath, { bigint: true });
    if (stat.nlink === 1n) {
      return readNativeRuntimeReceipt(receiptPath, expected);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2n) {
      return readNativeRuntimeReceipt(receiptPath, expected);
    }
    Atomics.wait(NATIVE_RETRY_WAIT, 0, 0, 2);
  }
  return readNativeRuntimeReceipt(receiptPath, expected);
}

function publishNativeRuntimeReceipt(receiptPath, expected) {
  const directory = dirname(receiptPath);
  const bytes = Buffer.from(`${JSON.stringify(expected)}\n`, "utf8");
  const stagedPath = join(
    directory,
    `.${basename(receiptPath)}.${process.pid}.${randomUUID()}.staging`,
  );
  let linked = false;
  writeExclusiveFile(
    stagedPath,
    bytes,
    0o400,
    "staged Darwin native runtime capability receipt",
  );
  let stagedExists = true;
  fsyncDirectory(directory);
  try {
    try {
      linkSync(stagedPath, receiptPath);
      linked = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (linked) {
      const staged = readStableFile(
        stagedPath,
        "staged Darwin native runtime capability receipt",
        { expectedLinks: 2, expectedMode: 0o400, maximumBytes: 4 * 1024 },
      );
      const published = readStableFile(
        receiptPath,
        "published Darwin native runtime capability receipt",
        { expectedLinks: 2, expectedMode: 0o400, maximumBytes: 4 * 1024 },
      );
      const stagedStat = lstatSync(stagedPath, { bigint: true });
      const publishedStat = lstatSync(receiptPath, { bigint: true });
      if (
        !staged.equals(bytes) ||
        !published.equals(bytes) ||
        stagedStat.dev !== publishedStat.dev ||
        stagedStat.ino !== publishedStat.ino
      ) {
        fail("Darwin native runtime capability receipt publication changed");
      }
    }
    const staged = readStableFile(
      stagedPath,
      "staged Darwin native runtime capability receipt",
      {
        expectedLinks: linked ? 2 : 1,
        expectedMode: 0o400,
        maximumBytes: 4 * 1024,
      },
    );
    if (!staged.equals(bytes)) {
      fail("staged Darwin native runtime capability receipt changed");
    }
    unlinkSync(stagedPath);
    stagedExists = false;
    fsyncDirectory(directory);
    return Object.freeze({
      receipt: linked
        ? readNativeRuntimeReceipt(receiptPath, expected)
        : waitForPublishedReceipt(receiptPath, expected),
      reused: !linked,
    });
  } finally {
    if (stagedExists && pathEntryExists(stagedPath)) {
      const staged = readStableFile(
        stagedPath,
        "staged Darwin native runtime capability receipt",
        {
          expectedLinks: linked ? 2 : 1,
          expectedMode: 0o400,
          maximumBytes: 4 * 1024,
        },
      );
      if (!staged.equals(bytes)) {
        fail("staged Darwin native runtime capability receipt changed");
      }
      unlinkSync(stagedPath);
      fsyncDirectory(directory);
    }
  }
}

function bootIdentityWithinBudget(helper, budget, runtime) {
  const timeoutMs = remainingNativeSpawnTimeout(budget, runtime);
  if (timeoutMs === 0) {
    fail("Darwin native runtime validation exceeded its monotonic deadline");
  }
  const bootId = runNative(helper, ["boot-id"], { timeoutMs }).stdout.trimEnd();
  if (!BOOT_ID.test(bootId)) {
    fail("Darwin boot identity has an invalid shape");
  }
  return bootId;
}

export function requireNativeHelperRuntime(
  scratchDirectory,
  helper,
  retryProfile = {},
) {
  const budget = createNativeRetryBudget(retryProfile, NATIVE_RETRY_RUNTIME);
  const before = validateNativeRuntimeContext(scratchDirectory, helper);
  const beforeBootId = bootIdentityWithinBudget(
    helper,
    budget,
    NATIVE_RETRY_RUNTIME,
  );
  const receiptPath = runtimeReceiptPath(scratchDirectory, before);
  const expected = nativeRuntimeReceipt(before, beforeBootId);
  const receipt = readNativeRuntimeReceipt(receiptPath, expected);
  const afterBootId = bootIdentityWithinBudget(
    helper,
    budget,
    NATIVE_RETRY_RUNTIME,
  );
  if (beforeBootId !== afterBootId) {
    fail("Darwin boot identity changed during runtime receipt validation");
  }
  const after = validateNativeRuntimeContext(scratchDirectory, helper);
  requireSameNativeRuntimeEvidence(before, after);
  return Object.freeze({
    bootId: beforeBootId,
    helper,
    receipt,
    receiptPath,
  });
}

export function validateNativeHelperRuntime(
  scratchDirectory,
  helper,
  retryProfile = {},
) {
  const budget = createNativeRetryBudget(retryProfile, NATIVE_RETRY_RUNTIME);
  const before = validateNativeRuntimeContext(scratchDirectory, helper);
  const receiptPath = runtimeReceiptPath(scratchDirectory, before);
  const beforeBootId = bootIdentityWithinBudget(
    helper,
    budget,
    NATIVE_RETRY_RUNTIME,
  );
  const expected = nativeRuntimeReceipt(before, beforeBootId);
  let receipt = readNativeRuntimeReceipt(receiptPath, expected, {
    allowMissing: true,
  });
  let reusedReceipt = receipt !== null;
  if (receipt === null) {
    const probe = runNativeProbeWithBudget(helper, budget, {
      onContention: () =>
        readNativeRuntimeReceipt(receiptPath, expected, {
          allowMissing: true,
        }),
    });
    if (probe.adopted !== null) {
      receipt = probe.adopted;
      reusedReceipt = true;
    }
  }
  const snapshot = runNativeSnapshotWithBudget(helper, budget);
  const afterBootId = bootIdentityWithinBudget(
    helper,
    budget,
    NATIVE_RETRY_RUNTIME,
  );
  if (beforeBootId !== afterBootId) {
    fail("Darwin boot identity changed during native runtime validation");
  }
  const after = validateNativeRuntimeContext(scratchDirectory, helper);
  requireSameNativeRuntimeEvidence(before, after);
  if (remainingNativeSpawnTimeout(budget, NATIVE_RETRY_RUNTIME) === 0) {
    fail("Darwin native runtime validation exceeded its monotonic deadline");
  }
  if (receipt !== null) {
    readNativeRuntimeReceipt(receiptPath, expected);
  } else {
    const publication = publishNativeRuntimeReceipt(receiptPath, expected);
    receipt = publication.receipt;
    reusedReceipt = publication.reused;
  }
  return Object.freeze({
    bootId: beforeBootId,
    helper,
    receipt,
    receiptPath,
    reusedReceipt,
    snapshot,
  });
}

export const darwinNativeHelperTrustForTest = Object.freeze({
  cacheSchema: NATIVE_CACHE_SCHEMA,
  compilerArguments: NATIVE_COMPILER_ARGUMENTS,
  createRetryBudget: createNativeRetryBudget,
  defaultRetryProfile: DEFAULT_NATIVE_RETRY_PROFILE,
  nativeCacheProvenance,
  nativeSourceDigest: () => nativeSourcesDigest(validateNativeSources()),
  readNativeSource: (path) =>
    readStableFile(path, "Darwin process identity test source", {
      maximumBytes: MAX_NATIVE_SOURCE_BYTES,
    }),
  readNativeSources: validateNativeSources,
  retryDelayMs: nativeRetryDelayMs,
  runContentionCommand: runNativeContentionCommand,
  runtimeReceiptSchema: NATIVE_RUNTIME_RECEIPT_SCHEMA,
  sourceNames: Object.freeze(NATIVE_SOURCES.map(({ cacheName }) => cacheName)),
});
