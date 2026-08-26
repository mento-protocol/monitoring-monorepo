import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export const LOCAL_BIN_MAX_ENTRIES = 8_192;
export const LOCAL_BIN_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const LOCAL_BIN_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const ENV_FILE_MAX_BYTES = 1024 * 1024;
const ENV_FILE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const ENV_FILE_MAX_NAMES_PER_ROOT = 128;

const exactEnvironmentNames = new Set([
  "ALL_PROXY",
  "BROWSERSLIST",
  "CC",
  "CFLAGS",
  "CGO_ENABLED",
  "CI",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CPPFLAGS",
  "CURL_CA_BUNDLE",
  "CXX",
  "CXXFLAGS",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ESLINT_USE_FLAT_CONFIG",
  "GLIBC_TUNABLES",
  "GOARCH",
  "GOENV",
  "GOFLAGS",
  "GOMAXPROCS",
  "GOOS",
  "GOPATH",
  "GOROOT",
  "GOTOOLCHAIN",
  "GITHUB_ACTIONS",
  "GITHUB_BASE_REF",
  "GITHUB_EVENT_BEFORE",
  "GITHUB_EVENT_NAME",
  "GITHUB_REPOSITORY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "HASURA_URL",
  "HOME",
  "INDEXER_PERF",
  "INDEXER_PERF_LOG_INTERVAL_EVENTS",
  "INIT_CWD",
  "LANG",
  "LC_ALL",
  "LDFLAGS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "METADATA_SERVER_DETECTION",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_PROXY",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "PATH",
  "PEG_POLICY_AUTH_MODE",
  "PEG_POLICY_BASE_REF",
  "PEG_POLICY_URL",
  "POLL_INTERVAL_MS",
  "PORT",
  "REQUESTS_CA_BUNDLE",
  "RESERVE_YIELD_EVENT_TESTS",
  "RUSTFLAGS",
  "SOURCE_DATE_EPOCH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "PLAYWRIGHT_BROWSERS_PATH",
  "TURBO_CACHE_DIR",
  "VERCEL",
  "VERCEL_DEPLOYMENT_ID",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "AGENT_GATE_FULL_TESTS",
  "AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES",
  "AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS",
  "AGENT_QUALITY_FAIL_FAST",
  "AGENT_QUALITY_PARALLELISM",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);
const environmentPrefixes = [
  "AGENT_AUTOREVIEW_",
  "AGENT_QUALITY_GATE_LOCK_TEST_",
  "AGENT_QUALITY_GATE_TEST_",
  "AUTH_",
  "AUTOREVIEW_",
  "BROWSERSLIST_",
  "CARGO_",
  "COREPACK_",
  "DOCS_NAVIGATION_EVAL_",
  "ENVIO_",
  "ESBUILD_",
  "FOUNDRY_",
  "HASURA_FIXTURE_",
  "DYLD_",
  "LD_",
  "NEXT_",
  "NEXT_PUBLIC_",
  "NPM_CONFIG_",
  "PLAYWRIGHT_",
  "PNPM_",
  "REACT_DOCTOR_",
  "REBALANCE_PROBE_",
  "RUST_",
  "SENTRY_",
  "SOLC_",
  "STRYKER_",
  "TF_",
  "TRUNK_",
  "TURBO_",
  "VERCEL_",
  "VITEST_",
  "npm_config_",
];
const mappedChildScrubbedExactNames = new Set([
  "AGENT_CONTEXT_CLAUDE_SETTINGS_FILE",
  "AGENT_CONTEXT_CODEX_HOOKS_FILE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "CURL_FLAGS",
  "ESLINT_BASELINE_INPUT",
  "ESLINT_BASELINE_MAIN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "SENTRY_SUITE_GATE_ROOT",
  "TRUNK_LAUNCHER_DEBUG",
  "TRUNK_LAUNCHER_PATH",
  "TRUNK_LAUNCHER_QUIET",
  "TRUNK_LAUNCHER_VERSION",
  "TRUNK_QUIET",
  "WGET_FLAGS",
]);
const parentMaterialMappedChildScrubbedExactNames = new Set([
  "AGENT_QUALITY_GATE_LOCK_CLAIM_DELAY_SECONDS",
  "AGENT_QUALITY_GATE_LOCK_CRASH_AT",
  "AGENT_QUALITY_GATE_LOCK_DISCARD_DELAY_SECONDS",
  "AGENT_QUALITY_GATE_LOCK_DRAIN_UNLINK_DELAY_SECONDS",
  "AGENT_QUALITY_GATE_LOCK_HELD_DELAY_SECONDS",
  "AGENT_QUALITY_GATE_LOCK_PROBE_PATH",
  "AGENT_QUALITY_GATE_LOCK_RECLAIM_DELAY_SECONDS",
  "AGENT_QUALITY_GATE_LOCK_RELEASE_AFTER_TAKE_DELAY_SECONDS",
  "AGENT_QUALITY_GATE_LOCK_RELEASE_BEFORE_TAKE_DELAY_SECONDS",
  "AGENT_QUALITY_GATE_LOCK_TAKEN_DELAY_SECONDS",
]);
const fingerprintExcludedScrubbedPrefixes = [
  "ALERT_RULES_LINT_",
  "AUTOREVIEW_FAKE_",
  "AUTOREVIEW_TEST_",
  "GATE_TEST_",
  "GIT_",
  "GITHUB_ACTION_PINS_",
  "LOCKFILE_LINT_",
  "SKEW_CHECK_",
  "SKILLS_MIRROR_ROOT_",
];
const mappedChildScrubbedPrefixes = [
  "AGENT_QUALITY_GATE_LOCK_TEST_",
  "AGENT_QUALITY_GATE_TEST_",
  ...fingerprintExcludedScrubbedPrefixes,
];
const stableFields = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "size",
  "mtimeNs",
  "ctimeNs",
];
const worktreeToken = "<WORKTREE_ROOT>";
const gateScratchRelativePath = join(".tmp", "agent-quality-gate");
export const MATERIAL_PACKAGE_ROOTS = Object.freeze([
  "",
  "aegis",
  join("alerts", "infra", "oncall-announcer"),
  join("alerts", "infra", "onchain-event-handler"),
  join("alerts", "infra", "sentry-ingest-watcher"),
  "governance-watchdog",
  "indexer-envio",
  "integration-probes",
  "metrics-bridge",
  "shared-config",
  "ui-dashboard",
]);
const productionLocalBinLimits = Object.freeze({
  maxEntries: LOCAL_BIN_MAX_ENTRIES,
  maxFileBytes: LOCAL_BIN_MAX_FILE_BYTES,
  maxTotalBytes: LOCAL_BIN_MAX_TOTAL_BYTES,
});

function manifestError(message) {
  const error = new Error(message);
  error.code = "LOCAL_BIN_MANIFEST_INVALID";
  return error;
}

function environmentError(message) {
  const error = new Error(message);
  error.code = "MATERIAL_ENVIRONMENT_INVALID";
  return error;
}

function boundedSnapshotError(subject, message) {
  return subject === "local executable"
    ? manifestError(`${subject} ${message}`)
    : environmentError(`${subject} ${message}`);
}

function sameIdentity(left, right) {
  return stableFields.every((field) => left[field] === right[field]);
}

function entryType(metadata) {
  if (metadata.isFile()) return "file";
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isDirectory()) return "directory";
  if (metadata.isBlockDevice()) return "block";
  if (metadata.isCharacterDevice()) return "character";
  if (metadata.isFIFO()) return "fifo";
  if (metadata.isSocket()) return "socket";
  return "unknown";
}

function boundedSortedNames(path, maxEntries) {
  const directory = opendirSync(path);
  const names = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > maxEntries) {
        throw manifestError(
          "local executable manifest exceeds its entry limit",
        );
      }
    }
  } finally {
    directory.closeSync();
  }
  return names.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

function normalizeRootPathText(path, physicalRepoRoot) {
  if (normalize(path) !== path) return path;
  if (path === physicalRepoRoot) return worktreeToken;
  if (!path.startsWith(`${physicalRepoRoot}/`)) return path;
  return `${worktreeToken}${path.slice(physicalRepoRoot.length)}`;
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function exactUtf8Text(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return Buffer.from(text).equals(bytes) ? text : null;
}

function normalizePnpmShellShim(bytes, physicalRepoRoot) {
  const shebang = Buffer.from("#!/bin/sh");
  if (!bytes.subarray(0, shebang.length).equals(shebang)) return bytes;
  const firstLineEnding = bytes.subarray(shebang.length, shebang.length + 2);
  if (
    firstLineEnding[0] !== 10 &&
    !firstLineEnding.equals(Buffer.from("\r\n"))
  ) {
    return bytes;
  }

  const text = exactUtf8Text(bytes);
  if (text === null) return bytes;

  const marker = "# cmd-shim-target=";
  if (countOccurrences(text, marker) !== 1) return bytes;
  const sentinelPattern = /^# cmd-shim-target=([^\r\n]+)(?=\r?$)/mu;
  if (!sentinelPattern.test(text)) return bytes;

  let normalized = text.replace(
    sentinelPattern,
    (_line, target) =>
      `${marker}${normalizeRootPathText(target, physicalRepoRoot)}`,
  );
  normalized = normalized.replace(
    /^ {2}export NODE_PATH="([^"\r\n]*)"(?=\r?$)/gmu,
    (_line, value) =>
      `  export NODE_PATH="${value
        .split(":")
        .map((segment) => normalizeRootPathText(segment, physicalRepoRoot))
        .join(":")}"`,
  );
  return normalized === text ? bytes : Buffer.from(normalized);
}

function normalizeLinkPath(linkBytes, physicalRepoRoot) {
  const link = exactUtf8Text(linkBytes);
  if (link === null) return linkBytes;
  const normalized = normalizeRootPathText(link, physicalRepoRoot);
  return normalized === link ? linkBytes : Buffer.from(normalized);
}

function updateField(hash, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(name);
  hash.update("\0");
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
}

function declaredEntryByteCount(
  name,
  linkBytes,
  wrapperSize,
  remainingBytes,
  limits,
) {
  if (wrapperSize > BigInt(limits.maxFileBytes)) {
    throw manifestError("local executable exceeds the per-file size limit");
  }
  const declaredBytes =
    BigInt(Buffer.byteLength(name) + linkBytes.length) + wrapperSize;
  if (declaredBytes > BigInt(remainingBytes)) {
    throw manifestError("local executable manifest exceeds its byte limit");
  }
  return Number(declaredBytes);
}

function readBoundedRegularFile(
  path,
  expected,
  { maxFileBytes, noFollow, subject = "local executable" },
) {
  const noFollowFlag = noFollow ? (constants.O_NOFOLLOW ?? 0) : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameIdentity(before, expected)) {
      throw boundedSnapshotError(subject, "changed before it was read");
    }
    if (before.size > BigInt(maxFileBytes)) {
      throw boundedSnapshotError(subject, "exceeds the per-file size limit");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) {
        throw boundedSnapshotError(subject, "became shorter while it was read");
      }
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw boundedSnapshotError(subject, "became longer while it was read");
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, after)) {
      throw boundedSnapshotError(subject, "changed while it was read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function snapshotEntry(
  localBinPath,
  name,
  physicalRepoRoot,
  remainingBytes,
  limits,
) {
  const path = join(localBinPath, name);
  const before = lstatSync(path, { bigint: true });
  const type = entryType(before);
  let linkBytes = Buffer.alloc(0);
  let targetMode = "";
  let byteCount;
  let wrapperBytes;
  if (type === "file") {
    byteCount = declaredEntryByteCount(
      name,
      linkBytes,
      before.size,
      remainingBytes,
      limits,
    );
    wrapperBytes = readBoundedRegularFile(path, before, {
      maxFileBytes: limits.maxFileBytes,
      noFollow: true,
    });
  } else if (type === "symlink") {
    linkBytes = readlinkSync(path, { encoding: "buffer" });
    const targetBefore = statSync(path, { bigint: true });
    if (!targetBefore.isFile()) {
      throw manifestError(
        "local executable symlink does not resolve to a file",
      );
    }
    targetMode = targetBefore.mode.toString(8);
    byteCount = declaredEntryByteCount(
      name,
      linkBytes,
      targetBefore.size,
      remainingBytes,
      limits,
    );
    wrapperBytes = readBoundedRegularFile(path, targetBefore, {
      maxFileBytes: limits.maxFileBytes,
      noFollow: false,
    });
    const targetAfter = statSync(path, { bigint: true });
    if (!sameIdentity(targetBefore, targetAfter)) {
      throw manifestError("local executable symlink target changed while read");
    }
    const finalLinkBytes = readlinkSync(path, { encoding: "buffer" });
    if (!linkBytes.equals(finalLinkBytes)) {
      throw manifestError("local executable symlink changed while it was read");
    }
  } else {
    throw manifestError(`unsupported local executable entry type: ${type}`);
  }
  const after = lstatSync(path, { bigint: true });
  if (!sameIdentity(before, after)) {
    throw manifestError("local executable entry changed while it was hashed");
  }
  const hash = createHash("sha256");
  hash.update("local-bin-entry-v2\0");
  updateField(hash, "name", name);
  updateField(hash, "type", type);
  updateField(hash, "mode", before.mode.toString(8));
  updateField(hash, "link", normalizeLinkPath(linkBytes, physicalRepoRoot));
  updateField(hash, "target-type", type === "symlink" ? "file" : "");
  updateField(hash, "target-mode", targetMode);
  updateField(
    hash,
    "wrapper",
    normalizePnpmShellShim(wrapperBytes, physicalRepoRoot),
  );
  return {
    byteCount,
    digest: hash.digest("hex"),
  };
}

function localBinSnapshot(localBinPath, physicalRepoRoot, limits) {
  let rootBefore;
  try {
    rootBefore = lstatSync(localBinPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { byteCount: 0, digest: "missing", entryCount: 0 };
    }
    throw error;
  }
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw manifestError("local executable root must be a real directory");
  }
  const names = boundedSortedNames(localBinPath, limits.maxEntries);
  const entries = [];
  let totalBytes = 0;
  for (const name of names) {
    const entry = snapshotEntry(
      localBinPath,
      name,
      physicalRepoRoot,
      limits.maxTotalBytes - totalBytes,
      limits,
    );
    totalBytes += entry.byteCount;
    entries.push(entry.digest);
  }
  const finalNames = boundedSortedNames(localBinPath, limits.maxEntries);
  const rootAfter = lstatSync(localBinPath, { bigint: true });
  if (
    names.length !== finalNames.length ||
    names.some((name, index) => name !== finalNames[index]) ||
    !sameIdentity(rootBefore, rootAfter)
  ) {
    throw manifestError(
      "local executable directory changed while it was hashed",
    );
  }
  const hash = createHash("sha256");
  hash.update("local-bin-v2\0");
  updateField(hash, "root-type", "directory");
  updateField(hash, "root-mode", rootBefore.mode.toString(8));
  for (const digest of entries) updateField(hash, "entry", digest);
  return {
    byteCount: totalBytes,
    digest: hash.digest("hex"),
    entryCount: names.length,
  };
}

function localBinRootsSnapshot(physicalRepoRoot, limits) {
  const hash = createHash("sha256");
  hash.update("local-bin-roots-v1\0");
  let totalBytes = 0;
  let totalEntries = 0;
  for (const relativeRoot of MATERIAL_PACKAGE_ROOTS) {
    const snapshot = localBinSnapshot(
      join(physicalRepoRoot, relativeRoot, "node_modules", ".bin"),
      physicalRepoRoot,
      {
        ...limits,
        maxEntries: limits.maxEntries - totalEntries,
        maxTotalBytes: limits.maxTotalBytes - totalBytes,
      },
    );
    totalBytes += snapshot.byteCount;
    totalEntries += snapshot.entryCount;
    updateField(hash, "root", relativeRoot || ".");
    updateField(hash, "manifest", snapshot.digest);
  }
  return hash.digest("hex");
}

function normalizedLocalBinManifestWithLimits(repoRoot, limits) {
  const physicalRepoRoot = realpathSync(repoRoot);
  const first = localBinRootsSnapshot(physicalRepoRoot, limits);
  const second = localBinRootsSnapshot(physicalRepoRoot, limits);
  if (first !== second) {
    throw manifestError("local executable manifests changed between snapshots");
  }
  return second;
}

function localBinLimits(overrides) {
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(productionLocalBinLimits, name)) {
      throw new TypeError(`unknown local executable limit: ${name}`);
    }
  }
  const limits = { ...productionLocalBinLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return Object.freeze(limits);
}

export function normalizedLocalBinManifest(repoRoot) {
  return normalizedLocalBinManifestWithLimits(
    repoRoot,
    productionLocalBinLimits,
  );
}

export function normalizedLocalBinManifestForTest(repoRoot, overrides) {
  return normalizedLocalBinManifestWithLimits(
    repoRoot,
    localBinLimits(overrides),
  );
}

function environmentFileName(name) {
  return (
    (name === ".env" || name.startsWith(".env.")) && !name.endsWith(".example")
  );
}

function environmentNamesInRoot(path, relativeRoot) {
  let rootBefore;
  try {
    rootBefore = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return { identity: null, names: [] };
    throw error;
  }
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw environmentError(
      `material environment root is not a real directory: ${relativeRoot || "."}`,
    );
  }
  const names = boundedSortedNames(path, LOCAL_BIN_MAX_ENTRIES).filter(
    environmentFileName,
  );
  if (names.length > ENV_FILE_MAX_NAMES_PER_ROOT) {
    throw environmentError(
      `material environment root has too many env files: ${relativeRoot || "."}`,
    );
  }
  return { identity: rootBefore, names };
}

function snapshotEnvironmentFile(path, relativePath, remainingBytes) {
  const subject = `material environment file ${relativePath}`;
  const before = lstatSync(path, { bigint: true });
  const type = entryType(before);
  let linkBytes = Buffer.alloc(0);
  let targetMode = "";
  let content;
  let contentSize;
  if (type === "file") {
    contentSize = before.size;
    content = readBoundedRegularFile(path, before, {
      maxFileBytes: Math.min(ENV_FILE_MAX_BYTES, remainingBytes),
      noFollow: true,
      subject,
    });
  } else if (type === "symlink") {
    linkBytes = readlinkSync(path, { encoding: "buffer" });
    const targetBefore = statSync(path, { bigint: true });
    if (!targetBefore.isFile()) {
      throw environmentError(`${subject} does not resolve to a regular file`);
    }
    targetMode = targetBefore.mode.toString(8);
    contentSize = targetBefore.size;
    content = readBoundedRegularFile(path, targetBefore, {
      maxFileBytes: Math.min(ENV_FILE_MAX_BYTES, remainingBytes),
      noFollow: false,
      subject,
    });
    const targetAfter = statSync(path, { bigint: true });
    if (!sameIdentity(targetBefore, targetAfter)) {
      throw environmentError(`${subject} target changed while it was hashed`);
    }
    if (!linkBytes.equals(readlinkSync(path, { encoding: "buffer" }))) {
      throw environmentError(`${subject} link changed while it was hashed`);
    }
  } else {
    throw environmentError(`${subject} is not a regular file or symlink`);
  }
  if (contentSize > BigInt(remainingBytes)) {
    throw environmentError(
      "material environment files exceed their byte limit",
    );
  }
  const after = lstatSync(path, { bigint: true });
  if (!sameIdentity(before, after)) {
    throw environmentError(`${subject} changed while it was hashed`);
  }
  const hash = createHash("sha256");
  hash.update("material-environment-file-v1\0");
  updateField(hash, "path", relativePath);
  updateField(hash, "type", type);
  updateField(hash, "mode", before.mode.toString(8));
  updateField(hash, "link", linkBytes);
  updateField(hash, "target-mode", targetMode);
  updateField(hash, "content", content);
  return { byteCount: Number(contentSize), digest: hash.digest("hex") };
}

function materialEnvironmentFileSnapshot(physicalRepoRoot) {
  const hash = createHash("sha256");
  hash.update("material-environment-files-v1\0");
  let totalBytes = 0;
  for (const relativeRoot of MATERIAL_PACKAGE_ROOTS) {
    const root = join(physicalRepoRoot, relativeRoot);
    const before = environmentNamesInRoot(root, relativeRoot);
    updateField(hash, "root", relativeRoot || ".");
    for (const name of before.names) {
      const relativePath = join(relativeRoot, name);
      const snapshot = snapshotEnvironmentFile(
        join(root, name),
        relativePath,
        ENV_FILE_MAX_TOTAL_BYTES - totalBytes,
      );
      totalBytes += snapshot.byteCount;
      updateField(hash, "file", snapshot.digest);
    }
    const after = environmentNamesInRoot(root, relativeRoot);
    if (
      (before.identity === null) !== (after.identity === null) ||
      (before.identity !== null &&
        !sameIdentity(before.identity, after.identity)) ||
      before.names.length !== after.names.length ||
      before.names.some((name, index) => name !== after.names[index])
    ) {
      throw environmentError(
        `material environment root changed while it was hashed: ${relativeRoot || "."}`,
      );
    }
  }
  return hash.digest("hex");
}

function materialEnvironmentFileManifest(physicalRepoRoot) {
  const first = materialEnvironmentFileSnapshot(physicalRepoRoot);
  const second = materialEnvironmentFileSnapshot(physicalRepoRoot);
  if (first !== second) {
    throw environmentError(
      "material environment files changed between snapshots",
    );
  }
  return second;
}

function pathResolvesTo(value, expected, workingDirectory) {
  if (typeof value !== "string" || value.length === 0) return false;
  const candidate = resolve(workingDirectory, value);
  const target = resolve(expected);
  if (candidate === target) return true;
  try {
    return realpathSync(candidate) === realpathSync(target);
  } catch {
    return false;
  }
}

function materialLocalBinPathMap(physicalRepoRoot) {
  return MATERIAL_PACKAGE_ROOTS.map((relativeRoot) => ({
    path: join(physicalRepoRoot, relativeRoot, "node_modules", ".bin"),
    replacement: join(worktreeToken, relativeRoot, "node_modules", ".bin"),
  }));
}

function normalizeMaterialLocalBinPath(value, paths, workingDirectory) {
  for (const entry of paths) {
    if (pathResolvesTo(value, entry.path, workingDirectory)) {
      return entry.replacement;
    }
  }
  if (typeof value === "string" && !isAbsolute(value)) {
    return resolve(workingDirectory, value || ".");
  }
  return value;
}

function selectedEnvironmentEntries(environment) {
  return Object.entries(environment).filter(
    ([name]) =>
      !mappedChildScrubbedExactNames.has(name) &&
      !fingerprintExcludedScrubbedPrefixes.some((prefix) =>
        name.startsWith(prefix),
      ) &&
      (exactEnvironmentNames.has(name) ||
        parentMaterialMappedChildScrubbedExactNames.has(name) ||
        environmentPrefixes.some((prefix) => name.startsWith(prefix))),
  );
}

export function mappedChildScrubbedEnvironmentName(name) {
  return (
    mappedChildScrubbedExactNames.has(name) ||
    parentMaterialMappedChildScrubbedExactNames.has(name) ||
    mappedChildScrubbedPrefixes.some((prefix) => name.startsWith(prefix))
  );
}

export function mappedChildScrubPolicyDigest() {
  const hash = createHash("sha256");
  hash.update("mapped-child-scrub-policy-v1\0");
  for (const name of [...mappedChildScrubbedExactNames].sort()) {
    updateField(hash, "exact", name);
  }
  for (const name of [...parentMaterialMappedChildScrubbedExactNames].sort()) {
    updateField(hash, "parent-material-exact", name);
  }
  for (const prefix of [...mappedChildScrubbedPrefixes].sort()) {
    updateField(hash, "prefix", prefix);
  }
  return hash.digest("hex");
}

export function materialEnvironmentDigest({
  environment = process.env,
  repoRoot,
  workingDirectory = process.cwd(),
}) {
  const physicalRepoRoot = realpathSync(repoRoot);
  const physicalWorkingDirectory = realpathSync(workingDirectory);
  const localBinPaths = materialLocalBinPathMap(physicalRepoRoot);
  const gateScratchPath = join(physicalRepoRoot, gateScratchRelativePath);
  const gateScratchEntry = `${worktreeToken}/${gateScratchRelativePath}`;
  const entries = selectedEnvironmentEntries(environment).map(
    ([name, rawValue]) => {
      const value = rawValue ?? "";
      if (name === "PATH") {
        return [
          name,
          value
            .split(delimiter)
            .map((entry) =>
              normalizeMaterialLocalBinPath(
                entry,
                localBinPaths,
                physicalWorkingDirectory,
              ),
            )
            .join(delimiter),
        ];
      }
      if (
        (name === "INIT_CWD" || name === "PNPM_SCRIPT_SRC_DIR") &&
        pathResolvesTo(value, physicalRepoRoot, workingDirectory)
      ) {
        return [name, worktreeToken];
      }
      if (
        (name === "TMPDIR" || name === "TMP" || name === "TEMP") &&
        pathResolvesTo(value, gateScratchPath, workingDirectory)
      ) {
        return [name, gateScratchEntry];
      }
      return [name, value];
    },
  );
  entries.push([
    "__AGENT_QUALITY_GATE_LOCAL_BIN_MANIFEST__",
    normalizedLocalBinManifest(physicalRepoRoot),
  ]);
  entries.push([
    "__AGENT_QUALITY_GATE_ENV_FILE_MANIFEST__",
    materialEnvironmentFileManifest(physicalRepoRoot),
  ]);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash("sha256");
  hash.update("material-environment-v5\0");
  for (const [name, value] of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function main() {
  if (
    process.argv.length === 3 &&
    process.argv[2] === "--mapped-child-scrub-policy-digest"
  ) {
    process.stdout.write(mappedChildScrubPolicyDigest());
    return;
  }
  if (
    process.argv.length === 3 &&
    process.argv[2] === "--mapped-child-scrubbed-names"
  ) {
    for (const name of Object.keys(process.env)
      .filter(mappedChildScrubbedEnvironmentName)
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      )) {
      process.stdout.write(`${name}\0`);
    }
    process.stdout.write(
      `agent-quality-gate-scrub-policy=${mappedChildScrubPolicyDigest()}\0`,
    );
    process.stdout.write("agent-quality-gate-scrub-end\0");
    return;
  }
  let repoRoot;
  if (process.argv.length === 3) {
    repoRoot = process.argv[2];
  } else {
    process.stderr.write(
      "error: material environment hashing requires one repository root.\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(materialEnvironmentDigest({ repoRoot }));
  } catch (error) {
    process.stderr.write(
      `error: cannot hash the material environment: ${error.message}\n`,
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  pathResolvesTo(process.argv[1], fileURLToPath(import.meta.url), process.cwd())
) {
  main();
}
