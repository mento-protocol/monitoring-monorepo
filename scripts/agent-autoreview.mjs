#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  assertNoSecretLikeContent,
  buildBoundedReviewPrompts,
  createReviewInputCollector,
  isWithin,
  MAX_REVIEW_INPUT_BYTES,
  normalizedGitFileMode,
  readBoundedRegularFile,
  readSafeEvidenceFile,
  reviewPromptOutputPaths,
  sensitivePathReason,
  serializeSafeUntrackedFile,
  utf8Size,
  writeReviewPromptOutputs,
} from "./agent-autoreview-core.mjs";

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "findings",
    "overall_correctness",
    "overall_explanation",
    "overall_confidence",
  ],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "body",
          "priority",
          "confidence",
          "category",
          "code_location",
        ],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 140 },
          body: { type: "string", minLength: 1, maxLength: 2000 },
          priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          category: {
            type: "string",
            enum: [
              "bug",
              "security",
              "regression",
              "test_gap",
              "maintainability",
            ],
          },
          code_location: {
            type: "object",
            additionalProperties: false,
            required: ["file_path", "line"],
            properties: {
              file_path: { type: "string", minLength: 1 },
              line: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    overall_correctness: {
      type: "string",
      enum: ["patch is correct", "patch is incorrect"],
    },
    overall_explanation: { type: "string", minLength: 1, maxLength: 3000 },
    overall_confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

const ENGINES = new Set(["codex", "claude", "local"]);
const TARGET_MODES = new Set(["auto", "local", "branch", "commit"]);
const FROZEN_TARGET_MODES = new Set([
  "local",
  "branch",
  "branch-local",
  "commit",
]);
const MAX_GIT_OUTPUT_BYTES = MAX_REVIEW_INPUT_BYTES + 12 * 1024 * 1024;
const MAX_TRUSTED_ENGINE_FILE_BYTES = 16 * 1024 * 1024;
const CLAUDE_SAFE_MODE_MIN_VERSION = [2, 1, 169];
const AWS_CREDENTIAL_CONFIG_KEYS = new Set([
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
]);
const trustedExecutableSnapshots = new Map();
const trustedExecutableSnapshotsByPath = new Map();
const trustedExecutableSnapshotDirs = new Set();
const engineRuntimeDirectories = new Map();
const activeReviewerChildren = new Set();
const activeReviewerAborters = new Map();
const terminationSignalHandlers = new Map();
const rejectedTrustedExecutableCandidates = new Set();
const writeGrantingAclCache = new Map();
const attestedNodeLibraryPathRecords = new Map();
let trustedExecutableCleanupRegistered = false;
let pendingTerminationSignal = null;
let reviewerForceKillTimer = null;
const stageTimings = [];
let stageDurationsContext = null;

function usage() {
  console.log(`Usage:
  scripts/agent-autoreview.mjs [options]
  pnpm agent:autoreview [adapter options] -- [review options]

Options:
  --mode <auto|local|branch|commit>  Review target mode (default: auto)
  --base <ref>                       Base ref for branch mode
  --commit <ref>                     Commit ref for commit mode (default: HEAD)
  --engine <codex|claude|local>      Review engine (default: AUTOREVIEW_ENGINE or codex)
  --model <name>                     Model passed through to the engine
  --thinking <level>                 Codex reasoning effort or Claude effort
  --prompt <text>                    Extra review instruction (repeatable)
  --prompt-file <path>               Repo-relative review instruction file (repeatable)
  --dataset <path>                   Repo-relative evidence file (repeatable)
  --output <path>                    Write human output to a file as well as stdout
  --json-output <path>               Write validated structured JSON
  --bundle-output <path>             Write the full review prompt/change bundle
  --bundle-output-display <path>     Adapter-facing display path for bundle output
  --prepare-only                     Build target/bundle metadata for subagent review, then exit
  --trusted-input-root <path>        Adapter-only root for generated review evidence
  --source-snapshot-only             Print a target-scoped source fingerprint and exit
  --serialize-untracked-file <path>  Print bounded evidence for one repo-relative untracked file
  --timeout-seconds <seconds>        Reviewer process timeout (default: 1800)
  --dry-run                          Print target/engine without invoking a reviewer
  --no-tools                         Disable Claude tools and MCP servers; Codex requires read-only sandbox
  --web-search                       Enable reviewer web search (disabled by default)
  --no-web-search                    Disable reviewer web search explicitly
  --stream-engine-output             Show raw engine output before structured parsing
  --help                             Show this help

Adapter-only options (pnpm agent:autoreview, before any -- separator):
  --prepare-bundle-dir <dir>         Publish a verified fresh-context review bundle
  --feedback-pr <number|auto>        Include normalized PR feedback in that bundle
  --verify-bundle-dir <dir>          Rehash a published bundle and print its manifest
  --expected-bundle-manifest <sha>   Bind a post-review check to the retained pre-check digest

Note:
  Inside an active Codex session, a repo adapter should use --prepare-bundle-dir
  plus its bound pre/post verification flow. For this standalone helper only,
  use --prepare-only --bundle-output <path> instead of nested codex exec.
`);
}

function parseArgs(argv) {
  const args = {
    mode: "auto",
    base: null,
    commit: "HEAD",
    engine: process.env.AUTOREVIEW_ENGINE || "codex",
    model: null,
    thinking: null,
    prompts: [],
    promptFiles: [],
    datasets: [],
    output: null,
    jsonOutput: null,
    bundleOutput: null,
    bundleOutputDisplay: null,
    prepareOnly: false,
    trustedInputRoot: null,
    sourceSnapshotOnly: false,
    frozenTargetMode: null,
    frozenHeadOid: null,
    dryRun: false,
    tools: true,
    webSearch: false,
    streamEngineOutput: false,
    timeoutSeconds: 1800,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const equalsIndex =
      value.startsWith("--") && value !== "--" ? value.indexOf("=") : -1;
    const option = equalsIndex === -1 ? value : value.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? null : value.slice(equalsIndex + 1);
    const next = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${value} requires an argument`);
      }
      return argv[index];
    };

    switch (option) {
      case "--":
        break;
      case "--mode":
        args.mode = next();
        break;
      case "--base":
        args.base = next();
        break;
      case "--commit":
        args.commit = next();
        break;
      case "--engine":
        args.engine = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--thinking":
        args.thinking = next();
        break;
      case "--prompt":
        args.prompts.push(next());
        break;
      case "--prompt-file":
        args.promptFiles.push(next());
        break;
      case "--dataset":
        args.datasets.push(next());
        break;
      case "--output":
        args.output = next();
        break;
      case "--json-output":
        args.jsonOutput = next();
        break;
      case "--bundle-output":
        args.bundleOutput = next();
        break;
      case "--bundle-output-display":
        args.bundleOutputDisplay = next();
        break;
      case "--prepare-only":
        args.prepareOnly = true;
        break;
      case "--trusted-input-root":
        args.trustedInputRoot = next();
        break;
      case "--source-snapshot-only":
        args.sourceSnapshotOnly = true;
        break;
      case "--frozen-target-mode":
        args.frozenTargetMode = next();
        break;
      case "--frozen-head-oid":
        args.frozenHeadOid = next();
        break;
      case "--parallel-tests":
        next();
        throw new Error(
          "--parallel-tests was removed; run pnpm agent:quality-gate --run before autoreview",
        );
      case "--timeout-seconds":
        args.timeoutSeconds = Number.parseInt(next(), 10);
        if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
          throw new Error("--timeout-seconds must be a positive integer");
        }
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--no-tools":
        args.tools = false;
        break;
      case "--web-search":
        args.webSearch = true;
        break;
      case "--no-web-search":
        args.webSearch = false;
        break;
      case "--stream-engine-output":
        args.streamEngineOutput = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${value}`);
    }
  }

  if (!TARGET_MODES.has(args.mode)) {
    throw new Error(`invalid --mode: ${args.mode}`);
  }
  if (
    (args.frozenTargetMode === null) !== (args.frozenHeadOid === null) ||
    (args.frozenTargetMode !== null &&
      (!FROZEN_TARGET_MODES.has(args.frozenTargetMode) ||
        !/^[0-9a-f]{40,64}$/i.test(args.frozenHeadOid)))
  ) {
    throw new Error(
      "--frozen-target-mode and --frozen-head-oid require a valid paired frozen target",
    );
  }
  if (!ENGINES.has(args.engine)) {
    throw new Error(`invalid --engine: ${args.engine}`);
  }
  if (args.bundleOutputDisplay && !args.bundleOutput) {
    throw new Error("--bundle-output-display requires --bundle-output");
  }
  return args;
}

function checkoutRootFrom(start) {
  let current = realpathSync(start);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return realpathSync(start);
    current = parent;
  }
}

function effectiveUid() {
  if (typeof process.geteuid !== "function") {
    throw new Error("trusted executable resolution requires an effective UID");
  }
  return BigInt(process.geteuid());
}

function trustedOwner(fileStat) {
  const uid = effectiveUid();
  return fileStat.uid === 0n || fileStat.uid === uid;
}

function sharedWritable(fileStat) {
  return (fileStat.mode & 0o022n) !== 0n;
}

function sameFileMetadata(left, right) {
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

function sameDirectorySecurityMetadata(left, right) {
  return ["dev", "ino", "mode", "uid", "gid"].every(
    (field) => left[field] === right[field],
  );
}

function aclMetadataKey(fileStat) {
  return [
    fileStat.dev,
    fileStat.ino,
    fileStat.mode,
    fileStat.uid,
    fileStat.gid,
    fileStat.ctimeNs,
  ].join(":");
}

function hasWriteGrantingAcl(candidate, fileStat, label = "executable") {
  if (process.platform !== "darwin") return false;
  const metadataKey = aclMetadataKey(fileStat);
  const cached = writeGrantingAclCache.get(candidate);
  if (cached?.metadataKey === metadataKey) return cached.result;
  const result = spawnSync("/bin/ls", ["-lde", candidate], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`failed to inspect ${label} ACL at ${candidate}`);
  }
  const writeGrant =
    /\ballow\b.*\b(?:write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)\b/;
  const value = result.stdout
    .split("\n")
    .slice(1)
    .some((line) => writeGrant.test(line));
  writeGrantingAclCache.set(candidate, { metadataKey, result: value });
  return value;
}

function executableForCurrentUser(fileStat) {
  const mode = fileStat.mode & 0o777n;
  const uid = effectiveUid();
  if (uid === 0n) return (mode & 0o111n) !== 0n;
  if (fileStat.uid === uid) return (mode & 0o100n) !== 0n;
  const groups = new Set(
    [
      ...(typeof process.getgroups === "function" ? process.getgroups() : []),
      ...(typeof process.getegid === "function" ? [process.getegid()] : []),
    ].map((group) => BigInt(group)),
  );
  if (groups.has(fileStat.gid)) return (mode & 0o010n) !== 0n;
  return (mode & 0o001n) !== 0n;
}

function inspectTrustedDirectoryAncestry(directory, label = "executable") {
  const records = [];
  let current = directory;
  while (true) {
    const fileStat = lstatSync(current, { bigint: true });
    if (!fileStat.isDirectory() || !trustedOwner(fileStat)) {
      throw new Error(`untrusted ${label} directory ancestry at ${current}`);
    }
    records.push({
      path: current,
      fileStat,
      writeGrantingAcl: hasWriteGrantingAcl(current, fileStat, label),
    });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return records;
}

function assertStableDirectoryAncestry(before, after, label = "executable") {
  if (
    before.length !== after.length ||
    before.some(
      (record, index) =>
        record.path !== after[index].path ||
        record.writeGrantingAcl !== after[index].writeGrantingAcl ||
        !sameDirectorySecurityMetadata(record.fileStat, after[index].fileStat),
    )
  ) {
    throw new Error(`${label} directory ancestry changed during validation`);
  }
}

function secureReadFlags({ nonBlocking = false } = {}) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("O_NOFOLLOW is required for trusted executable resolution");
  }
  if (nonBlocking && !Number.isInteger(fsConstants.O_NONBLOCK)) {
    throw new Error(
      "O_NONBLOCK is required for trusted external file snapshots",
    );
  }
  return (
    fsConstants.O_RDONLY |
    fsConstants.O_NOFOLLOW |
    (fsConstants.O_CLOEXEC || 0) |
    (nonBlocking ? fsConstants.O_NONBLOCK : 0)
  );
}

function secureWriteFlags() {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("O_NOFOLLOW is required for trusted executable snapshots");
  }
  return (
    fsConstants.O_RDWR |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_NOFOLLOW |
    (fsConstants.O_CLOEXEC || 0)
  );
}

function cleanupTrustedExecutableSnapshots() {
  for (const directory of [...engineRuntimeDirectories.keys()]) {
    removeEngineRuntimeDirectory(directory, { bestEffort: true });
  }
  for (const directory of trustedExecutableSnapshotDirs) {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup during process exit.
    }
  }
  trustedExecutableSnapshotDirs.clear();
  trustedExecutableSnapshots.clear();
  trustedExecutableSnapshotsByPath.clear();
  rejectedTrustedExecutableCandidates.clear();
  writeGrantingAclCache.clear();
  attestedNodeLibraryPathRecords.clear();
}

function registerEngineRuntimeDirectory(directory) {
  const fileStat = lstatSync(directory, { bigint: true });
  if (
    !fileStat.isDirectory() ||
    fileStat.uid !== effectiveUid() ||
    (fileStat.mode & 0o077n) !== 0n ||
    hasWriteGrantingAcl(directory, fileStat, "engine runtime directory")
  ) {
    throw new Error("engine runtime directory is not private");
  }
  engineRuntimeDirectories.set(directory, {
    credentialSnapshots: new Map(),
    fileStat,
  });
  registerTrustedExecutableCleanup();
}

function createRegisteredEngineRuntimeDirectory(root, prefix) {
  const directory = mkdtempSync(path.join(root, prefix));
  try {
    registerEngineRuntimeDirectory(directory);
    return directory;
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

function registerEngineCredentialSnapshot(runtimeDir, outputPath, fileStat) {
  const record = engineRuntimeDirectories.get(runtimeDir);
  if (!record) {
    throw new Error("engine runtime is not registered for credential cleanup");
  }
  record.credentialSnapshots.set(outputPath, fileStat);
}

function removeEngineCredentialSnapshots(
  directory,
  { bestEffort = false } = {},
) {
  const record = engineRuntimeDirectories.get(directory);
  if (!record) return;
  for (const [outputPath, expected] of record.credentialSnapshots) {
    let removed = false;
    try {
      let current;
      try {
        current = lstatSync(outputPath, { bigint: true });
      } catch (error) {
        if (error.code === "ENOENT") {
          removed = true;
          continue;
        }
        throw error;
      }
      if (
        !current.isFile() ||
        current.uid !== effectiveUid() ||
        !sameFileMetadata(expected, current)
      ) {
        throw new Error("engine credential snapshot identity changed");
      }
      rmSync(outputPath, { force: true });
      removed = true;
    } catch (error) {
      if (!bestEffort) throw error;
    } finally {
      if (removed) record.credentialSnapshots.delete(outputPath);
    }
  }
}

function removeAllEngineCredentialSnapshots({ bestEffort = false } = {}) {
  for (const directory of engineRuntimeDirectories.keys()) {
    removeEngineCredentialSnapshots(directory, { bestEffort });
  }
}

function removeEngineRuntimeDirectory(directory, { bestEffort = false } = {}) {
  const record = engineRuntimeDirectories.get(directory);
  if (!record) return;
  try {
    removeEngineCredentialSnapshots(directory, { bestEffort });
    let current;
    try {
      current = lstatSync(directory, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (
      !current.isDirectory() ||
      current.uid !== effectiveUid() ||
      !sameDirectorySecurityMetadata(record.fileStat, current)
    ) {
      throw new Error("engine runtime directory identity changed");
    }
    rmSync(directory, { force: true, recursive: true });
  } catch (error) {
    if (!bestEffort) throw error;
  } finally {
    engineRuntimeDirectories.delete(directory);
  }
}

function clearReviewerForceKillTimer() {
  if (!reviewerForceKillTimer) return;
  clearTimeout(reviewerForceKillTimer);
  reviewerForceKillTimer = null;
}

function signalReviewerProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && Number.isInteger(child.pid)) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function terminateActiveReviewerChildren(signal = "SIGTERM") {
  for (const child of activeReviewerChildren) {
    try {
      signalReviewerProcessGroup(child, signal);
    } catch {
      // The close/error path will finish process cleanup.
    }
  }
  if (
    signal !== "SIGKILL" &&
    activeReviewerChildren.size > 0 &&
    !reviewerForceKillTimer
  ) {
    reviewerForceKillTimer = setTimeout(() => {
      reviewerForceKillTimer = null;
      terminateActiveReviewerChildren("SIGKILL");
      for (const abort of [...activeReviewerAborters.values()]) {
        abort(new Error("reviewer process group did not terminate"));
      }
    }, 5000);
    reviewerForceKillTimer.unref?.();
  }
}

function requestProcessTermination(signal) {
  if (pendingTerminationSignal) {
    removeAllEngineCredentialSnapshots({ bestEffort: true });
    terminateActiveReviewerChildren("SIGKILL");
    return;
  }
  pendingTerminationSignal = signal;
  removeAllEngineCredentialSnapshots({ bestEffort: true });
  terminateActiveReviewerChildren();
  setImmediate(() => terminateActiveReviewerChildren());
}

function finishPendingProcessTermination() {
  if (!pendingTerminationSignal) return;
  const signal = pendingTerminationSignal;
  pendingTerminationSignal = null;
  clearReviewerForceKillTimer();
  cleanupTrustedExecutableSnapshots();
  for (const [registeredSignal, handler] of terminationSignalHandlers) {
    process.off(registeredSignal, handler);
  }
  terminationSignalHandlers.clear();
  process.kill(process.pid, signal);
}

function registerTrustedExecutableCleanup() {
  if (trustedExecutableCleanupRegistered) return;
  trustedExecutableCleanupRegistered = true;
  process.once("exit", cleanupTrustedExecutableSnapshots);
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => requestProcessTermination(signal);
    terminationSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function assertPrivateSnapshotDirectory(directory) {
  const fileStat = lstatSync(directory, { bigint: true });
  if (
    !fileStat.isDirectory() ||
    fileStat.uid !== effectiveUid() ||
    (fileStat.mode & 0o077n) !== 0n ||
    hasWriteGrantingAcl(directory, fileStat)
  ) {
    throw new Error("trusted executable snapshot directory is not private");
  }
}

function assertPrivateSnapshotRecord(record) {
  const directoryStat = lstatSync(record.directory, { bigint: true });
  assertPrivateSnapshotDirectory(record.directory);
  if (!sameDirectorySecurityMetadata(record.directoryStat, directoryStat)) {
    throw new Error("trusted executable snapshot directory changed");
  }
  const fileStat = lstatSync(record.outputPath, { bigint: true });
  if (
    !fileStat.isFile() ||
    fileStat.uid !== effectiveUid() ||
    sharedWritable(fileStat) ||
    (fileStat.mode & 0o6000n) !== 0n ||
    fileStat.nlink !== 1n ||
    hasWriteGrantingAcl(record.outputPath, fileStat) ||
    !sameFileMetadata(record.fileStat, fileStat)
  ) {
    throw new Error("trusted executable snapshot changed");
  }
}

function revalidateTrustedExecutableSnapshot(executable) {
  const record = trustedExecutableSnapshotsByPath.get(executable);
  if (record) assertPrivateSnapshotRecord(record);
}

function revalidateAllTrustedExecutableSnapshots() {
  for (const record of trustedExecutableSnapshotsByPath.values()) {
    assertPrivateSnapshotRecord(record);
  }
}

function spawnTrustedSync(command, args, options) {
  revalidateAllTrustedExecutableSnapshots();
  return spawnSync(command, args, options);
}

function machoMagic(prefix) {
  if (prefix.length < 4) return false;
  const magic = prefix.subarray(0, 4).toString("hex");
  return new Set([
    "feedface",
    "cefaedfe",
    "feedfacf",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]).has(magic);
}

function assertNativeMachOPrefix(prefix) {
  if (prefix.subarray(0, 2).toString("utf8") === "#!" || !machoMagic(prefix)) {
    throw new Error(
      "unsafe executable ancestry fallback requires a native Mach-O binary",
    );
  }
}

function assertSafeMachOSnapshotClosure(repo, outputPath, prefix) {
  if (process.platform !== "darwin") {
    throw new Error(
      "unsafe executable ancestry cannot be snapshotted on this platform",
    );
  }
  assertNativeMachOPrefix(prefix);
  const otool = trustedExecutableCandidate(
    "/usr/bin/otool",
    realpathSync(repo),
    "otool",
    { allowSnapshot: false },
  );
  const result = spawnTrustedSync(otool, ["-L", outputPath], {
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error("failed to inspect Mach-O dependency closure");
  }
  let headers = 0;
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(outputPath) && line.endsWith(":")) {
      headers += 1;
      continue;
    }
    const match = line.match(/^(\S+)\s+\(compatibility version [^)]+\)$/);
    const dependency = match?.[1] || "";
    const normalizedDependency = path.posix.normalize(dependency);
    if (
      normalizedDependency !== dependency ||
      (!dependency.startsWith("/usr/lib/") &&
        !dependency.startsWith("/System/Library/"))
    ) {
      throw new Error(
        `unsafe Mach-O dependency prevents executable snapshot: ${dependency || line}`,
      );
    }
  }
  if (headers === 0) {
    throw new Error("otool did not identify the executable as Mach-O");
  }
  const loadCommands = spawnTrustedSync(otool, ["-l", outputPath], {
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (loadCommands.error || loadCommands.status !== 0) {
    throw new Error("failed to inspect Mach-O load commands");
  }
  let currentLoadCommand = "";
  let sawSystemDylinker = false;
  for (const rawLine of loadCommands.stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "cmd LC_RPATH" || line === "cmd LC_DYLD_ENVIRONMENT") {
      throw new Error("unsafe Mach-O loader command prevents snapshot");
    }
    if (line.startsWith("cmd ")) {
      currentLoadCommand = line.slice("cmd ".length);
      continue;
    }
    if (currentLoadCommand === "LC_LOAD_DYLINKER" && line.startsWith("name ")) {
      const dylinkerMatch = line.match(/^name (.+) \(offset \d+\)$/);
      const dylinker = dylinkerMatch?.[1] || "";
      if (dylinker !== "/usr/lib/dyld") {
        throw new Error("unsafe Mach-O dynamic linker prevents snapshot");
      }
      sawSystemDylinker = true;
    }
  }
  if (!sawSystemDylinker) {
    throw new Error("Mach-O snapshot omitted the system dynamic linker");
  }
}

function streamAndHashRegularFile(
  sourceDescriptor,
  outputDescriptor,
  size,
  label,
  maxBytes = Number.MAX_SAFE_INTEGER,
) {
  if (
    size < 0n ||
    size > BigInt(Number.MAX_SAFE_INTEGER) ||
    size > BigInt(maxBytes)
  ) {
    throw new Error(`${label} is too large to snapshot safely`);
  }
  const expectedBytes = Number(size);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const sourceHash = createHash("sha256");
  const prefix = Buffer.alloc(4);
  let position = 0;
  while (position < expectedBytes) {
    const bytesRead = readSync(
      sourceDescriptor,
      buffer,
      0,
      Math.min(buffer.length, expectedBytes - position),
      position,
    );
    if (bytesRead === 0) {
      throw new Error(`${label} changed while being snapshotted`);
    }
    if (position < prefix.length) {
      buffer.copy(
        prefix,
        position,
        0,
        Math.min(bytesRead, prefix.length - position),
      );
    }
    sourceHash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const bytesWritten = writeSync(
        outputDescriptor,
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (bytesWritten === 0) {
        throw new Error(`${label} snapshot write stalled`);
      }
      written += bytesWritten;
    }
    position += bytesRead;
  }
  if (readSync(sourceDescriptor, buffer, 0, 1, position) !== 0) {
    throw new Error(`${label} grew while being snapshotted`);
  }

  const outputHash = createHash("sha256");
  position = 0;
  while (position < expectedBytes) {
    const bytesRead = readSync(
      outputDescriptor,
      buffer,
      0,
      Math.min(buffer.length, expectedBytes - position),
      position,
    );
    if (bytesRead === 0) {
      throw new Error(`${label} snapshot is truncated`);
    }
    outputHash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (sourceHash.digest("hex") !== outputHash.digest("hex")) {
    throw new Error(`${label} snapshot digest mismatch`);
  }
  return prefix;
}

function streamAndHashExecutable(sourceDescriptor, outputDescriptor, size) {
  return streamAndHashRegularFile(
    sourceDescriptor,
    outputDescriptor,
    size,
    "trusted executable",
  );
}

function publishTrustedExecutableSnapshot(
  repo,
  sourcePath,
  executableName,
  sourceDescriptor,
  sourceStat,
  ancestryBefore,
) {
  const tempRoot = safeTempRoot(repo);
  const directory = mkdtempSync(
    path.join(tempRoot, "autoreview-trusted-exec."),
  );
  trustedExecutableSnapshotDirs.add(directory);
  registerTrustedExecutableCleanup();
  try {
    chmodSync(directory, 0o700);
    assertPrivateSnapshotDirectory(directory);
    const safeName = /^[A-Za-z0-9._+-]+$/.test(executableName)
      ? executableName
      : "executable";
    const outputPath = path.join(directory, safeName);
    const descriptor = openSync(outputPath, secureWriteFlags(), 0o500);
    let outputStat;
    let prefix;
    try {
      prefix = streamAndHashExecutable(
        sourceDescriptor,
        descriptor,
        sourceStat.size,
      );
      const sourceAfter = fstatSync(sourceDescriptor, { bigint: true });
      const sourcePathAfter = lstatSync(sourcePath, { bigint: true });
      if (
        !sameFileMetadata(sourceStat, sourceAfter) ||
        !sameFileMetadata(sourceStat, sourcePathAfter)
      ) {
        throw new Error(
          "executable identity or metadata changed during snapshot",
        );
      }
      const ancestryAfter = inspectTrustedDirectoryAncestry(
        path.dirname(sourcePath),
      );
      assertStableDirectoryAncestry(ancestryBefore, ancestryAfter);
      fchmodSync(descriptor, 0o500);
      fsyncSync(descriptor);
      outputStat = fstatSync(descriptor, { bigint: true });
      if (
        !outputStat.isFile() ||
        outputStat.uid !== effectiveUid() ||
        sharedWritable(outputStat) ||
        (outputStat.mode & 0o6000n) !== 0n ||
        outputStat.nlink !== 1n ||
        outputStat.size !== sourceStat.size
      ) {
        throw new Error("trusted executable snapshot failed validation");
      }
      const pathStat = lstatSync(outputPath, { bigint: true });
      if (!sameFileMetadata(outputStat, pathStat)) {
        throw new Error("trusted executable snapshot changed during publish");
      }
    } finally {
      closeSync(descriptor);
    }
    const record = {
      directory,
      directoryStat: lstatSync(directory, { bigint: true }),
      fileStat: outputStat,
      outputPath,
    };
    assertPrivateSnapshotRecord(record);
    assertSafeMachOSnapshotClosure(repo, outputPath, prefix);
    assertPrivateSnapshotRecord(record);
    trustedExecutableSnapshots.set(sourcePath, record);
    trustedExecutableSnapshotsByPath.set(outputPath, record);
    revalidateTrustedExecutableSnapshot(outputPath);
    return outputPath;
  } catch (error) {
    trustedExecutableSnapshotDirs.delete(directory);
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

function trustedExecutableCandidate(
  candidate,
  root,
  executableName,
  { allowSnapshot = true } = {},
) {
  const resolved = realpathSync(candidate);
  if (/[\r\n\0]/.test(resolved)) {
    throw new Error("executable path contains a control character");
  }
  if (isWithin(path.resolve(candidate), root) || isWithin(resolved, root)) {
    throw new Error("executable is inside the reviewed repository");
  }
  const pinnedSnapshot = trustedExecutableSnapshots.get(resolved);
  if (pinnedSnapshot) {
    if (!allowSnapshot) {
      throw new Error("snapshotted executable is not allowed for this command");
    }
    revalidateTrustedExecutableSnapshot(pinnedSnapshot.outputPath);
    return pinnedSnapshot.outputPath;
  }

  const descriptor = openSync(resolved, secureReadFlags());
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      !trustedOwner(before) ||
      sharedWritable(before) ||
      (before.mode & 0o6000n) !== 0n ||
      hasWriteGrantingAcl(resolved, before) ||
      !executableForCurrentUser(before)
    ) {
      throw new Error("executable file is not trusted");
    }
    const pathBefore = lstatSync(resolved, { bigint: true });
    if (!sameFileMetadata(before, pathBefore)) {
      throw new Error("executable identity changed before validation");
    }
    const ancestryBefore = inspectTrustedDirectoryAncestry(
      path.dirname(resolved),
    );
    const directExecutionSafe =
      (before.nlink === 1n || before.uid === 0n) &&
      ancestryBefore.every(
        ({ fileStat, writeGrantingAcl }) =>
          !sharedWritable(fileStat) && !writeGrantingAcl,
      );

    if (directExecutionSafe) {
      const after = fstatSync(descriptor, { bigint: true });
      const pathAfter = lstatSync(resolved, { bigint: true });
      if (
        !sameFileMetadata(before, after) ||
        !sameFileMetadata(before, pathAfter)
      ) {
        throw new Error(
          "executable identity or metadata changed during validation",
        );
      }
      const ancestryAfter = inspectTrustedDirectoryAncestry(
        path.dirname(resolved),
      );
      assertStableDirectoryAncestry(ancestryBefore, ancestryAfter);
      return resolved;
    }
    if (!allowSnapshot) {
      throw new Error("executable ancestry is unsafe for direct execution");
    }
    if (process.platform !== "darwin") {
      throw new Error(
        "unsafe executable ancestry cannot be snapshotted on this platform",
      );
    }
    if (before.nlink !== 1n) {
      throw new Error("executable snapshots require a single-link source");
    }
    const prefix = Buffer.alloc(4);
    if (readSync(descriptor, prefix, 0, prefix.length, 0) !== prefix.length) {
      throw new Error("executable is too short to be a native Mach-O binary");
    }
    assertNativeMachOPrefix(prefix);
    return publishTrustedExecutableSnapshot(
      root,
      resolved,
      executableName,
      descriptor,
      before,
      ancestryBefore,
    );
  } finally {
    closeSync(descriptor);
  }
}

function resolveTrustedCommand(command, rejectRoot, { required = true } = {}) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (process.env.PATH || "")
        .split(path.delimiter)
        .filter((entry) => entry && path.isAbsolute(entry))
        .map((entry) => path.join(entry, command));
  const root = realpathSync(rejectRoot);
  for (const candidate of candidates) {
    if (rejectedTrustedExecutableCandidates.has(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return trustedExecutableCandidate(
        candidate,
        root,
        path.basename(command) || "executable",
        { allowSnapshot: path.basename(command) !== "git" },
      );
    } catch {
      rejectedTrustedExecutableCandidates.add(candidate);
      // Keep searching a bounded, absolute PATH for an external executable.
    }
  }
  if (required) {
    throw new Error(
      `${command} CLI is not available outside the reviewed repo`,
    );
  }
  return null;
}

function trustedCurrentNode(rejectRoot) {
  const root = realpathSync(rejectRoot);
  try {
    accessSync(process.execPath, fsConstants.X_OK);
    return trustedExecutableCandidate(process.execPath, root, "node");
  } catch {
    throw new Error("node runtime is not available outside the reviewed repo");
  }
}

function trustedToolPath(directory, commands) {
  const binDir = path.join(directory, "trusted-bin");
  mkdirSync(binDir);
  for (const [name, executable] of Object.entries(commands)) {
    revalidateTrustedExecutableSnapshot(executable);
    symlinkSync(executable, path.join(binDir, name));
  }
  return [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
    path.delimiter,
  );
}

function assertLinuxDynamicPreloadAbsent() {
  try {
    lstatSync("/etc/ld.so.preload", { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "attested Node runtime requires /etc/ld.so.preload to be absent",
  );
}

function attestedRuntimeAncestryIsTrusted(ancestry) {
  return ancestry.every(
    ({ fileStat, writeGrantingAcl }) =>
      !writeGrantingAcl &&
      (!sharedWritable(fileStat) ||
        (fileStat.uid === 0n && (fileStat.mode & 0o1000n) !== 0n)),
  );
}

function readStableAttestedFile(
  candidate,
  label,
  maximumBytes,
  { includeContent = false } = {},
) {
  const pathBefore = lstatSync(candidate, { bigint: true });
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.size <= 0n ||
    pathBefore.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  let descriptor;
  try {
    descriptor = openSync(candidate, secureReadFlags());
    const before = fstatSync(descriptor, { bigint: true });
    if (!sameFileMetadata(pathBefore, before)) {
      throw new Error(`${label} changed before validation`);
    }
    const digest = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maximumBytes || BigInt(total) > before.size) {
        throw new Error(`${label} grew during validation`);
      }
      const chunk = buffer.subarray(0, read);
      digest.update(chunk);
      if (includeContent) chunks.push(Buffer.from(chunk));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(candidate, { bigint: true });
    if (
      BigInt(total) !== before.size ||
      !sameFileMetadata(before, after) ||
      !sameFileMetadata(before, pathAfter)
    ) {
      throw new Error(`${label} changed during validation`);
    }
    return {
      content: includeContent ? Buffer.concat(chunks, total) : null,
      digest: digest.digest("hex"),
      fileStat: before,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function linuxLoaderPathFingerprint(candidate, repo) {
  if (
    effectiveUid() !== 0n ||
    !/^\/(?:[A-Za-z0-9_+.,:@%=-]+\/)*[A-Za-z0-9_+.,:@%=-]+$/.test(candidate)
  ) {
    throw new Error("attested Node loader path is invalid");
  }
  const digest = createHash("sha256");
  const statFields = (fileStat) => [
    fileStat.dev,
    fileStat.ino,
    fileStat.mode,
    fileStat.nlink,
    fileStat.uid,
    fileStat.gid,
    fileStat.rdev,
    fileStat.size,
    fileStat.mtimeNs / 1_000_000_000n,
    fileStat.ctimeNs / 1_000_000_000n,
  ];
  const record = (kind, candidatePath, target, fileStat) => {
    if (isWithin(candidatePath, repo) || fileStat.uid !== 0n) {
      throw new Error("attested Node loader path is unsafe");
    }
    if (kind === "directory") {
      if (!fileStat.isDirectory() || sharedWritable(fileStat)) {
        throw new Error("attested Node loader directory is unsafe");
      }
    } else if (kind === "symlink") {
      if (!fileStat.isSymbolicLink()) {
        throw new Error("attested Node loader symlink is unsafe");
      }
    } else if (kind === "file") {
      if (
        !fileStat.isFile() ||
        (fileStat.mode & 0o6022n) !== 0n ||
        (fileStat.mode & 0o111n) === 0n ||
        fileStat.nlink < 1n
      ) {
        throw new Error("attested Node loader file is unsafe");
      }
    } else {
      throw new Error("attested Node loader path record is invalid");
    }
    digest.update(
      [kind, candidatePath, target, ...statFields(fileStat)].join("\0") + "\0",
    );
  };
  const normalizeAbsolute = (value) => {
    if (!value.startsWith("/") || /[\r\n\0]/.test(value)) return null;
    const parts = [];
    for (const part of value.split(/\/+/)) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  };

  record("directory", "/", "", lstatSync("/", { bigint: true }));
  let pending = candidate.split("/").filter(Boolean);
  let current = "/";
  let symlinks = 0;
  let loaderDigest = "";
  let loaderStat;
  while (pending.length > 0) {
    const component = pending.shift();
    if (component === "." || component === "..") {
      throw new Error("attested Node loader path component is unsafe");
    }
    const next = current === "/" ? `/${component}` : `${current}/${component}`;
    const fileStat = lstatSync(next, { bigint: true });
    if (fileStat.isSymbolicLink()) {
      if (++symlinks > 40) {
        throw new Error("attested Node loader has excessive symlinks");
      }
      const target = readlinkSync(next, "utf8");
      if (!target || /[\r\n\0]/.test(target)) {
        throw new Error("attested Node loader symlink target is unsafe");
      }
      record("symlink", next, target, fileStat);
      const targetPath = target.startsWith("/")
        ? target
        : current === "/"
          ? `/${target}`
          : `${current}/${target}`;
      const combined = normalizeAbsolute(
        pending.length > 0 ? `${targetPath}/${pending.join("/")}` : targetPath,
      );
      if (!combined) {
        throw new Error("attested Node loader symlink path is invalid");
      }
      pending = combined.split("/").filter(Boolean);
      current = "/";
      continue;
    }
    if (pending.length > 0) {
      record("directory", next, "", fileStat);
    } else {
      const loader = readStableAttestedFile(
        next,
        "attested Node loader",
        64 * 1024 * 1024,
      );
      if (!sameFileMetadata(fileStat, loader.fileStat)) {
        throw new Error("attested Node loader changed during validation");
      }
      loaderDigest = loader.digest;
      loaderStat = loader.fileStat;
      record("file", next, loaderDigest, fileStat);
    }
    current = next;
  }
  const resolved = realpathSync(candidate);
  if (resolved !== current || isWithin(resolved, repo) || !loaderStat) {
    throw new Error("attested Node loader resolution is unsafe");
  }
  return {
    fingerprint: digest.digest("hex"),
    loaderDigest,
    loaderStat,
    resolved,
  };
}

function inspectAttestedNodeManifest(executable, directory, repo) {
  const parent = path.dirname(executable);
  const prefix = `${path.basename(executable)}.loader-closure.`;
  const names = readdirSync(parent, { encoding: "utf8" }).filter((name) =>
    name.startsWith(prefix),
  );
  if (names.length !== 1) {
    throw new Error("attested Node closure manifest is missing or excessive");
  }
  const expectedDigest = names[0].slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error("attested Node closure manifest name is invalid");
  }
  const manifestPath = path.join(parent, names[0]);
  if (isWithin(manifestPath, repo)) {
    throw new Error(
      "attested Node closure manifest is inside the review target",
    );
  }
  const manifest = readStableAttestedFile(
    manifestPath,
    "attested Node closure manifest",
    1024 * 1024,
    { includeContent: true },
  );
  if (
    manifest.fileStat.uid !== 0n ||
    manifest.fileStat.nlink !== 1n ||
    (manifest.fileStat.mode & 0o7777n) !== 0o400n ||
    manifest.digest !== expectedDigest
  ) {
    throw new Error("attested Node closure manifest is unsafe");
  }
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(
      manifest.content,
    );
  } catch {
    throw new Error("attested Node closure manifest is not UTF-8");
  }
  if (
    !content.endsWith("\n") ||
    content.includes("\r") ||
    content.includes("\0")
  ) {
    throw new Error("attested Node closure manifest format is invalid");
  }
  const lines = content.slice(0, -1).split("\n");
  if (
    lines.length < 4 ||
    lines.length > 3074 ||
    lines[0] !== "loader-closure-v3"
  ) {
    throw new Error("attested Node closure manifest header is invalid");
  }
  let policyCount = 0;
  let loaderCount = 0;
  let loaderFingerprint = "";
  let loaderRequested = "";
  let loaderResolved = "";
  const passiveKinds = new Set(["needed", "alias", "file"]);
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    if (fields.length !== 6) {
      throw new Error("attested Node closure manifest record is malformed");
    }
    const [kind, executableFlag, requested, resolved, fingerprint, extra] =
      fields;
    if (kind === "policy") {
      if (
        policyCount++ !== 0 ||
        executableFlag !== "0" ||
        requested !== directory ||
        resolved !== "-" ||
        !/^[0-9a-f]{64}$/.test(fingerprint) ||
        !/^[0-9a-f]{64}$/.test(extra)
      ) {
        throw new Error("attested Node closure policy is invalid");
      }
    } else if (kind === "loader") {
      if (
        loaderCount++ !== 0 ||
        executableFlag !== "1" ||
        !path.isAbsolute(requested) ||
        !path.isAbsolute(resolved) ||
        /[\r\n\0]/.test(requested) ||
        /[\r\n\0]/.test(resolved) ||
        path.normalize(requested) !== requested ||
        path.normalize(resolved) !== resolved ||
        !/^[0-9a-f]{64}$/.test(fingerprint) ||
        extra !== "-"
      ) {
        throw new Error("attested Node closure loader record is invalid");
      }
      loaderRequested = requested;
      loaderResolved = resolved;
      loaderFingerprint = fingerprint;
    } else if (!passiveKinds.has(kind)) {
      throw new Error("attested Node closure manifest kind is invalid");
    }
  }
  if (policyCount !== 1 || loaderCount !== 1) {
    throw new Error("attested Node closure manifest is incomplete");
  }
  if (
    realpathSync(loaderRequested) !== loaderResolved ||
    realpathSync(loaderResolved) !== loaderResolved ||
    isWithin(loaderResolved, repo)
  ) {
    throw new Error("attested Node loader path is unsafe");
  }
  const loader = linuxLoaderPathFingerprint(loaderRequested, repo);
  if (
    loader.resolved !== loaderResolved ||
    loader.fingerprint !== loaderFingerprint ||
    hasWriteGrantingAcl(
      loaderResolved,
      loader.loaderStat,
      "attested Node loader",
    )
  ) {
    throw new Error("attested Node loader is unsafe");
  }
  const loaderAncestry = inspectTrustedDirectoryAncestry(
    path.dirname(loaderResolved),
    "attested Node loader",
  );
  if (
    loaderAncestry.some(
      ({ fileStat, writeGrantingAcl }) =>
        sharedWritable(fileStat) || writeGrantingAcl,
    )
  ) {
    throw new Error("attested Node loader ancestry is writable");
  }
  return {
    loaderAncestry,
    loaderDigest: loader.loaderDigest,
    loaderRequested,
    loaderResolved,
    loaderStat: loader.loaderStat,
    manifestDigest: manifest.digest,
    manifestPath,
    manifestStat: manifest.fileStat,
  };
}

function sameAttestedNodeManifest(left, right) {
  try {
    assertStableDirectoryAncestry(
      left.loaderAncestry,
      right.loaderAncestry,
      "attested Node loader",
    );
  } catch {
    return false;
  }
  return (
    left.loaderDigest === right.loaderDigest &&
    left.loaderRequested === right.loaderRequested &&
    left.loaderResolved === right.loaderResolved &&
    sameFileMetadata(left.loaderStat, right.loaderStat) &&
    left.manifestDigest === right.manifestDigest &&
    left.manifestPath === right.manifestPath &&
    sameFileMetadata(left.manifestStat, right.manifestStat)
  );
}

function inspectAttestedNodeAliases(directory, repo) {
  const names = readdirSync(directory, { encoding: "utf8" }).sort();
  if (names.length === 0 || names.length > 1024) {
    throw new Error("attested Node library aliases are missing or excessive");
  }
  return names.map((name) => {
    if (!/^[A-Za-z0-9_+.-]+$/.test(name) || name === "." || name === "..") {
      throw new Error("attested Node library alias name is unsafe");
    }
    const aliasPath = path.join(directory, name);
    const aliasStat = lstatSync(aliasPath, { bigint: true });
    const target = readlinkSync(aliasPath, "utf8");
    if (
      !aliasStat.isSymbolicLink() ||
      aliasStat.uid !== 0n ||
      !path.isAbsolute(target) ||
      /[\r\n\0]/.test(target) ||
      realpathSync(aliasPath) !== target ||
      isWithin(target, repo)
    ) {
      throw new Error("attested Node library alias is unsafe");
    }
    const targetStat = lstatSync(target, { bigint: true });
    if (
      !targetStat.isFile() ||
      targetStat.uid !== 0n ||
      sharedWritable(targetStat) ||
      (targetStat.mode & 0o6000n) !== 0n ||
      targetStat.nlink < 1n ||
      hasWriteGrantingAcl(target, targetStat, "attested Node library")
    ) {
      throw new Error("attested Node library target is unsafe");
    }
    const targetAncestry = inspectTrustedDirectoryAncestry(
      path.dirname(target),
      "attested Node library target",
    );
    if (
      targetAncestry.some(
        ({ fileStat, writeGrantingAcl }) =>
          sharedWritable(fileStat) || writeGrantingAcl,
      )
    ) {
      throw new Error("attested Node library target ancestry is writable");
    }
    return { aliasPath, aliasStat, name, target, targetAncestry, targetStat };
  });
}

function assertAttestedNodeRuntimeRecord(record) {
  assertLinuxDynamicPreloadAbsent();
  assertPrivateSnapshotDirectory(record.directory);
  const directoryStat = lstatSync(record.directory, { bigint: true });
  if (!sameDirectorySecurityMetadata(record.directoryStat, directoryStat)) {
    throw new Error("attested Node library directory changed");
  }
  const ancestry = inspectTrustedDirectoryAncestry(
    path.dirname(record.directory),
    "attested Node runtime",
  );
  if (!attestedRuntimeAncestryIsTrusted(ancestry)) {
    throw new Error("attested Node runtime ancestry is unsafe");
  }
  assertStableDirectoryAncestry(
    record.ancestry,
    ancestry,
    "attested Node runtime",
  );
  const executableStat = lstatSync(record.executable, { bigint: true });
  if (
    !sameFileMetadata(record.executableStat, executableStat) ||
    realpathSync(process.execPath) !== record.executable ||
    realpathSync(`/proc/${process.pid}/exe`) !== record.executable
  ) {
    throw new Error("attested Node executable changed");
  }
  let manifest;
  try {
    manifest = inspectAttestedNodeManifest(
      record.executable,
      record.directory,
      record.repo,
    );
  } catch {
    throw new Error("attested Node loader or manifest changed");
  }
  if (!sameAttestedNodeManifest(record.manifest, manifest)) {
    throw new Error("attested Node loader or manifest changed");
  }
  const aliases = inspectAttestedNodeAliases(record.directory, record.repo);
  if (
    aliases.length !== record.aliases.length ||
    aliases.some((alias, index) => {
      const expected = record.aliases[index];
      try {
        assertStableDirectoryAncestry(
          expected.targetAncestry,
          alias.targetAncestry,
          "attested Node library target",
        );
      } catch {
        return true;
      }
      return (
        alias.name !== expected.name ||
        alias.target !== expected.target ||
        !sameFileMetadata(alias.aliasStat, expected.aliasStat) ||
        !sameFileMetadata(alias.targetStat, expected.targetStat)
      );
    })
  ) {
    throw new Error("attested Node library aliases changed");
  }
}

function attestedNodeRuntime(repo) {
  const requested = process.env.AUTOREVIEW_ATTESTED_NODE_LIBRARY_PATH;
  if (!requested) return null;
  if (
    process.platform !== "linux" ||
    effectiveUid() !== 0n ||
    !path.isAbsolute(requested) ||
    /[\r\n\0]/.test(requested)
  ) {
    throw new Error("attested Node library path is invalid");
  }
  const directory = realpathSync(requested);
  const executable = realpathSync(process.execPath);
  const canonicalRepo = realpathSync(repo);
  if (
    directory !== requested ||
    path.dirname(directory) !== path.dirname(executable) ||
    isWithin(directory, canonicalRepo)
  ) {
    throw new Error("attested Node library path is outside its runtime");
  }
  if (
    process.env.LD_LIBRARY_PATH !== directory ||
    process.env.GLIBC_TUNABLES ||
    process.env.OPENSSL_CONF ||
    process.env.OPENSSL_MODULES ||
    Object.keys(process.env).some(
      (key) => key.startsWith("LD_") && key !== "LD_LIBRARY_PATH",
    )
  ) {
    throw new Error("attested Node runtime inherited unsafe loader state");
  }
  let record = attestedNodeLibraryPathRecords.get(directory);
  if (!record) {
    assertPrivateSnapshotDirectory(directory);
    const executableStat = lstatSync(executable, { bigint: true });
    if (
      !executableStat.isFile() ||
      executableStat.uid !== 0n ||
      (executableStat.mode & 0o7777n) !== 0o500n ||
      executableStat.nlink !== 1n ||
      hasWriteGrantingAcl(
        executable,
        executableStat,
        "attested Node runtime",
      ) ||
      realpathSync(`/proc/${process.pid}/exe`) !== executable
    ) {
      throw new Error("attested Node executable is unsafe");
    }
    const ancestry = inspectTrustedDirectoryAncestry(
      path.dirname(directory),
      "attested Node runtime",
    );
    if (!attestedRuntimeAncestryIsTrusted(ancestry)) {
      throw new Error("attested Node runtime ancestry is unsafe");
    }
    let manifest;
    try {
      manifest = inspectAttestedNodeManifest(
        executable,
        directory,
        canonicalRepo,
      );
    } catch {
      throw new Error("attested Node loader or manifest is unsafe");
    }
    record = {
      aliases: inspectAttestedNodeAliases(directory, canonicalRepo),
      ancestry,
      directory,
      directoryStat: lstatSync(directory, { bigint: true }),
      executable,
      executableStat,
      manifest,
      repo: canonicalRepo,
    };
    attestedNodeLibraryPathRecords.set(directory, record);
  }
  assertAttestedNodeRuntimeRecord(record);
  return record;
}

function assertAllAttestedNodeLibraryPaths() {
  for (const record of attestedNodeLibraryPathRecords.values()) {
    assertAttestedNodeRuntimeRecord(record);
  }
}

function gitEnvironment() {
  return {
    HOME: process.env.HOME || tmpdir(),
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR || tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EXTERNAL_DIFF: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
  };
}

function decodeGitOutput(data, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${label} returned non-UTF-8 output`);
  }
}

function runGitBufferResult(
  repo,
  gitArgs,
  { maxBuffer = MAX_GIT_OUTPUT_BYTES } = {},
) {
  const rejectRoot = realpathSync(repo);
  const git = resolveTrustedCommand("git", rejectRoot);
  const result = spawnTrustedSync(
    git,
    ["-c", "core.fsmonitor=false", "-c", "diff.renames=false", ...gitArgs],
    {
      cwd: repo,
      env: gitEnvironment(),
      encoding: "buffer",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    const error = new Error(
      `git ${gitArgs[0] || "command"} failed: ${result.error.message}`,
    );
    error.code = result.error.code;
    throw error;
  }
  return {
    status: result.status,
    stdout: result.stdout || Buffer.alloc(0),
    stderr: result.stderr || Buffer.alloc(0),
  };
}

function runGitResult(
  repo,
  gitArgs,
  { maxBuffer = MAX_GIT_OUTPUT_BYTES } = {},
) {
  const result = runGitBufferResult(repo, gitArgs, { maxBuffer });
  return {
    status: result.status,
    stdout: decodeGitOutput(result.stdout, "git"),
    stderr: decodeGitOutput(result.stderr, "git stderr"),
  };
}

function runGit(
  repo,
  gitArgs,
  { check = true, maxBuffer = MAX_GIT_OUTPUT_BYTES } = {},
) {
  const result = runGitResult(repo, gitArgs, { maxBuffer });
  if (check && result.status !== 0) {
    throw new Error(
      `git ${gitArgs.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function gitPathList(repo, gitArgs) {
  const paths = runGit(repo, gitArgs).split("\0").filter(Boolean);
  for (const relativePath of paths) {
    if (/\t|\r|\n/.test(relativePath)) {
      throw new Error(
        "changed paths containing tabs or line breaks are unsupported; rename the path before autoreview",
      );
    }
  }
  return paths;
}

function repoRoot() {
  const cwd = realpathSync(process.cwd());
  const rejectRoot = checkoutRootFrom(cwd);
  const git = resolveTrustedCommand("git", rejectRoot);
  const result = spawnTrustedSync(
    git,
    ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
    {
      cwd,
      env: gitEnvironment(),
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("autoreview must run inside a git repository");
  }
  const repo = realpathSync(decodeGitOutput(result.stdout, "git").trim());
  resolveTrustedCommand("git", repo);
  return repo;
}

function githubRepositorySlug(repo) {
  const origin = runGit(repo, ["remote", "get-url", "origin"]).trim();
  const normalized = origin.replace(/\.git$/i, "");
  const match = normalized.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (!match) {
    throw new Error(
      "automatic PR lookup requires a canonical github.com origin remote",
    );
  }
  return `${match[1]}/${match[2]}`;
}

// Bound each automatic PR-base gh lookup so a hung GitHub CLI cannot stall
// autoreview indefinitely; a timeout fails closed like any other lookup error.
// Overridable (seconds) so tests can exercise the timeout path quickly.
const GH_LOOKUP_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(
    process.env.AGENT_AUTOREVIEW_GH_DEADLINE_SECONDS || "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured * 1000
    : 60_000;
})();

// spawnSync's built-in timeout only signals the direct child; it does not
// reach descendants the child has already forked (a gh helper call that
// backgrounds a subprocess, say). The lookups below spawn with
// detached: true so the child leads its own process group, letting this sweep
// the whole group after a timeout instead of leaving an orphan running.
function killProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited, or not a process group leader on this platform --
    // nothing left to clean up.
  }
}

function detectPrBase(repo, branch) {
  if (!branch) return null;
  const gh = resolveTrustedCommand("gh", repo, { required: false });
  if (!gh) return null;
  const git = resolveTrustedCommand("git", repo);
  const repositorySlug = githubRepositorySlug(repo);
  const runtimeDir = mkdtempSync(
    path.join(safeTempRoot(repo), "autoreview-gh."),
  );
  const env = {
    HOME: process.env.HOME || tmpdir(),
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    PATH: trustedToolPath(runtimeDir, { gh, git }),
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
  };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  try {
    const repoResult = spawnTrustedSync(
      gh,
      ["repo", "view", repositorySlug, "--json", "owner"],
      {
        cwd: repo,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GH_LOOKUP_TIMEOUT_MS,
        // SIGKILL, not SIGTERM: spawnSync blocks until the child actually
        // exits after the timeout fires, so a child that handles or ignores
        // SIGTERM would hang this call (and autoreview) indefinitely despite
        // the "timeout" option. SIGKILL can't be caught or ignored.
        killSignal: "SIGKILL",
        detached: true,
      },
    );
    if (
      repoResult.error?.code === "ETIMEDOUT" ||
      repoResult.signal === "SIGKILL"
    ) {
      killProcessGroup(repoResult.pid);
      throw new Error(
        `failed to inspect repository owner: gh repo view timed out after ${GH_LOOKUP_TIMEOUT_MS / 1000}s; pass --base explicitly`,
      );
    }
    if (repoResult.error) {
      throw new Error(
        `failed to inspect repository owner: ${repoResult.error.message}`,
      );
    }
    if (repoResult.status !== 0) {
      throw new Error(
        `failed to inspect repository owner: ${(repoResult.stderr || repoResult.stdout).trim() || `gh exited ${repoResult.status}`}`,
      );
    }
    let repository;
    try {
      repository = JSON.parse(repoResult.stdout);
    } catch {
      throw new Error(
        "failed to inspect repository owner: gh returned invalid JSON",
      );
    }
    const repositoryOwner = repository?.owner?.login;
    if (typeof repositoryOwner !== "string" || !repositoryOwner) {
      throw new Error(
        "failed to inspect repository owner: gh omitted owner.login",
      );
    }
    const result = spawnTrustedSync(
      gh,
      [
        "pr",
        "list",
        "--repo",
        repositorySlug,
        "--head",
        branch,
        "--state",
        "open",
        "--limit",
        "2",
        "--json",
        "baseRefName,headRepositoryOwner",
      ],
      {
        cwd: repo,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GH_LOOKUP_TIMEOUT_MS,
        killSignal: "SIGKILL",
        detached: true,
      },
    );
    if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") {
      killProcessGroup(result.pid);
      throw new Error(
        `failed to inspect PR base: gh pr list timed out after ${GH_LOOKUP_TIMEOUT_MS / 1000}s; pass --base explicitly`,
      );
    }
    if (result.error) {
      throw new Error(`failed to inspect PR base: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `failed to inspect PR base: ${(result.stderr || result.stdout).trim() || `gh exited ${result.status}`}`,
      );
    }
    let prs;
    try {
      prs = JSON.parse(result.stdout);
    } catch {
      throw new Error("failed to inspect PR base: gh returned invalid JSON");
    }
    if (!Array.isArray(prs)) {
      throw new Error(
        "failed to inspect PR base: gh returned a non-array result",
      );
    }
    if (prs.length > 1) {
      throw new Error(
        `multiple open PRs match head branch ${branch}; pass --base explicitly`,
      );
    }
    if (prs.length === 0) return null;
    const base = prs[0]?.baseRefName;
    if (typeof base !== "string" || !base) {
      throw new Error("failed to inspect PR base: gh omitted baseRefName");
    }
    const headRepositoryOwner = prs[0]?.headRepositoryOwner?.login;
    if (
      typeof headRepositoryOwner !== "string" ||
      !headRepositoryOwner ||
      headRepositoryOwner !== repositoryOwner
    ) {
      throw new Error(
        `open PR for head branch ${branch} is not owned by ${repositoryOwner}; pass --base explicitly`,
      );
    }
    return `origin/${base}`;
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function chooseTarget(repo, args, selectionState) {
  const { branch, dirty } = selectionState;
  if (args.frozenTargetMode) {
    if (selectionState.headOid !== args.frozenHeadOid) {
      throw new Error(
        "frozen review head no longer matches the checkout; rerun autoreview",
      );
    }
    if (args.frozenTargetMode === "local") {
      return { mode: "local", ref: null };
    }
    if (args.frozenTargetMode === "commit") {
      return { mode: "commit", ref: args.commit };
    }
    if (!args.base) {
      throw new Error("frozen branch targets require --base");
    }
    return { mode: args.frozenTargetMode, ref: args.base };
  }
  const branchTarget = branch && branch !== "main";
  if (
    args.mode === "local" ||
    (args.mode === "auto" && dirty && !branchTarget)
  ) {
    return { mode: "local", ref: null };
  }
  if (args.mode === "commit") {
    return { mode: "commit", ref: args.commit };
  }
  if (
    args.mode === "branch" ||
    (args.mode === "auto" && branch && branch !== "main")
  ) {
    const ref = args.base || detectPrBase(repo, branch) || "origin/main";
    if (args.mode === "auto" && dirty) {
      return { mode: "branch-local", ref };
    }
    return {
      mode: "branch",
      ref,
    };
  }
  throw new Error("no review target: clean main checkout and no forced mode");
}

function freezeTargetRef(repo, target, selectionState) {
  const frozenTarget = {
    ...target,
    branch: selectionState.branch,
    head: selectionState.headOid,
  };
  if (!target.ref) return frozenTarget;
  const requestedRef = target.ref;
  if (
    requestedRef.startsWith("-") ||
    /[\0-\x20\x7f]/.test(requestedRef) ||
    requestedRef.includes("...")
  ) {
    throw new Error(`invalid review ref: ${requestedRef}`);
  }
  let ref;
  if (requestedRef === "HEAD") {
    ref = selectionState.headOid;
  } else {
    const result = runGitResult(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${requestedRef}^{commit}`,
    ]);
    if (result.status !== 0) {
      throw new Error(
        `review ref does not resolve to a commit: ${requestedRef}`,
      );
    }
    ref = result.stdout.trim();
  }
  if (!/^[0-9a-f]{40,64}$/i.test(ref)) {
    throw new Error(
      `review ref did not resolve to an object ID: ${requestedRef}`,
    );
  }
  return { ...frozenTarget, ref, requested_ref: requestedRef };
}

function readText(filePath) {
  try {
    const data = readFileSync(filePath);
    if (data.includes(0)) return "[binary file omitted]";
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (error) {
    return `[unreadable: ${error.message}]`;
  }
}

function aggregateInputLimitError(label) {
  const error = new Error(
    `review input exceeds the ${MAX_REVIEW_INPUT_BYTES}-byte aggregate limit while adding ${label}`,
  );
  error.code = "AUTOREVIEW_INPUT_TOO_LARGE";
  return error;
}

function gitBundlePart(collector, label, repo, gitArgs) {
  const maxBuffer = Math.max(
    1024,
    Math.min(MAX_GIT_OUTPUT_BYTES, collector.remainingBytes() + 1),
  );
  let output;
  try {
    output = runGit(repo, gitArgs, { maxBuffer });
  } catch (error) {
    if (error.code === "ENOBUFS") {
      throw aggregateInputLimitError(label);
    }
    throw error;
  }
  collector.add(label, output);
}

function appendLocalBundle(repo, target, collector) {
  collector.add("git status heading", "# Git Status");
  gitBundlePart(collector, "git status", repo, ["status", "--short"]);
  collector.add("staged diff heading", "# Staged Diff");
  gitBundlePart(collector, "staged diff stat", repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--cached",
    target.head,
    "--stat",
    "--",
  ]);
  gitBundlePart(collector, "staged diff", repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--cached",
    target.head,
    "--patch",
    "--no-renames",
    "--",
  ]);
  collector.add("unstaged diff heading", "# Unstaged Diff");
  gitBundlePart(collector, "unstaged diff stat", repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
  ]);
  gitBundlePart(collector, "unstaged diff", repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--patch",
    "--no-renames",
  ]);
  const untracked = gitPathList(repo, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untracked.length > 0) {
    collector.add("untracked files heading", "# Untracked Files");
    for (const rel of untracked) {
      const remainingBytes = collector.remainingBytes();
      let serialized;
      try {
        serialized = serializeSafeUntrackedFile(repo, rel, remainingBytes);
      } catch (error) {
        if (
          error.code === "AUTOREVIEW_INPUT_TOO_LARGE" &&
          remainingBytes < MAX_REVIEW_INPUT_BYTES
        ) {
          throw aggregateInputLimitError(`untracked file ${rel}`);
        }
        throw error;
      }
      collector.add(`untracked file ${rel}`, serialized);
    }
  }
}

function localBundle(repo, target) {
  const collector = createReviewInputCollector();
  appendLocalBundle(repo, target, collector);
  return collector.toString();
}

function appendBranchBundle(repo, target, collector) {
  collector.add("branch diff heading", "# Branch Diff");
  collector.add("branch base", `base: ${target.ref}`);
  collector.add("branch head", `head: ${target.head}`);
  gitBundlePart(collector, "branch diff stat", repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
    `${target.ref}...${target.head}`,
    "--",
  ]);
  gitBundlePart(collector, "branch diff", repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--patch",
    "--no-renames",
    `${target.ref}...${target.head}`,
    "--",
  ]);
}

function branchBundle(repo, target) {
  const collector = createReviewInputCollector();
  appendBranchBundle(repo, target, collector);
  return collector.toString();
}

function branchLocalBundle(repo, target) {
  const collector = createReviewInputCollector();
  appendBranchBundle(repo, target, collector);
  collector.add("local diff heading", "# Local Diff");
  appendLocalBundle(repo, target, collector);
  return collector.toString();
}

function commitBundle(repo, commitRef) {
  const collector = createReviewInputCollector();
  collector.add("commit diff heading", "# Commit Diff");
  collector.add("commit ref", `commit: ${commitRef}`);
  gitBundlePart(collector, "commit diff stat", repo, [
    "show",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
    "--format=fuller",
    "--end-of-options",
    commitRef,
    "--",
  ]);
  gitBundlePart(collector, "commit diff", repo, [
    "show",
    "--no-ext-diff",
    "--no-textconv",
    "--patch",
    "--no-renames",
    "--format=fuller",
    "--end-of-options",
    commitRef,
    "--",
  ]);
  return collector.toString();
}

function changedPaths(repo, target) {
  const sources =
    target.mode === "local"
      ? [
          gitPathList(repo, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "--cached",
            "-z",
            target.head,
            "--",
          ]),
          gitPathList(repo, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
          ]),
          gitPathList(repo, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          ]),
        ]
      : target.mode === "branch"
        ? [
            gitPathList(repo, [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--name-only",
              "-z",
              `${target.ref}...${target.head}`,
              "--",
            ]),
          ]
        : target.mode === "branch-local"
          ? [
              gitPathList(repo, [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--name-only",
                "-z",
                `${target.ref}...${target.head}`,
                "--",
              ]),
              gitPathList(repo, [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--name-only",
                "--cached",
                "-z",
                target.head,
                "--",
              ]),
              gitPathList(repo, [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--name-only",
                "-z",
              ]),
              gitPathList(repo, [
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
              ]),
            ]
          : [
              gitPathList(repo, [
                "show",
                "--no-ext-diff",
                "--no-textconv",
                "--name-only",
                "--format=",
                "-z",
                "--end-of-options",
                target.ref,
                "--",
              ]),
            ];

  return new Set(sources.flat());
}

function loadExtras(repo, args, maxBytes) {
  const collector = createReviewInputCollector(
    maxBytes,
    "supplemental review input",
  );
  for (const prompt of args.prompts) {
    assertNoSecretLikeContent("--prompt", prompt);
    collector.add("--prompt", prompt);
  }
  for (const file of args.promptFiles) {
    const evidence = readSafeEvidenceFile({
      repo,
      rawPath: file,
      label: "--prompt-file",
      trustedRoot: args.trustedInputRoot,
      allowTrustedRoot: Boolean(args.trustedInputRoot),
      maxBytes: collector.remainingBytes(),
    });
    collector.add(
      `--prompt-file ${evidence.displayPath}`,
      `# Prompt file: ${evidence.displayPath}\n${evidence.content}`,
    );
  }
  for (const file of args.datasets) {
    const evidence = readSafeEvidenceFile({
      repo,
      rawPath: file,
      label: "--dataset",
      trustedRoot: args.trustedInputRoot,
      allowTrustedRoot: true,
      maxBytes: collector.remainingBytes(),
    });
    collector.add(
      `--dataset ${evidence.displayPath}`,
      `# Dataset: ${evidence.displayPath}\n${evidence.content}`,
    );
  }
  return collector.toString();
}

function renderReviewPrompt(target, branch, baseline, chunk, extras, position) {
  const displayedRef = target.requested_ref || target.ref;
  const targetLine =
    target.mode === "commit" && target.ref
      ? `commit ${displayedRef} (frozen reviewed commit ${target.ref})`
      : (target.mode === "branch" || target.mode === "branch-local") &&
          target.ref
        ? `${target.mode} base ${displayedRef} (frozen base ${target.ref}; frozen reviewed head ${target.head})`
        : target.head
          ? `${target.mode} (frozen reviewed HEAD ${target.head})`
          : target.mode;
  const chunkPolicy = position
    ? `Oversized review bundle pass: ${position.index}/${position.total}
- The complete validated change is distributed across all ${position.total} passes.
- Original change bytes appear exactly once across the pass sequence.
- Continuation context may repeat file and hunk headers; it is not extra change content.
- Do not issue a final verdict until you have inspected every pass listed by the bundle index.
- Accumulate defects and cross-pass contract failures for one final report covering the complete target.${
        chunk.context ? `\n\n# Continuation Context\n${chunk.context}` : ""
      }`
    : "";
  return `You are a skeptical senior code reviewer. Review the provided git change bundle only.

Return exactly one JSON object and nothing else. The JSON object must match this schema exactly:
${JSON.stringify(REVIEW_SCHEMA, null, 2)}

Hard rules:
- Do not modify files.
- Do not invoke nested reviewers or review tools.
- The review sandbox is intentionally empty. The bundle and explicit evidence are the only reviewed-repository source.
- Do not report missing unchanged context merely because it is absent from the bundle.
- Shell commands, if available, must be read-only inspection commands.
- Do not run tests, formatters, package installs, generators, network mutation commands, git mutation commands, or commands that write files.
- Report only actionable defects introduced or exposed by this change.
- Prefer high-signal findings over style feedback.
- Report every distinct actionable defect in the complete reviewed target, then sweep once more for independent failure modes.
- Include security findings only for concrete, actionable risk at a trust boundary.
- This is a closeout gate. Do not turn a narrow patch into a broad redesign request.
- Prefer the smallest correct pre-merge fix. Sibling cleanup, hardening, and architecture work are follow-ups unless this patch cannot safely land without them.
- A clean source review is not runtime proof. Do not claim that UI, CLI, API, integration, or generated-artifact behavior was verified by this review.
- If there are no actionable findings, return an empty findings array and mark the patch correct.

Review target: ${targetLine}
Current branch: ${branch}
Review sandbox: . (intentionally contains no reviewed repository files)
Scope baseline: ${baseline.changedFiles} changed files; ${baseline.nonTestLoc} non-test changed lines.

${chunkPolicy}

${extras}

# Change Bundle
${chunk.content}`;
}

function safeTempRoot(repo) {
  const root = realpathSync(tmpdir());
  if (isWithin(root, realpathSync(repo))) {
    throw new Error(
      "temporary directory must be outside the reviewed repository; relocate TMPDIR",
    );
  }
  const ancestryBefore = inspectTrustedDirectoryAncestry(root);
  for (const {
    path: directory,
    fileStat,
    writeGrantingAcl,
  } of ancestryBefore) {
    if (writeGrantingAcl) {
      throw new Error(
        `write-granting ACL is not allowed on temporary directory ancestry: ${directory}`,
      );
    }
    if (sharedWritable(fileStat) && (fileStat.mode & 0o1000n) === 0n) {
      throw new Error(
        `shared-writable temporary directory ancestry must be sticky: ${directory}`,
      );
    }
  }
  const ancestryAfter = inspectTrustedDirectoryAncestry(root);
  assertStableDirectoryAncestry(ancestryBefore, ancestryAfter);
  return root;
}

function safeProxyUrl(value) {
  try {
    const candidate = value.includes("://") ? value : `http://${value}`;
    const parsed = new URL(candidate);
    return (
      ["http:", "https:", "socks:", "socks4:", "socks5:"].includes(
        parsed.protocol,
      ) &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      ["", "/"].includes(parsed.pathname) &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function externalPath(repo, value) {
  if (!value) return null;
  try {
    const resolved = realpathSync(value);
    return isWithin(resolved, realpathSync(repo)) ? null : resolved;
  } catch {
    return null;
  }
}

function assertTrustedExternalFileAncestry(records, key) {
  for (const { path: directory, fileStat, writeGrantingAcl } of records) {
    if (writeGrantingAcl) {
      throw new Error(`${key} has write-granting ACL ancestry at ${directory}`);
    }
    if (sharedWritable(fileStat) && (fileStat.mode & 0o1000n) === 0n) {
      throw new Error(
        `${key} has non-sticky shared-writable ancestry at ${directory}`,
      );
    }
  }
}

function assertPrivateEngineFileSnapshotDirectory(record) {
  const fileStat = lstatSync(record.directory, { bigint: true });
  if (
    !fileStat.isDirectory() ||
    fileStat.uid !== effectiveUid() ||
    (fileStat.mode & 0o777n) !== 0o700n ||
    hasWriteGrantingAcl(
      record.directory,
      fileStat,
      "trusted engine-file snapshot directory",
    ) ||
    !sameDirectorySecurityMetadata(record.fileStat, fileStat)
  ) {
    throw new Error("trusted engine-file snapshot directory changed");
  }
}

function createEngineFileSnapshotDirectory(runtimeDir) {
  const runtimeStat = lstatSync(runtimeDir, { bigint: true });
  if (
    !runtimeStat.isDirectory() ||
    runtimeStat.uid !== effectiveUid() ||
    (runtimeStat.mode & 0o077n) !== 0n ||
    hasWriteGrantingAcl(runtimeDir, runtimeStat, "reviewer runtime directory")
  ) {
    throw new Error("reviewer runtime directory is not private");
  }
  const directory = path.join(runtimeDir, "external-env-files");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const record = {
    directory,
    fileStat: lstatSync(directory, { bigint: true }),
  };
  assertPrivateEngineFileSnapshotDirectory(record);
  return record;
}

function engineFileSnapshotOutputPath(snapshotRecord, key) {
  const outputName = key.toLowerCase().replaceAll("_", "-");
  return path.join(snapshotRecord.directory, outputName);
}

function validateEngineFileSnapshot(
  snapshotRecord,
  outputPath,
  outputDescriptor,
  expectedSize,
  key,
) {
  fchmodSync(outputDescriptor, 0o600);
  fsyncSync(outputDescriptor);
  const outputStat = fstatSync(outputDescriptor, { bigint: true });
  if (
    !outputStat.isFile() ||
    outputStat.uid !== effectiveUid() ||
    (outputStat.mode & 0o777n) !== 0o600n ||
    (outputStat.mode & 0o6000n) !== 0n ||
    outputStat.nlink !== 1n ||
    outputStat.size !== expectedSize ||
    hasWriteGrantingAcl(outputPath, outputStat, key)
  ) {
    throw new Error(`${key} snapshot failed validation`);
  }
  const outputPathStat = lstatSync(outputPath, { bigint: true });
  if (!sameFileMetadata(outputStat, outputPathStat)) {
    throw new Error(`${key} snapshot identity changed during publish`);
  }
  assertPrivateEngineFileSnapshotDirectory(snapshotRecord);
  return outputStat;
}

function registerEngineFileSnapshotEnv(
  env,
  snapshotRecord,
  key,
  outputPath,
  outputStat,
) {
  assertPrivateEngineFileSnapshotDirectory(snapshotRecord);
  registerEngineCredentialSnapshot(
    path.dirname(snapshotRecord.directory),
    outputPath,
    outputStat,
  );
  env[key] = outputPath;
}

function assertNoAwsCredentialProcess(
  outputDescriptor,
  outputPath,
  outputStat,
  key,
) {
  if (!AWS_CREDENTIAL_CONFIG_KEYS.has(key)) return;
  const contents = Buffer.alloc(Number(outputStat.size));
  let position = 0;
  while (position < contents.length) {
    const bytesRead = readSync(
      outputDescriptor,
      contents,
      position,
      contents.length - position,
      position,
    );
    if (bytesRead === 0) {
      throw new Error(`${key} snapshot changed during credential validation`);
    }
    position += bytesRead;
  }
  const outputAfter = fstatSync(outputDescriptor, { bigint: true });
  const outputPathAfter = lstatSync(outputPath, { bigint: true });
  if (
    !sameFileMetadata(outputStat, outputAfter) ||
    !sameFileMetadata(outputStat, outputPathAfter)
  ) {
    throw new Error(`${key} snapshot changed during credential validation`);
  }
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${key} must contain valid UTF-8 configuration`);
  }
  const containsCredentialProcess = decoded.split(/\r\n?|\n/u).some((line) => {
    const assignment = line.trimStart();
    const separator = assignment.indexOf("=");
    if (separator < 0) return false;
    return (
      assignment.slice(0, separator).trimEnd().toLowerCase() ===
      "credential_process"
    );
  });
  if (containsCredentialProcess) {
    throw new Error(
      `${key} cannot contain credential_process for semantic autoreview`,
    );
  }
}

function createEmptyEngineFileSnapshotEnv(env, snapshotRecord, key) {
  assertPrivateEngineFileSnapshotDirectory(snapshotRecord);
  const outputPath = engineFileSnapshotOutputPath(snapshotRecord, key);
  const outputDescriptor = openSync(outputPath, secureWriteFlags(), 0o600);
  let outputStat;
  try {
    outputStat = validateEngineFileSnapshot(
      snapshotRecord,
      outputPath,
      outputDescriptor,
      0n,
      key,
    );
  } finally {
    closeSync(outputDescriptor);
  }
  registerEngineFileSnapshotEnv(
    env,
    snapshotRecord,
    key,
    outputPath,
    outputStat,
  );
}

function snapshotExternalRegularFileEnv(env, repo, snapshotRecord, key) {
  const value = process.env[key];
  if (!value) return;
  const resolved = externalPath(repo, value);
  if (!resolved || /[\r\n\0]/.test(resolved)) {
    throw new Error(
      `${key} must point to an existing regular file outside the reviewed repository`,
    );
  }
  assertPrivateEngineFileSnapshotDirectory(snapshotRecord);
  const sourceDescriptor = openSync(
    resolved,
    secureReadFlags({ nonBlocking: true }),
  );
  try {
    const sourceBefore = fstatSync(sourceDescriptor, { bigint: true });
    if (
      !sourceBefore.isFile() ||
      !trustedOwner(sourceBefore) ||
      sharedWritable(sourceBefore) ||
      (sourceBefore.mode & 0o6000n) !== 0n ||
      sourceBefore.nlink !== 1n ||
      sourceBefore.size > BigInt(MAX_TRUSTED_ENGINE_FILE_BYTES) ||
      hasWriteGrantingAcl(resolved, sourceBefore, key)
    ) {
      throw new Error(`${key} must point to a trusted regular file`);
    }
    const sourcePathBefore = lstatSync(resolved, { bigint: true });
    if (!sameFileMetadata(sourceBefore, sourcePathBefore)) {
      throw new Error(`${key} source identity changed before snapshot`);
    }
    const ancestryBefore = inspectTrustedDirectoryAncestry(
      path.dirname(resolved),
      `${key} source`,
    );
    assertTrustedExternalFileAncestry(ancestryBefore, key);

    const outputPath = engineFileSnapshotOutputPath(snapshotRecord, key);
    const outputDescriptor = openSync(outputPath, secureWriteFlags(), 0o600);
    let outputStat;
    try {
      streamAndHashRegularFile(
        sourceDescriptor,
        outputDescriptor,
        sourceBefore.size,
        key,
        MAX_TRUSTED_ENGINE_FILE_BYTES,
      );
      const sourceAfter = fstatSync(sourceDescriptor, { bigint: true });
      const sourcePathAfter = lstatSync(resolved, { bigint: true });
      if (
        !sameFileMetadata(sourceBefore, sourceAfter) ||
        !sameFileMetadata(sourceBefore, sourcePathAfter)
      ) {
        throw new Error(`${key} source identity changed during snapshot`);
      }
      const ancestryAfter = inspectTrustedDirectoryAncestry(
        path.dirname(resolved),
        `${key} source`,
      );
      assertTrustedExternalFileAncestry(ancestryAfter, key);
      assertStableDirectoryAncestry(
        ancestryBefore,
        ancestryAfter,
        `${key} source`,
      );

      outputStat = validateEngineFileSnapshot(
        snapshotRecord,
        outputPath,
        outputDescriptor,
        sourceBefore.size,
        key,
      );
      assertNoAwsCredentialProcess(
        outputDescriptor,
        outputPath,
        outputStat,
        key,
      );
    } finally {
      closeSync(outputDescriptor);
    }
    registerEngineFileSnapshotEnv(
      env,
      snapshotRecord,
      key,
      outputPath,
      outputStat,
    );
  } finally {
    closeSync(sourceDescriptor);
  }
}

function safeEngineEnv(repo, engine, runtimeDir) {
  if (process.env.SSL_CERT_DIR) {
    throw new Error(
      "SSL_CERT_DIR cannot be safely preserved for semantic autoreview; unset it or use SSL_CERT_FILE with a trusted PEM bundle outside the reviewed repository",
    );
  }
  const common = new Set([
    "ALL_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "all_proxy",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]);
  const engineKeys = {
    codex: new Set([
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORGANIZATION",
      "OPENAI_PROJECT",
    ]),
    claude: new Set([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "AWS_ACCESS_KEY_ID",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_DEFAULT_REGION",
      "AWS_EC2_METADATA_DISABLED",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_ROLE_ARN",
      "AWS_ROLE_SESSION_NAME",
      "AWS_SDK_LOAD_CONFIG",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLOUD_ML_REGION",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]),
  };
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      common.has(key) ||
      engineKeys[engine]?.has(key) ||
      key.startsWith("AUTOREVIEW_FAKE_")
    ) {
      env[key] = value;
    }
  }
  for (const key of [
    "ALL_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "all_proxy",
    "http_proxy",
    "https_proxy",
  ]) {
    if (env[key] && !safeProxyUrl(env[key])) {
      throw new Error(
        `unsafe credentialed or malformed proxy URL in ${key}; configure a credential-free proxy before autoreview`,
      );
    }
  }
  const claudeFallbackBlockingKeys = [...AWS_CREDENTIAL_CONFIG_KEYS];
  const externalFileKeys = [
    ...(process.env.SSL_CERT_FILE ? ["SSL_CERT_FILE"] : []),
    ...(engine === "claude"
      ? [
          ...claudeFallbackBlockingKeys,
          "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
          "AWS_WEB_IDENTITY_TOKEN_FILE",
          "GOOGLE_APPLICATION_CREDENTIALS",
        ].filter(
          (key) =>
            AWS_CREDENTIAL_CONFIG_KEYS.has(key) || Boolean(process.env[key]),
        )
      : []),
  ];
  if (externalFileKeys.length > 0) {
    const snapshotRecord = createEngineFileSnapshotDirectory(runtimeDir);
    for (const key of externalFileKeys) {
      if (AWS_CREDENTIAL_CONFIG_KEYS.has(key) && !process.env[key]) {
        createEmptyEngineFileSnapshotEnv(env, snapshotRecord, key);
      } else {
        snapshotExternalRegularFileEnv(env, repo, snapshotRecord, key);
      }
    }
    assertPrivateEngineFileSnapshotDirectory(snapshotRecord);
  }
  const home = externalPath(repo, process.env.HOME);
  if (home) env.HOME = home;
  if (engine === "codex") {
    const codexHome = externalPath(
      repo,
      process.env.CODEX_HOME || (home ? path.join(home, ".codex") : ""),
    );
    if (codexHome) env.CODEX_HOME = codexHome;
  }
  if (engine === "claude") {
    const claudeConfig = externalPath(repo, process.env.CLAUDE_CONFIG_DIR);
    if (claudeConfig) env.CLAUDE_CONFIG_DIR = claudeConfig;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }
  const git = resolveTrustedCommand("git", repo);
  const nodeRuntime = attestedNodeRuntime(repo);
  const node = nodeRuntime?.executable || trustedCurrentNode(repo);
  env.PATH = trustedToolPath(runtimeDir, { git, node });
  if (nodeRuntime) env.LD_LIBRARY_PATH = nodeRuntime.directory;
  env.TMPDIR = runtimeDir;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_EXTERNAL_DIFF = "";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  env.PAGER = "cat";
  return env;
}

function runCommandWithInput(
  command,
  commandArgs,
  cwd,
  prompt,
  { env, label, stream = false, timeoutSeconds = 1800 } = {},
) {
  return new Promise((resolve, reject) => {
    revalidateAllTrustedExecutableSnapshots();
    assertAllAttestedNodeLibraryPaths();
    const child = spawn(command, commandArgs, {
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeReviewerChildren.add(child);
    if (pendingTerminationSignal) terminateActiveReviewerChildren();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    let settled = false;
    let stdinWriteError = null;
    const configuredHeartbeat = Number.parseInt(
      process.env.AUTOREVIEW_HEARTBEAT_SECONDS || "60",
      10,
    );
    const heartbeatSeconds =
      Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0
        ? configuredHeartbeat
        : 60;
    const started = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      console.error(
        `review still running: ${label || path.basename(command)} elapsed=${elapsed}s pid=${child.pid}`,
      );
    }, heartbeatSeconds * 1000);
    heartbeat.unref?.();

    let timeout;
    const finishTracking = () => {
      activeReviewerChildren.delete(child);
      activeReviewerAborters.delete(child);
      if (activeReviewerChildren.size === 0) clearReviewerForceKillTimer();
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      finishTracking();
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      finishTracking();
      resolve(value);
    };
    const forceAbort = (error) => {
      try {
        signalReviewerProcessGroup(child, "SIGKILL");
      } catch {
        // Pipe destruction below still bounds command settlement.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      rejectOnce(error);
    };
    activeReviewerAborters.set(child, forceAbort);
    timeout = setTimeout(() => {
      timedOut = true;
      signalReviewerProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(
        () =>
          forceAbort(
            new Error(`${command} timed out after ${timeoutSeconds}s`),
          ),
        5000,
      );
      killTimer.unref?.();
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (stream) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (stream) process.stderr.write(text);
    });
    child.on("error", (error) => {
      rejectOnce(error);
    });
    const handleStdinError = (error) => {
      if (settled) return;
      if (error?.code === "EPIPE") {
        stdinWriteError = error;
        return;
      }
      forceAbort(error);
    };
    child.stdin.on("error", handleStdinError);
    child.on("close", (code, signal) => {
      signalReviewerProcessGroup(child, "SIGKILL");
      try {
        assertAllAttestedNodeLibraryPaths();
      } catch (error) {
        rejectOnce(error);
        return;
      }
      if (timedOut) {
        rejectOnce(new Error(`${command} timed out after ${timeoutSeconds}s`));
        return;
      }
      if (code !== 0) {
        rejectOnce(
          new Error(
            `${command} failed (${code ?? signal}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      if (stdinWriteError) {
        rejectOnce(
          new Error(
            `${command} exited successfully after closing stdin before the complete review prompt was written: ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolveOnce({ stdout, stderr });
    });
    try {
      child.stdin.end(prompt);
    } catch (error) {
      handleStdinError(error);
    }
  });
}

function tomlInlineTable(values) {
  return `{${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ")}}`;
}

async function runCodex(repo, args, prompt) {
  const codex = resolveTrustedCommand("codex", repo, { required: false });
  if (!codex) {
    throw new Error("codex CLI is not available");
  }
  if (!args.tools) {
    throw new Error(
      "--no-tools is not supported for Codex; use read-only sandbox",
    );
  }
  const tempRoot = safeTempRoot(repo);
  const tempDir = createRegisteredEngineRuntimeDirectory(
    tempRoot,
    "autoreview-codex.",
  );
  const workspace = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  const logDir = path.join(tempDir, "log");
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "last-message.json");
  try {
    mkdirSync(workspace);
    mkdirSync(stateDir);
    mkdirSync(logDir);
    writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA));
    const toolEnv = tomlInlineTable({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXTERNAL_DIFF: "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      PAGER: "cat",
    });
    const codexArgs = [
      "--ask-for-approval",
      "never",
      ...(args.webSearch ? ["--search"] : []),
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      `sqlite_home=${JSON.stringify(stateDir)}`,
      "-c",
      `log_dir=${JSON.stringify(logDir)}`,
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "features.hooks=false",
      "-c",
      "features.plugins=false",
      "-c",
      "skills.include_instructions=false",
      "-c",
      "skills.config=[]",
      "-c",
      `projects.${JSON.stringify(workspace)}.trust_level="untrusted"`,
      "-c",
      'shell_environment_policy.inherit="core"',
      "-c",
      "shell_environment_policy.ignore_default_excludes=false",
      "-c",
      `shell_environment_policy.set=${toolEnv}`,
      "-c",
      "shell_environment_policy.experimental_use_profile=false",
      "-c",
      "allow_login_shell=false",
      "-c",
      'default_permissions="autoreview"',
      "-c",
      'permissions.autoreview.filesystem={":minimal"="read",":workspace_roots"="read"}',
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--ephemeral",
      "-C",
      workspace,
      "-s",
      "read-only",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
    ];
    if (args.model) codexArgs.push("--model", args.model);
    if (args.thinking) {
      codexArgs.push("-c", `model_reasoning_effort="${args.thinking}"`);
    }
    codexArgs.push("-");
    const result = await runCommandWithInput(
      codex,
      codexArgs,
      workspace,
      prompt,
      {
        env: safeEngineEnv(repo, "codex", tempDir),
        label: "codex",
        stream: args.streamEngineOutput,
        timeoutSeconds: args.timeoutSeconds,
      },
    );
    return existsSync(outputPath)
      ? readFileSync(outputPath, "utf8")
      : result.stdout;
  } finally {
    removeEngineRuntimeDirectory(tempDir);
  }
}

function parseVersion(text) {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map((part) => Number.parseInt(part, 10)) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function ensureClaudeIsolationSupported(claude, repo, env, cwd) {
  let versionResult;
  try {
    versionResult = await runCommandWithInput(claude, ["--version"], cwd, "", {
      env,
      label: "claude version probe",
      timeoutSeconds: 15,
    });
  } catch {
    throw new Error(
      "claude engine requires Claude Code >= 2.1.169 for --safe-mode",
    );
  }
  const version = parseVersion(
    `${versionResult.stdout || ""}\n${versionResult.stderr || ""}`,
  );
  if (!version || compareVersion(version, CLAUDE_SAFE_MODE_MIN_VERSION) < 0) {
    throw new Error(
      "claude engine requires Claude Code >= 2.1.169 for --safe-mode",
    );
  }
  let helpResult;
  try {
    helpResult = await runCommandWithInput(claude, ["--help"], cwd, "", {
      env,
      label: "claude help probe",
      timeoutSeconds: 15,
    });
  } catch {
    throw new Error(
      "claude engine is missing required isolation flags: --help failed",
    );
  }
  const help = `${helpResult.stdout || ""}\n${helpResult.stderr || ""}`;
  const required = [
    "--safe-mode",
    "--setting-sources",
    "--strict-mcp-config",
    "--disallowedTools",
    "--tools",
  ];
  const missing = required.filter((flag) => !help.includes(flag));
  if (missing.length > 0) {
    throw new Error(
      `claude engine is missing required isolation flags: ${missing.join(", ") || "--help failed"}`,
    );
  }
}

async function runClaude(repo, args, prompt) {
  const claude = resolveTrustedCommand("claude", repo, { required: false });
  if (!claude) {
    throw new Error("claude CLI is not available");
  }
  const tempRoot = safeTempRoot(repo);
  const tempDir = createRegisteredEngineRuntimeDirectory(
    tempRoot,
    "autoreview-claude-workspace.",
  );
  const workspace = path.join(tempDir, "workspace");
  try {
    mkdirSync(workspace);
    const env = safeEngineEnv(repo, "claude", tempDir);
    await ensureClaudeIsolationSupported(claude, repo, env, workspace);
    const claudeArgs = [
      "--safe-mode",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--disallowedTools",
      "mcp__*",
      "--print",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(REVIEW_SCHEMA),
      "--permission-mode",
      "dontAsk",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
    ];
    if (args.model) claudeArgs.push("--model", args.model);
    if (args.thinking) claudeArgs.push("--effort", args.thinking);
    if (args.tools) {
      claudeArgs.push("--tools", args.webSearch ? "WebSearch" : "");
    } else {
      claudeArgs.push("--tools", "");
    }
    const result = await runCommandWithInput(
      claude,
      claudeArgs,
      workspace,
      prompt,
      {
        env,
        label: "claude",
        stream: args.streamEngineOutput,
        timeoutSeconds: args.timeoutSeconds,
      },
    );
    return result.stdout;
  } finally {
    removeEngineRuntimeDirectory(tempDir);
  }
}

function parseJsonCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    // Claude's JSON output mode can wrap the actual review JSON as a string.
    if (typeof parsed === "string") return parseJsonCandidate(parsed) ?? parsed;
    return parsed;
  } catch {
    return null;
  }
}

function extractReviewJson(raw) {
  const direct = parseJsonCandidate(raw);
  const candidates = [];
  if (direct) candidates.push(direct);

  if (direct && typeof direct === "object") {
    for (const key of [
      "structured_output",
      "result",
      "content",
      "text",
      "message",
    ]) {
      if (direct[key] && typeof direct[key] === "object") {
        candidates.push(direct[key]);
      }
      if (typeof direct[key] === "string") {
        const nested = parseJsonCandidate(direct[key]);
        if (nested) candidates.push(nested);
      }
    }
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const sliced = parseJsonCandidate(raw.slice(first, last + 1));
    if (sliced) candidates.push(sliced);
  }

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      Array.isArray(candidate.findings)
    ) {
      return candidate;
    }
  }
  throw new Error("review engine did not return the expected structured JSON");
}

function isNumberInRange(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function validateReport(report, paths) {
  const required = [
    "findings",
    "overall_correctness",
    "overall_explanation",
    "overall_confidence",
  ];
  for (const key of required) {
    if (!(key in report)) throw new Error(`review JSON missing ${key}`);
  }
  if (!Array.isArray(report.findings)) {
    throw new Error("review JSON findings must be an array");
  }
  if (
    !["patch is correct", "patch is incorrect"].includes(
      report.overall_correctness,
    )
  ) {
    throw new Error("review JSON has invalid overall_correctness");
  }
  if (!isNumberInRange(report.overall_confidence)) {
    throw new Error("review JSON has invalid overall_confidence");
  }
  if (
    typeof report.overall_explanation !== "string" ||
    report.overall_explanation.length === 0
  ) {
    throw new Error("review JSON has invalid overall_explanation");
  }

  const kept = [];
  for (const [index, finding] of report.findings.entries()) {
    if (!finding || typeof finding !== "object") {
      throw new Error(`finding ${index} must be an object`);
    }
    const location = finding.code_location;
    const rel = location?.file_path;
    if (
      typeof finding.title !== "string" ||
      typeof finding.body !== "string" ||
      !["P0", "P1", "P2", "P3"].includes(finding.priority) ||
      !isNumberInRange(finding.confidence) ||
      ![
        "bug",
        "security",
        "regression",
        "test_gap",
        "maintainability",
      ].includes(finding.category) ||
      !location ||
      typeof rel !== "string" ||
      typeof location.line !== "number"
    ) {
      throw new Error(`finding ${index} has invalid shape`);
    }
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      throw new Error(`finding ${index} has invalid path: ${rel}`);
    }
    if (!paths.has(rel)) {
      console.error(`autoreview ignored out-of-scope finding ${index}: ${rel}`);
      continue;
    }
    kept.push(finding);
  }
  if (kept.length !== report.findings.length) {
    report.findings = kept;
    if (kept.length === 0) report.overall_correctness = "patch is correct";
  }
  return report;
}

function lineNumber(text, needle) {
  const index =
    typeof needle === "string" ? text.indexOf(needle) : text.search(needle);
  if (index < 0) return 1;
  return text.slice(0, index).split("\n").length;
}

function targetTreeRef(target) {
  if (!target) return null;
  if (target.mode === "branch") return target.head;
  if (target.mode === "commit") return target.ref;
  return null;
}

function readGitBlob(repo, treeRef, rel) {
  const result = runGitBufferResult(repo, ["show", `${treeRef}:${rel}`]);
  if (result.status !== 0) return null;
  if (result.stdout.includes(0)) return "[binary file omitted]";
  try {
    return decodeGitOutput(result.stdout, "git blob");
  } catch {
    return "[binary file omitted]";
  }
}

function readRepoFile(repo, rel, target = null) {
  const treeRef = targetTreeRef(target);
  if (treeRef) return readGitBlob(repo, treeRef, rel);
  const full = path.join(repo, rel);
  if (!existsSync(full)) return null;
  return readText(full);
}

function addLocalFinding(
  findings,
  filePath,
  line,
  title,
  body,
  priority = "P1",
  category = "bug",
) {
  findings.push({
    title,
    body,
    priority,
    confidence: 0.9,
    category,
    code_location: {
      file_path: filePath,
      line: Math.max(1, line),
    },
  });
}

function changedSetHas(paths, rel) {
  return paths.has(rel);
}

function collectWorkflowTfVars(repo, workflowPath, target) {
  const text = readRepoFile(repo, workflowPath, target);
  if (!text) return new Set();
  const vars = new Set();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s+(TF_VAR_[A-Za-z0-9_]+):/);
    if (match) vars.add(match[1]);
  }
  return vars;
}

function reviewTerraformDriftWorkflow(repo, target, paths, findings) {
  const driftPath = ".github/workflows/terraform-drift.yml";
  if (!changedSetHas(paths, driftPath)) return;
  const text = readRepoFile(repo, driftPath, target);
  if (!text) return;

  if (/terraform plan[^\n]*\|\s*tee\s+\/tmp\/tf-plan\.txt/.test(text)) {
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(text, /terraform plan[^\n]*\|\s*tee\s+\/tmp\/tf-plan\.txt/),
      "Drift workflow logs raw Terraform plan output",
      "The drift workflow pipes raw `terraform plan` output through `tee` before redaction. Drift plans can include destroy-time provider state such as Discord webhook tokens or QuickNode `security_token` values. Capture to a raw temp file, sanitize into `/tmp/tf-plan.txt`, and only print/read the sanitized file.",
      "P1",
      "security",
    );
  }

  if (
    /cat\s+\/tmp\/tf-plan\.raw|readFileSync\(["']\/tmp\/tf-plan\.raw["']/.test(
      text,
    )
  ) {
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(
        text,
        /cat\s+\/tmp\/tf-plan\.raw|readFileSync\(["']\/tmp\/tf-plan\.raw["']/,
      ),
      "Drift workflow exposes raw Terraform plan output",
      "The workflow still prints or reads `/tmp/tf-plan.raw` after sanitization was introduced. Only `/tmp/tf-plan.txt` should be used for logs, comments, or issues because raw Terraform output can contain provider state secrets.",
      "P1",
      "security",
    );
  }

  const sourceWorkflows = [
    ".github/workflows/alerts-rules.yml",
    ".github/workflows/alerts-infra.yml",
    ".github/workflows/aegis-terraform.yml",
  ];
  const required = new Set();
  for (const workflow of sourceWorkflows) {
    for (const name of collectWorkflowTfVars(repo, workflow, target))
      required.add(name);
  }
  const present = collectWorkflowTfVars(repo, driftPath, target);
  const missing = [...required].filter((name) => !present.has(name)).sort();
  if (missing.length > 0) {
    const anchor = text.includes("Union of every TF_VAR")
      ? "Union of every TF_VAR"
      : "env:";
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(text, anchor),
      "Drift workflow is missing auto-applied stack TF_VAR secrets",
      `The drift job now discovers every auto-applied stack, but its env union is missing: ${missing.join(", ")}. Those stacks will fail refresh/plan or produce misleading drift results when the scheduled workflow reaches them. Keep this union in sync with alerts-rules, alerts-infra, and aegis Terraform workflows.`,
      "P1",
      "bug",
    );
  }

  const needsRedaction =
    /TF_VAR_discord_|TF_VAR_quicknode_|discord.*webhooks|security_token/i.test(
      text,
    );
  if (
    needsRedaction &&
    !/security_token\[/.test(text) &&
    !/discord\(app\)\?/.test(text)
  ) {
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(text, "terraform plan"),
      "Drift workflow lacks token redaction rules",
      "This workflow has Discord or QuickNode secret context but no matching plan-output redaction rules. Add the same sanitizer used by the alert Terraform PR-plan workflows before printing logs or opening drift issues.",
      "P1",
      "security",
    );
  }
}

function deletedFileReferenceChecks(repo, target) {
  const checks = [];
  const seen = new Set();
  const add = (deleted, treeRef) => {
    for (const rel of deleted) {
      const key = `${treeRef || "worktree"}\0${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push({ rel, treeRef });
    }
  };

  if (target.mode === "branch") {
    add(
      gitPathList(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--diff-filter=D",
        "-z",
        `${target.ref}...${target.head}`,
        "--",
      ]),
      target.head,
    );
  }
  if (target.mode === "branch-local") {
    add(
      gitPathList(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--diff-filter=D",
        "-z",
        `${target.ref}...${target.head}`,
        "--",
      ]),
      null,
    );
  }
  if (target.mode === "commit") {
    add(
      gitPathList(repo, [
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--diff-filter=D",
        "--format=",
        "-z",
        "--end-of-options",
        target.ref,
        "--",
      ]),
      target.ref,
    );
  }
  if (target.mode === "local" || target.mode === "branch-local") {
    add(
      gitPathList(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--diff-filter=D",
        "--cached",
        "-z",
        target.head,
        "--",
      ]),
      null,
    );
    add(
      gitPathList(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--diff-filter=D",
        "-z",
      ]),
      null,
    );
  }

  return checks;
}

function reviewDeletedFileReferences(repo, target, findings) {
  for (const { rel, treeRef } of deletedFileReferenceChecks(repo, target)) {
    const grepArgs = treeRef
      ? ["grep", "-n", "-F", "--", rel, treeRef, "--", "."]
      : ["grep", "-n", "-F", "--", rel, "--", "."];
    const result = runGitResult(repo, grepArgs);
    if (result.status !== 0 || !result.stdout.trim()) continue;
    const treePrefix = treeRef ? `${treeRef}:` : "";
    const hit = result.stdout
      .split("\n")
      .map((line) =>
        treePrefix && line.startsWith(treePrefix)
          ? line.slice(treePrefix.length)
          : line,
      )
      .find((line) => !line.startsWith(`${rel}:`));
    if (!hit) continue;
    const fileSeparator = hit.indexOf(":");
    if (fileSeparator === -1) continue;
    const filePath = hit.slice(0, fileSeparator);
    const lineAndContent = hit.slice(fileSeparator + 1);
    const lineSeparator = lineAndContent.indexOf(":");
    const rawLine =
      lineSeparator === -1
        ? lineAndContent
        : lineAndContent.slice(0, lineSeparator);
    addLocalFinding(
      findings,
      filePath,
      Number.parseInt(rawLine, 10) || 1,
      "Deleted file is still referenced",
      `This change deletes \`${rel}\`, but \`${filePath}\` still references that exact path. Update or remove the stale reference so future runbooks and agents do not follow a dead file path.`,
      "P2",
      "maintainability",
    );
  }
}

function reviewDocsDrift(repo, target, paths, findings) {
  const docsLike = [
    "BACKLOG.md",
    "README.md",
    "AGENTS.md",
    "SPEC.md",
    ...[...paths].filter(
      (rel) => rel.startsWith("docs/") && rel.endsWith(".md"),
    ),
  ];
  const seen = new Set();
  const stalePatterns = [
    {
      pattern: /skip[s]?\s+`?alerts-delivery`?|`alerts-delivery`[^.\n]*skip/i,
      title: "Docs still say alerts-delivery drift is skipped",
      body: "`alerts-delivery` is no longer filtered out of drift detection in this change. This stale note will make future operators expect a skip that no longer exists.",
    },
    {
      pattern:
        /aegis once PR|PR #629 lands|bring `?aegis\/terraform\/?`? under CI auto-apply/i,
      title: "Docs still describe Aegis auto-apply as future work",
      body: "Aegis is already registered as an auto-applied Terraform stack in this branch. Update this stale future-tense note so the runbook matches the workflow registry.",
    },
  ];
  for (const rel of docsLike) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readRepoFile(repo, rel, target);
    if (!text) continue;
    for (const stale of stalePatterns) {
      if (!stale.pattern.test(text)) continue;
      addLocalFinding(
        findings,
        rel,
        lineNumber(text, stale.pattern),
        stale.title,
        stale.body,
        "P2",
        "maintainability",
      );
    }
  }
}

function diffCheckCommands(repo, target) {
  if (target.mode === "branch") {
    return [["diff", "--check", `${target.ref}...${target.head}`]];
  }
  if (target.mode === "commit") {
    return [["show", "--format=", "--check", target.ref]];
  }
  if (target.mode === "branch-local") {
    const mergeBase = runGit(repo, [
      "merge-base",
      target.ref,
      target.head,
    ]).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(mergeBase)) {
      throw new Error("branch-local review target has no valid merge base");
    }
    return [["diff", "--check", mergeBase]];
  }
  return [
    ["diff", "--cached", "--check", target.head],
    ["diff", "--check"],
  ];
}

function reviewDiffCheck(repo, target, findings) {
  const outputs = [];
  for (const gitArgs of diffCheckCommands(repo, target)) {
    const result = runGitResult(repo, gitArgs);
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) outputs.push(output);
  }
  const output = outputs.join("\n");
  if (!output) return;
  const first = output.split("\n").find(Boolean) || output;
  const match = first.match(/^(.+):(\d+):\s*(.+)$/);
  addLocalFinding(
    findings,
    match?.[1] || "git diff",
    match ? Number.parseInt(match[2], 10) : 1,
    "Diff contains whitespace or conflict-marker errors",
    output.split("\n").slice(0, 10).join("\n"),
    "P2",
    "maintainability",
  );
}

function runLocalReview(
  repo,
  target,
  paths,
  reason = "deterministic local review",
) {
  const findings = [];
  reviewTerraformDriftWorkflow(repo, target, paths, findings);
  reviewDeletedFileReferences(repo, target, findings);
  reviewDocsDrift(repo, target, paths, findings);
  reviewDiffCheck(repo, target, findings);
  return {
    findings,
    overall_correctness:
      findings.length > 0 ? "patch is incorrect" : "patch is correct",
    overall_explanation:
      findings.length > 0
        ? `Local autoreview found ${findings.length} deterministic finding(s). ${reason}.`
        : `Local autoreview found no deterministic findings. ${reason}; this is not a full second-model semantic review.`,
    overall_confidence: findings.length > 0 ? 0.9 : 0.75,
  };
}

function printReport(report) {
  const lines = [];
  if (
    report.findings.length === 0 &&
    report.overall_correctness === "patch is correct"
  ) {
    lines.push("autoreview clean: no accepted/actionable findings reported");
  } else {
    lines.push(`autoreview findings: ${report.findings.length}`);
  }
  for (const finding of report.findings) {
    const loc = finding.code_location;
    lines.push("");
    lines.push(`[${finding.priority}] ${finding.title}`);
    lines.push(`${loc.file_path}:${loc.line}`);
    lines.push(finding.body);
    lines.push(`confidence: ${finding.confidence}`);
  }
  lines.push("");
  lines.push(
    `overall: ${report.overall_correctness} (${report.overall_confidence})`,
  );
  lines.push(report.overall_explanation);
  return `${lines.join("\n")}\n`;
}

function nonTestPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return !(
    /(^|\/)(?:__tests__|fixtures|test|tests)(\/|$)/.test(normalized) ||
    /\.(?:spec|test)\.[^/]+$/.test(normalized)
  );
}

function numstatSources(repo, target) {
  if (target.mode === "local") {
    return [
      runGit(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "--cached",
        target.head,
        "--",
      ]),
      runGit(repo, ["diff", "--no-ext-diff", "--no-textconv", "--numstat"]),
    ];
  }
  if (target.mode === "branch") {
    return [
      runGit(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        `${target.ref}...${target.head}`,
      ]),
    ];
  }
  if (target.mode === "branch-local") {
    return [
      runGit(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        `${target.ref}...${target.head}`,
      ]),
      runGit(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "--cached",
        target.head,
        "--",
      ]),
      runGit(repo, ["diff", "--no-ext-diff", "--no-textconv", "--numstat"]),
    ];
  }
  return [
    runGit(repo, [
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "--format=",
      target.ref,
    ]),
  ];
}

function scopeBaseline(repo, target, paths) {
  let nonTestLoc = 0;
  for (const source of numstatSources(repo, target)) {
    for (const line of source.split("\n")) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!match || !nonTestPath(match[3])) continue;
      if (match[1] !== "-") nonTestLoc += Number.parseInt(match[1], 10);
      if (match[2] !== "-") nonTestLoc += Number.parseInt(match[2], 10);
    }
  }
  if (target.mode === "local" || target.mode === "branch-local") {
    const untracked = gitPathList(repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    for (const relativePath of untracked) {
      if (!nonTestPath(relativePath)) continue;
      try {
        const filePath = path.join(repo, relativePath);
        const lexicalStat = lstatSync(filePath);
        if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) continue;
        const resolved = realpathSync(filePath);
        if (!isWithin(resolved, repo)) continue;
        const { data: content } = readBoundedRegularFile(
          resolved,
          "untracked file",
        );
        nonTestLoc +=
          content.length === 0
            ? 0
            : content.toString("utf8").split("\n").length -
              (content.at(-1) === 0x0a ? 1 : 0);
      } catch (error) {
        if (error.code === "AUTOREVIEW_INPUT_TOO_LARGE") throw error;
        // Bundle construction will report unsafe or unreadable untracked files.
      }
    }
  }
  return { changedFiles: paths.size, nonTestLoc };
}

function assertReviewableBundle(paths, bundle) {
  const blocked = [...paths]
    .map((relativePath) => ({
      relativePath,
      reason: sensitivePathReason(relativePath),
    }))
    .filter(({ reason }) => reason);
  if (blocked.length > 0) {
    throw new Error(
      `refusing to include sensitive changed paths in review bundle: ${blocked
        .slice(0, 10)
        .map(({ relativePath, reason }) => `${relativePath} (${reason})`)
        .join(", ")}`,
    );
  }
  if (
    /(?:^|\n)(?:GIT binary patch|Binary files .+ differ)(?:\n|$)/.test(bundle)
  ) {
    throw new Error(
      "refusing binary changes because their complete contents cannot be reviewed",
    );
  }
  if (
    /(?:^|\n)(?:(?:old|new|new file|deleted file) mode 160000|[+-]Subproject commit )/.test(
      bundle,
    )
  ) {
    throw new Error(
      "refusing gitlink/submodule changes because dependency contents are absent from the review bundle",
    );
  }
  assertNoSecretLikeContent("selected change", bundle);
}

function hashHeadIdentity(hash, state) {
  hash.update("\0head-oid\0");
  hash.update(state.headOid);
  hash.update("\0head-ref\0");
  hash.update(
    state.branch ? `symbolic:refs/heads/${state.branch}` : "detached",
  );
}

function targetSelectionState(repo) {
  const status = runGitBufferResult(repo, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--no-ahead-behind",
    "-z",
    "--untracked-files=normal",
  ]);
  if (status.status !== 0) {
    const stderr = decodeGitOutput(status.stderr, "git status stderr").trim();
    throw new Error(
      `git status failed while selecting the review target: ${stderr || `git exited ${status.status}`}`,
    );
  }
  let headOid = "";
  let branch = "";
  let dirty = false;
  let sawStatusRecord = false;
  let offset = 0;
  while (offset < status.stdout.length) {
    let end = status.stdout.indexOf(0, offset);
    if (end < 0) end = status.stdout.length;
    const record = status.stdout.subarray(offset, end);
    if (
      !sawStatusRecord &&
      record.subarray(0, 13).toString("ascii") === "# branch.oid "
    ) {
      headOid = decodeGitOutput(
        record.subarray(13),
        "git status branch.oid",
      ).trim();
    } else if (
      !sawStatusRecord &&
      record.subarray(0, 14).toString("ascii") === "# branch.head "
    ) {
      const head = decodeGitOutput(
        record.subarray(14),
        "git status branch.head",
      ).trim();
      branch = head === "(detached)" ? "" : head;
    } else if (record.length > 0 && !sawStatusRecord && record[0] === 0x23) {
      // Other branch metadata may precede the first status record.
    } else if (record.length > 0) {
      sawStatusRecord = true;
      dirty = true;
    }
    offset = end + 1;
  }
  if (!/^[0-9a-f]{40,64}$/i.test(headOid)) {
    throw new Error("git status omitted a valid branch.oid");
  }
  return {
    branch,
    dirty,
    headOid,
    snapshot: createHash("sha256").update(status.stdout).digest("hex"),
  };
}

function targetSelectionSnapshot(repo) {
  return targetSelectionState(repo).snapshot;
}

function sourceSnapshot(
  repo,
  { includeLocalChanges = true, includeUntracked = true } = {},
) {
  const hash = createHash("sha256");
  const selectionState = targetSelectionState(repo);
  hashHeadIdentity(hash, selectionState);
  hash.update(
    `\0local-changes\0${includeLocalChanges ? "included" : "excluded"}`,
  );
  if (includeLocalChanges) {
    hash.update("\0staged\0");
    hash.update(
      runGit(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--cached",
        selectionState.headOid,
        "--",
      ]),
    );
    hash.update("\0unstaged\0");
    hash.update(
      runGit(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--",
      ]),
    );
  }
  hash.update(`\0untracked\0${includeUntracked ? "included" : "excluded"}`);
  if (includeUntracked) {
    for (const relativePath of gitPathList(repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]).sort()) {
      hash.update("\0path\0");
      hash.update(relativePath);
      const filePath = path.join(repo, relativePath);
      try {
        const fileStat = lstatSync(filePath);
        if (fileStat.isSymbolicLink()) {
          hash.update("\0symlink\0");
          hash.update("\0mode\0");
          hash.update("120000");
          hash.update(readlinkSync(filePath));
        } else if (fileStat.isFile()) {
          const resolved = realpathSync(filePath);
          if (!isWithin(resolved, repo)) {
            hash.update("\0outside\0");
          } else {
            const { data, fileStat: openedStat } = readBoundedRegularFile(
              resolved,
              "untracked file",
            );
            hash.update("\0file\0");
            hash.update(`\0mode\0${normalizedGitFileMode(openedStat)}`);
            hash.update(data);
          }
        } else {
          hash.update("\0non-file\0");
        }
      } catch (error) {
        if (error.code === "AUTOREVIEW_INPUT_TOO_LARGE") throw error;
        hash.update(`\0unreadable\0${error.code || error.name}`);
      }
    }
  }
  return hash.digest("hex");
}

function snapshotOptionsForTarget(target) {
  const includeLocalChanges =
    target.mode === "local" || target.mode === "branch-local";
  return {
    includeLocalChanges,
    includeUntracked: includeLocalChanges,
  };
}

function assertSourceSnapshot(repo, expected, target, message) {
  if (sourceSnapshot(repo, snapshotOptionsForTarget(target)) !== expected) {
    throw new Error(message);
  }
}

function assertTargetSelectionSnapshot(repo, expected, message) {
  if (targetSelectionSnapshot(repo) !== expected) {
    throw new Error(message);
  }
}

function assertReviewSourceState(
  repo,
  expectedSource,
  target,
  expectedTargetSelection,
  guardTargetSelection,
  message,
) {
  if (guardTargetSelection) {
    assertTargetSelectionSnapshot(repo, expectedTargetSelection, message);
  }
  assertSourceSnapshot(repo, expectedSource, target, message);
}

function recordStageDuration(stage, startedAtMs) {
  stageTimings.push({ stage, seconds: (Date.now() - startedAtMs) / 1000 });
}

// Stage-duration logging is best-effort observability; it mirrors the gate's
// `.tmp/agent-<tool>/durations.jsonl` convention and must never fail the review.
function flushStageDurations() {
  if (!stageDurationsContext || stageTimings.length === 0) return;
  const { repo, mode } = stageDurationsContext;
  const timings = stageTimings.splice(0);
  const ts = new Date().toISOString();
  try {
    const dir =
      process.env.AGENT_AUTOREVIEW_DURATIONS_DIR ||
      path.join(repo, ".tmp", "agent-autoreview");
    mkdirSync(dir, { recursive: true });
    const lines = timings
      .map((entry) =>
        JSON.stringify({
          ts,
          stage: entry.stage,
          seconds: entry.seconds,
          mode,
        }),
      )
      .join("\n");
    writeFileSync(path.join(dir, "durations.jsonl"), `${lines}\n`, {
      flag: "a",
    });
  } catch {
    // Never let logging failure abort or fail the review.
  }
  // The durable JSONL above is always written; the human-readable stderr
  // summary is opt-in so it cannot leak into the wrapper's strict reviewer-
  // cleanliness stderr contract.
  if (!process.env.AGENT_AUTOREVIEW_STAGE_SUMMARY) return;
  const summary = timings
    .map(
      (entry) =>
        `agent:autoreview: stage-timing   ${entry.stage} ${entry.seconds.toFixed(2)}s`,
    )
    .join("\n");
  console.error(
    `agent:autoreview: stage-timing summary (mode=${mode}):\n${summary}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--serialize-untracked-file") {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error(
        "--serialize-untracked-file requires exactly one repo-relative path",
      );
    }
    process.stdout.write(serializeSafeUntrackedFile(repoRoot(), argv[1]));
    return 0;
  }
  const args = parseArgs(argv);
  const repo = repoRoot();
  if (args.sourceSnapshotOnly) {
    const includeLocalChanges = !["branch", "commit"].includes(args.mode);
    console.log(
      sourceSnapshot(repo, {
        includeLocalChanges,
        includeUntracked: includeLocalChanges,
      }),
    );
    return 0;
  }
  stageDurationsContext = { repo, mode: args.mode };
  const targetSelectionStartedAt = Date.now();
  let selectionState;
  let target;
  let targetSelectionSourceSnapshot;
  let reviewSourceSnapshot = null;
  try {
    selectionState = targetSelectionState(repo);
    targetSelectionSourceSnapshot = args.dryRun
      ? null
      : selectionState.snapshot;
    try {
      target = chooseTarget(repo, args, selectionState);
    } catch (error) {
      if (
        args.dryRun &&
        error.message ===
          "no review target: clean main checkout and no forced mode"
      ) {
        target = { mode: "none", ref: null };
      } else {
        throw error;
      }
    }
    if (!args.dryRun) {
      target = freezeTargetRef(repo, target, selectionState);
      assertTargetSelectionSnapshot(
        repo,
        targetSelectionSourceSnapshot,
        "source changed while the review target was being selected; rerun autoreview against the updated tree",
      );
      reviewSourceSnapshot = sourceSnapshot(
        repo,
        snapshotOptionsForTarget(target),
      );
      assertTargetSelectionSnapshot(
        repo,
        targetSelectionSourceSnapshot,
        "source changed while the review target was being selected; rerun autoreview against the updated tree",
      );
    }
  } finally {
    // Record the span even when selection throws -- e.g. an automatic gh base
    // lookup timing out, or a post-freeze source-state check failing -- so a
    // failed run still reports where it spent time. The top-level `.finally`
    // flushes whatever spans were recorded.
    recordStageDuration("target-selection", targetSelectionStartedAt);
  }
  const bundlePrepStartedAt = Date.now();
  const guardTargetSelectionDuringReview = args.mode === "auto";
  const branch = selectionState.branch || "detached";

  console.log(`autoreview target: ${target.mode}`);
  console.log(`branch: ${branch}`);
  console.log(`engine: ${args.engine}`);
  if (target.requested_ref)
    console.log(`requested_ref: ${target.requested_ref}`);
  if (target.ref) console.log(`ref: ${target.ref}`);
  if (target.head) console.log(`head: ${target.head}`);
  console.log(`tools: ${args.tools ? "on" : "off"}`);
  console.log(`web_search: ${args.webSearch ? "on" : "off"}`);
  if (args.dryRun) return 0;

  let paths;
  let prompts = [];
  try {
    paths = changedPaths(repo, target);
    if (paths.size === 0) {
      assertReviewSourceState(
        repo,
        reviewSourceSnapshot,
        target,
        targetSelectionSourceSnapshot,
        guardTargetSelectionDuringReview,
        "source changed while the review target was being selected; rerun autoreview against the updated tree",
      );
      console.log("autoreview clean: no changed files for selected target");
      return 0;
    }
    const baseline = scopeBaseline(repo, target, paths);
    console.log(
      `scope_baseline: changed_files=${baseline.changedFiles} non_test_loc=${baseline.nonTestLoc}`,
    );

    const needsBundle =
      args.engine !== "local" ||
      args.prepareOnly ||
      Boolean(args.bundleOutput) ||
      args.prompts.length > 0 ||
      args.promptFiles.length > 0 ||
      args.datasets.length > 0;
    let bundleOutputs = [];
    if (needsBundle) {
      const bundle =
        target.mode === "local"
          ? localBundle(repo, target)
          : target.mode === "branch"
            ? branchBundle(repo, target)
            : target.mode === "branch-local"
              ? branchLocalBundle(repo, target)
              : commitBundle(repo, target.ref);
      assertReviewableBundle(paths, bundle);
      assertNoSecretLikeContent("current branch", branch);
      if (target.requested_ref) {
        assertNoSecretLikeContent(
          "requested review target ref",
          target.requested_ref,
        );
      }
      if (target.ref)
        assertNoSecretLikeContent("review target ref", target.ref);
      const bundleBytes = utf8Size(bundle);
      const extras = loadExtras(
        repo,
        args,
        MAX_REVIEW_INPUT_BYTES - bundleBytes,
      );
      prompts = buildBoundedReviewPrompts(bundle, (chunk, position) =>
        renderReviewPrompt(target, branch, baseline, chunk, extras, position),
      );
      assertReviewSourceState(
        repo,
        reviewSourceSnapshot,
        target,
        targetSelectionSourceSnapshot,
        guardTargetSelectionDuringReview,
        "source changed while the review bundle was being created; rerun autoreview against the updated tree",
      );
      console.log(
        `bundle: ${bundleBytes} bytes; review passes: ${prompts.length}`,
      );
      if (args.prepareOnly) {
        const displayedBundleOutput =
          args.bundleOutputDisplay || args.bundleOutput;
        if (args.bundleOutput) {
          writeReviewPromptOutputs(args.bundleOutput, prompts);
          bundleOutputs = reviewPromptOutputPaths(
            displayedBundleOutput,
            prompts.length,
          );
          console.log(`bundle_output: ${displayedBundleOutput}`);
        }
        console.log(
          JSON.stringify(
            {
              target,
              branch,
              engine: args.engine,
              changed_paths: [...paths].sort(),
              scope_baseline: baseline,
              bundle_bytes: bundleBytes,
              review_passes: prompts.length,
              prompt_bytes: prompts.map(utf8Size),
              bundle_output: displayedBundleOutput,
              bundle_outputs: bundleOutputs,
              behavior_validation_required: true,
              recommended_next_step:
                "Inside Codex, adapter-published bundles must follow their README: verify before review, retain the printed manifest digest, have one fresh-context read-only subagent inspect every listed bounded pass, then run the bound post-review check with that retained digest. Standalone-helper output may proceed directly to the reviewer. In either case, also run the separate quality, browser, runtime, or generated-artifact proof required by the change.",
            },
            null,
            2,
          ),
        );
        return 0;
      }
    }
  } finally {
    // Record the span even when bundle prep throws -- e.g. scopeBaseline or
    // bundle assembly failing -- so a failed run still reports where it spent
    // time. The top-level `.finally` flushes whatever spans were recorded.
    recordStageDuration("bundle-prep", bundlePrepStartedAt);
  }

  if (args.engine !== "local" && prompts.length > 1) {
    throw new Error(
      `semantic review requires ${prompts.length} bounded passes, but independent engine invocations cannot safely detect cross-pass defects; through a repo adapter, rerun with --prepare-bundle-dir <dir> and follow its bound pre/post verification flow; standalone-helper users should rerun with --prepare-only --bundle-output <path>; have one fresh-context reviewer inspect every listed pass`,
    );
  }

  let report;
  const engineStartedAt = Date.now();
  try {
    if (args.engine === "local") {
      assertReviewSourceState(
        repo,
        reviewSourceSnapshot,
        target,
        targetSelectionSourceSnapshot,
        guardTargetSelectionDuringReview,
        "source changed before local review; rerun autoreview against the updated tree",
      );
      report = runLocalReview(repo, target, paths);
      assertReviewSourceState(
        repo,
        reviewSourceSnapshot,
        target,
        targetSelectionSourceSnapshot,
        guardTargetSelectionDuringReview,
        "source changed during local review; rerun autoreview against the updated tree",
      );
    } else {
      assertReviewSourceState(
        repo,
        reviewSourceSnapshot,
        target,
        targetSelectionSourceSnapshot,
        guardTargetSelectionDuringReview,
        "source changed before semantic review; rerun autoreview against the updated tree",
      );
      const raw =
        args.engine === "codex"
          ? await runCodex(repo, args, prompts[0])
          : await runClaude(repo, args, prompts[0]);
      report = validateReport(extractReviewJson(raw), paths);
      assertReviewSourceState(
        repo,
        reviewSourceSnapshot,
        target,
        targetSelectionSourceSnapshot,
        guardTargetSelectionDuringReview,
        "source changed during semantic review; rerun autoreview against the updated tree",
      );
    }
  } finally {
    // Record the engine span even when the invocation throws -- a nonzero
    // engine exit, or a post-invocation source-state check failing -- so the
    // runs operators most need to profile still get an engine-invocation
    // duration. The top-level `.finally` flushes whatever spans were recorded.
    recordStageDuration("engine-invocation", engineStartedAt);
  }

  if (args.bundleOutput) {
    const displayedBundleOutput = args.bundleOutputDisplay || args.bundleOutput;
    writeReviewPromptOutputs(args.bundleOutput, prompts);
    console.log(`bundle_output: ${displayedBundleOutput}`);
  }

  if (args.jsonOutput) {
    writeFileSync(args.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  }
  const human = printReport(report);
  process.stdout.write(human);
  if (args.output) writeFileSync(args.output, human);

  if (
    process.exitCode ||
    report.findings.length > 0 ||
    report.overall_correctness === "patch is incorrect"
  ) {
    return 1;
  }
  return 0;
}

async function entrypoint() {
  return main();
}

entrypoint()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (!pendingTerminationSignal) {
      console.error(`autoreview failed: ${error.message}`);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    flushStageDurations();
    finishPendingProcessTermination();
  });
