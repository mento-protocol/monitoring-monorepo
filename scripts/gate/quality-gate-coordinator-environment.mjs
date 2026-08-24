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
import { delimiter, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export const LOCAL_BIN_MAX_ENTRIES = 8_192;
export const LOCAL_BIN_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const LOCAL_BIN_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const exactEnvironmentNames = new Set([
  "CC",
  "CFLAGS",
  "CGO_ENABLED",
  "CI",
  "CPPFLAGS",
  "CXX",
  "CXXFLAGS",
  "GOARCH",
  "GOENV",
  "GOFLAGS",
  "GOMAXPROCS",
  "GOOS",
  "GOPATH",
  "GOROOT",
  "GOTOOLCHAIN",
  "INIT_CWD",
  "LANG",
  "LC_ALL",
  "LDFLAGS",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "RUSTFLAGS",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "PLAYWRIGHT_BROWSERS_PATH",
  "TURBO_CACHE_DIR",
  "VERCEL_DEPLOYMENT_ID",
  "AGENT_GATE_FULL_TESTS",
  "AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES",
  "AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS",
  "AGENT_QUALITY_FAIL_FAST",
  "AGENT_QUALITY_PARALLELISM",
]);
const environmentPrefixes = [
  "AUTH_",
  "CARGO_",
  "ENVIO_",
  "FOUNDRY_",
  "NEXT_",
  "NEXT_PUBLIC_",
  "NPM_CONFIG_",
  "PLAYWRIGHT_",
  "PNPM_",
  "REACT_DOCTOR_",
  "RUST_",
  "SENTRY_",
  "SOLC_",
  "TF_",
  "TURBO_",
  "VERCEL_",
  "VITEST_",
  "npm_config_",
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

function readBoundedRegularFile(path, expected, { maxFileBytes, noFollow }) {
  const noFollowFlag = noFollow ? (constants.O_NOFOLLOW ?? 0) : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameIdentity(before, expected)) {
      throw manifestError("local executable changed before it was read");
    }
    if (before.size > BigInt(maxFileBytes)) {
      throw manifestError("local executable exceeds the per-file size limit");
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
        throw manifestError(
          "local executable became shorter while it was read",
        );
      }
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw manifestError("local executable became longer while it was read");
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, after)) {
      throw manifestError("local executable changed while it was read");
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
    if (error?.code === "ENOENT") return "missing";
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
  return hash.digest("hex");
}

function normalizedLocalBinManifestWithLimits(repoRoot, limits) {
  const physicalRepoRoot = realpathSync(repoRoot);
  const localBinPath = join(physicalRepoRoot, "node_modules", ".bin");
  const first = localBinSnapshot(localBinPath, physicalRepoRoot, limits);
  const second = localBinSnapshot(localBinPath, physicalRepoRoot, limits);
  if (first !== second) {
    throw manifestError("local executable manifest changed between snapshots");
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

function selectedEnvironmentEntries(environment) {
  return Object.entries(environment).filter(
    ([name]) =>
      exactEnvironmentNames.has(name) ||
      environmentPrefixes.some((prefix) => name.startsWith(prefix)),
  );
}

export function materialEnvironmentDigest({
  environment = process.env,
  repoRoot,
  workingDirectory = process.cwd(),
}) {
  const physicalRepoRoot = realpathSync(repoRoot);
  const localBinPath = join(physicalRepoRoot, "node_modules", ".bin");
  const localBinEntry = `${worktreeToken}/node_modules/.bin`;
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
              pathResolvesTo(entry, localBinPath, workingDirectory)
                ? localBinEntry
                : entry,
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
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash("sha256");
  hash.update("material-environment-v3\0");
  for (const [name, value] of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function main() {
  if (process.argv.length !== 3) {
    process.stderr.write(
      "error: material environment hashing requires one repository root.\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(
      materialEnvironmentDigest({ repoRoot: process.argv[2] }),
    );
  } catch (error) {
    process.stderr.write(
      `error: cannot hash the material environment: ${error.message}\n`,
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
