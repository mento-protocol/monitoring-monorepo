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
import {
  delimiter,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export const LOCAL_BIN_MAX_ENTRIES = 8_192;
export const LOCAL_BIN_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const LOCAL_BIN_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const INSTALLED_DEPENDENCY_MAX_ENTRIES = 16_384;
export const INSTALLED_DEPENDENCY_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const INSTALLED_DEPENDENCY_MAX_PAYLOAD_FILE_BYTES = 512 * 1024;
export const INSTALLED_DEPENDENCY_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const ENV_FILE_MAX_BYTES = 1024 * 1024;
const ENV_FILE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const ENV_FILE_MAX_NAMES_PER_ROOT = 128;

const exactEnvironmentNames = new Set([
  "ALL_PROXY",
  "APPDATA",
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
  "NODE_ICU_DATA",
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
  "TERRAFORM_CONFIG",
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
export const MATERIAL_SINGLE_PATH_ENVIRONMENT_NAMES = Object.freeze([
  "AGENT_AUTOREVIEW_DURATIONS_DIR",
  "AGENT_AUTOREVIEW_MANIFEST_COUNTER_FILE",
  "APPDATA",
  "AUTOREVIEW_CAPTURE",
  "AUTOREVIEW_HELPER",
  "AUTOREVIEW_MUTATE_PATH",
  "AUTOREVIEW_PROGRESS_MARKER",
  "AUTOREVIEW_SNAPSHOT_HELPER",
  "BROWSERSLIST_CONFIG",
  "BROWSERSLIST_ROOT_PATH",
  "BROWSERSLIST_STATS",
  "CARGO_BUILD_DEP_INFO_BASEDIR",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTDOC",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_HOME",
  "CARGO_HTTP_CAINFO",
  "CARGO_INSTALL_ROOT",
  "CARGO_TARGET_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COREPACK_ENV_FILE",
  "COREPACK_HOME",
  "CURL_CA_BUNDLE",
  "DOCS_NAVIGATION_EVAL_REPO",
  "DYLD_PRINT_TO_FILE",
  "DYLD_SHARED_CACHE_DIR",
  "ENVIO_LOG_ARGS_FILE",
  "ESBUILD_BINARY_PATH",
  "FOUNDRY_BROADCAST",
  "FOUNDRY_BUILD_INFO_PATH",
  "FOUNDRY_CACHE_PATH",
  "FOUNDRY_CONFIG",
  "FOUNDRY_DOC_BOOK",
  "FOUNDRY_DOC_HOMEPAGE",
  "FOUNDRY_DOC_OUT",
  "FOUNDRY_ETH_RPC_JWT",
  "FOUNDRY_FUZZ_CORPUS_DIR",
  "FOUNDRY_FUZZ_FAILURE_PERSIST_DIR",
  "FOUNDRY_INVARIANT_CORPUS_DIR",
  "FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR",
  "FOUNDRY_MATCH_PATH",
  "FOUNDRY_NO_MATCH_PATH",
  "FOUNDRY_OUT",
  "FOUNDRY_SCRIPT",
  "FOUNDRY_SNAPSHOTS",
  "FOUNDRY_SRC",
  "FOUNDRY_TEST",
  "FOUNDRY_TEST_FAILURES_FILE",
  "FOUNDRY_VYPER_PATH",
  "GOENV",
  "GOROOT",
  "HOME",
  "INIT_CWD",
  "LD_DEBUG_OUTPUT",
  "LD_ORIGIN_PATH",
  "LD_PROFILE",
  "LD_PROFILE_OUTPUT",
  "NEXT_ADAPTER_PATH",
  "NEXT_CACHE_HANDLER_PATH",
  "NEXT_CPU_PROF_DIR",
  "NEXT_DEFAULT_CACHE_HANDLER_PATH",
  "NEXT_DIST_DIR",
  "NEXT_FONT_GOOGLE_MOCKED_RESPONSES",
  "NEXT_PRIVATE_DEV_DIR",
  "NEXT_PRIVATE_OUTPUT_TRACE_ROOT",
  "NEXT_REMOTE_CACHE_HANDLER_PATH",
  "NEXT_STATIC_CACHE_HANDLER_PATH",
  "NEXT_SWC_PATH",
  "NEXT_TEST_NATIVE_DIR",
  "NEXT_TEST_WASM_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NODE_ICU_DATA",
  "NPM_CONFIG_CACHE_DIR",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_CONFIG_DIR",
  "NPM_CONFIG_GLOBAL_BIN_DIR",
  "NPM_CONFIG_GLOBAL_DIR",
  "NPM_CONFIG_GLOBAL_PNPMFILE",
  "NPM_CONFIG_GLOBAL_VIRTUAL_STORE_DIR",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_HOOKS_DIR",
  "NPM_CONFIG_INIT_MODULE",
  "NPM_CONFIG_LOCKFILE_DIR",
  "NPM_CONFIG_LOCKFILE_DIRECTORY",
  "NPM_CONFIG_MODULES_DIR",
  "NPM_CONFIG_NODE_GYP",
  "NPM_CONFIG_PNPMFILE",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_SCRIPT_SHELL",
  "NPM_CONFIG_STATE_DIR",
  "NPM_CONFIG_STORE_DIR",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_VIRTUAL_STORE_DIR",
  "NPM_CONFIG_WORKSPACE_DIR",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_DAEMON_SESSION_DIR",
  "PLAYWRIGHT_FIREFOX_POLICIES_JSON",
  "PLAYWRIGHT_HTML_OUTPUT_DIR",
  "PLAYWRIGHT_HTML_REPORT",
  "PLAYWRIGHT_MCP_CONFIG",
  "PLAYWRIGHT_MCP_EXECUTABLE_PATH",
  "PLAYWRIGHT_MCP_INIT_PAGE",
  "PLAYWRIGHT_MCP_INIT_SCRIPT",
  "PLAYWRIGHT_MCP_OUTPUT_DIR",
  "PLAYWRIGHT_MCP_SECRETS_FILE",
  "PLAYWRIGHT_MCP_STORAGE_STATE",
  "PLAYWRIGHT_MCP_USER_DATA_DIR",
  "PLAYWRIGHT_SERVER_REGISTRY",
  "PLAYWRIGHT_SOCKETS_DIR",
  "PLAYWRIGHT_STUB_LOG",
  "PNPM_ARGS_FILE",
  "PNPM_HOME",
  "PNPM_SCRIPT_SRC_DIR",
  "REQUESTS_CA_BUNDLE",
  "SENTRY_BINARY_PATH",
  "SENTRY_MCP_BROKER_READY_FILE",
  "SENTRY_PROPERTIES",
  "SSL_CERT_FILE",
  "TEMP",
  "TERRAFORM_CONFIG",
  "TF_CLI_CONFIG_FILE",
  "TF_DATA_DIR",
  "TF_LOG_PATH",
  "TF_LOG_SDK_PROTO_DATA_DIR",
  "TF_PLUGIN_CACHE_DIR",
  "TMP",
  "TMPDIR",
  "TRUNK_CACHE",
  "TRUNK_TMPDIR",
  "TURBO_BINARY_PATH",
  "TURBO_CACHE_DIR",
  "TURBO_CONFIG_DIR_PATH",
  "VERCEL_CONFIG_DIR_PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "npm_config_cache_dir",
  "npm_config_cafile",
  "npm_config_cache",
  "npm_config_config_dir",
  "npm_config_global_bin_dir",
  "npm_config_global_dir",
  "npm_config_global_pnpmfile",
  "npm_config_global_virtual_store_dir",
  "npm_config_globalconfig",
  "npm_config_hooks_dir",
  "npm_config_init_module",
  "npm_config_lockfile_dir",
  "npm_config_lockfile_directory",
  "npm_config_modules_dir",
  "npm_config_node_gyp",
  "npm_config_pnpmfile",
  "npm_config_prefix",
  "npm_config_script_shell",
  "npm_config_state_dir",
  "npm_config_store_dir",
  "npm_config_userconfig",
  "npm_config_virtual_store_dir",
  "npm_config_workspace_dir",
]);
export const MATERIAL_PATH_LIST_ENVIRONMENT_NAMES = Object.freeze([
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_ROOT_PATH",
  "DYLD_VERSIONED_FRAMEWORK_PATH",
  "DYLD_VERSIONED_LIBRARY_PATH",
  "GOPATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_RUN_PATH",
  "NODE_PATH",
  "PATH",
  "SSL_CERT_DIR",
]);
export const MATERIAL_JSON_PATH_LIST_ENVIRONMENT_NAMES = Object.freeze([
  "FOUNDRY_ALLOW_PATHS",
  "FOUNDRY_DOC_IGNORE",
  "FOUNDRY_FMT_IGNORE",
  "FOUNDRY_INCLUDE_PATHS",
  "FOUNDRY_LIBS",
  "FOUNDRY_LINT_IGNORE",
  "FOUNDRY_SKIP",
  "NEXT_PRIVATE_APP_PATHS",
  "NEXT_PRIVATE_PAGE_PATHS",
]);
export const MATERIAL_EMPTY_COMPONENT_CWD_PATH_LIST_ENVIRONMENT_NAMES =
  Object.freeze([
    "DYLD_FALLBACK_FRAMEWORK_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_ROOT_PATH",
    "DYLD_VERSIONED_FRAMEWORK_PATH",
    "DYLD_VERSIONED_LIBRARY_PATH",
    "LD_LIBRARY_PATH",
    "LD_RUN_PATH",
  ]);
export const MATERIAL_STRUCTURED_PATH_ENVIRONMENT_NAMES = Object.freeze([
  "FOUNDRY_FS_PERMISSIONS",
  "FOUNDRY_LIBRARIES",
  "FOUNDRY_REMAPPINGS",
]);
export const MATERIAL_FOUNDRY_SOLC_ENVIRONMENT_NAMES = Object.freeze([
  "FOUNDRY_SOLC",
  "FOUNDRY_SOLC_VERSION",
]);
export const MATERIAL_CWD_BOUND_ENVIRONMENT_NAMES = Object.freeze([
  "CC",
  "CFLAGS",
  "CPPFLAGS",
  "CXX",
  "CXXFLAGS",
  "FOUNDRY_IGNORED_ERROR_CODES_FROM",
  "FOUNDRY_IGNORED_WARNINGS_FROM",
  "GOFLAGS",
  "LDFLAGS",
  "NODE_OPTIONS",
  "PLAYWRIGHT_NEXT_COMMAND",
  "RUSTFLAGS",
  "VITEST_DEBUG_DUMP",
]);
const materialSinglePathEnvironmentNames = new Set(
  MATERIAL_SINGLE_PATH_ENVIRONMENT_NAMES,
);
const materialSinglePathEnvironmentNamePatterns = [
  /^AGENT_QUALITY_GATE_LOCK_TEST_(?:READY|RELEASE)_FILE$/u,
  /^AGENT_QUALITY_GATE_TEST_[A-Z0-9_]+_BARRIER$/u,
  /^CARGO_TARGET_[A-Z0-9_]+_(?:LINKER|RUNNER)$/u,
  /^TF_STACKS_TEST_[A-Z0-9_]+_LOG$/u,
];
const materialPathListEnvironmentNames = new Set(
  MATERIAL_PATH_LIST_ENVIRONMENT_NAMES,
);
const materialEmptyComponentCwdPathListEnvironmentNames = new Set(
  MATERIAL_EMPTY_COMPONENT_CWD_PATH_LIST_ENVIRONMENT_NAMES,
);
const materialJsonPathListEnvironmentNames = new Set(
  MATERIAL_JSON_PATH_LIST_ENVIRONMENT_NAMES,
);
const materialStructuredPathEnvironmentNames = new Set(
  MATERIAL_STRUCTURED_PATH_ENVIRONMENT_NAMES,
);
const materialFoundrySolcEnvironmentNames = new Set(
  MATERIAL_FOUNDRY_SOLC_ENVIRONMENT_NAMES,
);
const materialCwdBoundEnvironmentNames = new Set(
  MATERIAL_CWD_BOUND_ENVIRONMENT_NAMES,
);
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
const installedDependencyMetadata = Object.freeze([
  Object.freeze({
    relativePath: ".modules.yaml",
    ignoredRootFields: Object.freeze(["prunedAt"]),
    json: true,
  }),
  Object.freeze({
    relativePath: ".package-map.json",
    ignoredRootFields: Object.freeze([]),
    json: true,
  }),
  Object.freeze({
    relativePath: ".pnpm-workspace-state-v1.json",
    ignoredRootFields: Object.freeze(["lastValidatedTimestamp"]),
    json: true,
  }),
  Object.freeze({
    relativePath: join(".pnpm", "lock.yaml"),
    ignoredRootFields: Object.freeze([]),
    json: false,
  }),
]);
const productionInstalledDependencyLimits = Object.freeze({
  maxEntries: INSTALLED_DEPENDENCY_MAX_ENTRIES,
  maxFileBytes: INSTALLED_DEPENDENCY_MAX_FILE_BYTES,
  maxPayloadFileBytes: INSTALLED_DEPENDENCY_MAX_PAYLOAD_FILE_BYTES,
  maxTotalBytes: INSTALLED_DEPENDENCY_MAX_TOTAL_BYTES,
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

function installedDependencyError(message) {
  const error = new Error(message);
  error.code = "INSTALLED_DEPENDENCY_MANIFEST_INVALID";
  return error;
}

function boundedSnapshotError(subject, message) {
  if (subject === "local executable") {
    return manifestError(`${subject} ${message}`);
  }
  if (subject.startsWith("installed dependency")) {
    return installedDependencyError(`${subject} ${message}`);
  }
  return environmentError(`${subject} ${message}`);
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
  if (!path.startsWith(`${physicalRepoRoot}${sep}`)) return path;
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

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function canonicalInstalledJson(
  value,
  physicalRepoRoot,
  ignoredRootFields,
  depth = 0,
) {
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) =>
        canonicalInstalledJson(
          entry,
          physicalRepoRoot,
          ignoredRootFields,
          depth + 1,
        ),
      )
      .join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const normalizedEntries = Object.entries(value)
      .filter(([name]) => depth !== 0 || !ignoredRootFields.includes(name))
      .map(([name, entry]) => [
        normalizeRootPathText(name, physicalRepoRoot),
        canonicalInstalledJson(
          entry,
          physicalRepoRoot,
          ignoredRootFields,
          depth + 1,
        ),
      ])
      .sort(([left], [right]) => compareUtf8(left, right));
    for (let index = 1; index < normalizedEntries.length; index += 1) {
      if (normalizedEntries[index - 1][0] === normalizedEntries[index][0]) {
        throw installedDependencyError(
          "installed dependency metadata has duplicate normalized keys",
        );
      }
    }
    return `{${normalizedEntries
      .map(([name, entry]) => `${JSON.stringify(name)}:${entry}`)
      .join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(normalizeRootPathText(value, physicalRepoRoot));
  }
  return JSON.stringify(value);
}

function normalizedInstalledMetadataBytes(bytes, descriptor, physicalRepoRoot) {
  if (!descriptor.json) return bytes;
  const text = exactUtf8Text(bytes);
  if (text === null) {
    throw installedDependencyError(
      `installed dependency metadata is not UTF-8 JSON: ${descriptor.relativePath}`,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw installedDependencyError(
      `installed dependency metadata is not valid JSON: ${descriptor.relativePath}`,
    );
  }
  return Buffer.from(
    canonicalInstalledJson(
      value,
      physicalRepoRoot,
      descriptor.ignoredRootFields,
    ),
  );
}

function consumeInstalledDependencyBytes(budget, byteCount, limits) {
  if (byteCount > limits.maxTotalBytes - budget.bytes) {
    throw installedDependencyError(
      "installed dependency manifest exceeds its byte limit",
    );
  }
  budget.bytes += byteCount;
}

function consumeInstalledDependencyEntries(budget, count, limits) {
  budget.entries += count;
  if (budget.entries > limits.maxEntries) {
    throw installedDependencyError(
      "installed dependency manifest exceeds its entry limit",
    );
  }
}

function installedMetadataFileSnapshot(
  nodeModulesPath,
  descriptor,
  physicalRepoRoot,
  budget,
  limits,
) {
  consumeInstalledDependencyEntries(budget, 1, limits);
  const path = join(nodeModulesPath, descriptor.relativePath);
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw installedDependencyError(
        `installed dependency metadata is missing: ${descriptor.relativePath}`,
      );
    }
    throw error;
  }
  if (!before.isFile()) {
    throw installedDependencyError(
      `installed dependency metadata is not a regular file: ${descriptor.relativePath}`,
    );
  }
  if (before.size > BigInt(limits.maxFileBytes)) {
    throw installedDependencyError(
      `installed dependency metadata exceeds the per-file size limit: ${descriptor.relativePath}`,
    );
  }
  consumeInstalledDependencyBytes(budget, Number(before.size), limits);
  const bytes = readBoundedRegularFile(path, before, {
    maxFileBytes: limits.maxFileBytes,
    noFollow: true,
    subject: `installed dependency metadata ${descriptor.relativePath}`,
  });
  const hash = createHash("sha256");
  hash.update("installed-dependency-metadata-v1\0");
  updateField(hash, "path", descriptor.relativePath);
  updateField(hash, "mode", before.mode.toString(8));
  updateField(
    hash,
    "content",
    normalizedInstalledMetadataBytes(bytes, descriptor, physicalRepoRoot),
  );
  return hash.digest("hex");
}

function boundedInstalledDependencyNames(path, remainingEntries) {
  const directory = opendirSync(path);
  const names = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > remainingEntries) {
        throw installedDependencyError(
          "installed dependency manifest exceeds its entry limit",
        );
      }
    }
  } finally {
    directory.closeSync();
  }
  return names.sort(compareUtf8);
}

function installedDependencyPackageJsonSnapshot(
  packagePath,
  relativePath,
  physicalRepoRoot,
  budget,
  limits,
) {
  const path = join(packagePath, "package.json");
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw installedDependencyError(
        `installed dependency package manifest is missing: ${relativePath}`,
      );
    }
    throw error;
  }
  let linkBytes = Buffer.alloc(0);
  let targetMode = "";
  let content;
  let contentSize;
  if (before.isFile()) {
    contentSize = before.size;
    content = readBoundedRegularFile(path, before, {
      maxFileBytes: limits.maxFileBytes,
      noFollow: true,
      subject: `installed dependency package manifest ${relativePath}`,
    });
  } else if (before.isSymbolicLink()) {
    linkBytes = readlinkSync(path, { encoding: "buffer" });
    const targetBefore = statSync(path, { bigint: true });
    if (!targetBefore.isFile()) {
      throw installedDependencyError(
        `installed dependency package manifest does not resolve to a regular file: ${relativePath}`,
      );
    }
    targetMode = targetBefore.mode.toString(8);
    contentSize = targetBefore.size;
    content = readBoundedRegularFile(path, targetBefore, {
      maxFileBytes: limits.maxFileBytes,
      noFollow: false,
      subject: `installed dependency package manifest ${relativePath}`,
    });
    if (!sameIdentity(targetBefore, statSync(path, { bigint: true }))) {
      throw installedDependencyError(
        `installed dependency package manifest target changed while read: ${relativePath}`,
      );
    }
    if (!linkBytes.equals(readlinkSync(path, { encoding: "buffer" }))) {
      throw installedDependencyError(
        `installed dependency package manifest link changed while read: ${relativePath}`,
      );
    }
  } else {
    throw installedDependencyError(
      `installed dependency package manifest has an unsupported type: ${relativePath}`,
    );
  }
  if (contentSize > BigInt(limits.maxFileBytes)) {
    throw installedDependencyError(
      `installed dependency package manifest exceeds the per-file size limit: ${relativePath}`,
    );
  }
  consumeInstalledDependencyBytes(
    budget,
    Number(contentSize) + linkBytes.length,
    limits,
  );
  if (!sameIdentity(before, lstatSync(path, { bigint: true }))) {
    throw installedDependencyError(
      `installed dependency package manifest changed while read: ${relativePath}`,
    );
  }
  const hash = createHash("sha256");
  hash.update("installed-dependency-package-json-v1\0");
  updateField(hash, "type", entryType(before));
  updateField(hash, "mode", before.mode.toString(8));
  updateField(hash, "link", normalizeLinkPath(linkBytes, physicalRepoRoot));
  updateField(hash, "target-mode", targetMode);
  updateField(hash, "content", content);
  const manifestText = exactUtf8Text(content);
  if (manifestText === null) {
    throw installedDependencyError(
      `installed dependency package manifest is not UTF-8 JSON: ${relativePath}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw installedDependencyError(
      `installed dependency package manifest is not valid JSON: ${relativePath}`,
    );
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw installedDependencyError(
      `installed dependency package manifest is not a JSON object: ${relativePath}`,
    );
  }
  return { digest: hash.digest("hex"), manifest };
}

function installedDependencyPayloadTopologyEntrySnapshot(
  path,
  relativePath,
  physicalRepoRoot,
  budget,
  limits,
) {
  const before = lstatSync(path, { bigint: true });
  const hash = createHash("sha256");
  hash.update("installed-dependency-payload-entry-v1\0");
  updateField(hash, "path", relativePath);
  updateField(hash, "type", entryType(before));
  updateField(hash, "mode", before.mode.toString(8));

  if (before.isFile()) {
    updateField(hash, "size", before.size.toString());
  } else if (before.isSymbolicLink()) {
    const linkBytes = readlinkSync(path, { encoding: "buffer" });
    consumeInstalledDependencyBytes(budget, linkBytes.length, limits);
    updateField(hash, "link", normalizeLinkPath(linkBytes, physicalRepoRoot));
    if (
      !sameIdentity(before, lstatSync(path, { bigint: true })) ||
      !linkBytes.equals(readlinkSync(path, { encoding: "buffer" }))
    ) {
      throw installedDependencyError(
        `installed dependency payload link changed while read: ${relativePath}`,
      );
    }
    return hash.digest("hex");
  } else if (before.isDirectory()) {
    return hash.digest("hex");
  } else {
    throw installedDependencyError(
      `installed dependency payload has an unsupported type: ${relativePath}`,
    );
  }

  if (!sameIdentity(before, lstatSync(path, { bigint: true }))) {
    throw installedDependencyError(
      `installed dependency payload file changed while read: ${relativePath}`,
    );
  }
  return hash.digest("hex");
}

function installedDependencyPayloadFileSnapshot(
  path,
  expected,
  relativePath,
  budget,
  limits,
  noFollow,
) {
  const maxExactBytes = limits.maxPayloadFileBytes;
  if (expected.size <= BigInt(maxExactBytes)) {
    consumeInstalledDependencyBytes(budget, Number(expected.size), limits);
    return {
      kind: "content",
      value: readBoundedRegularFile(path, expected, {
        maxFileBytes: maxExactBytes,
        noFollow,
        subject: `installed dependency payload ${relativePath}`,
      }),
    };
  }

  const sampleBytes = Math.min(64 * 1024, maxExactBytes);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameIdentity(before, expected)) {
      throw installedDependencyError(
        `installed dependency payload changed before it was sampled: ${relativePath}`,
      );
    }
    const first = Buffer.alloc(sampleBytes);
    const last = Buffer.alloc(sampleBytes);
    const firstCount = readSync(descriptor, first, 0, sampleBytes, 0);
    const lastOffset = Number(before.size) - sampleBytes;
    const lastCount = readSync(descriptor, last, 0, sampleBytes, lastOffset);
    if (firstCount !== sampleBytes || lastCount !== sampleBytes) {
      throw installedDependencyError(
        `installed dependency payload changed while it was sampled: ${relativePath}`,
      );
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, after)) {
      throw installedDependencyError(
        `installed dependency payload changed while it was sampled: ${relativePath}`,
      );
    }
    consumeInstalledDependencyBytes(budget, first.length + last.length, limits);
    return {
      kind: "sample",
      value: Buffer.concat([first, last]),
    };
  } finally {
    closeSync(descriptor);
  }
}

function installedDependencyResolvedPayloadSnapshot(
  path,
  relativePath,
  physicalRepoRoot,
  budget,
  limits,
) {
  const before = lstatSync(path, { bigint: true });
  const hash = createHash("sha256");
  hash.update("installed-dependency-resolved-payload-v1\0");
  updateField(hash, "path", relativePath);
  updateField(hash, "type", entryType(before));
  updateField(hash, "mode", before.mode.toString(8));
  if (before.isFile()) {
    const snapshot = installedDependencyPayloadFileSnapshot(
      path,
      before,
      relativePath,
      budget,
      limits,
      true,
    );
    updateField(hash, "size", before.size.toString());
    updateField(hash, snapshot.kind, snapshot.value);
  } else if (before.isSymbolicLink()) {
    const linkBytes = readlinkSync(path, { encoding: "buffer" });
    const targetBefore = statSync(path, { bigint: true });
    consumeInstalledDependencyBytes(budget, linkBytes.length, limits);
    updateField(hash, "link", normalizeLinkPath(linkBytes, physicalRepoRoot));
    updateField(hash, "target-type", entryType(targetBefore));
    updateField(hash, "target-mode", targetBefore.mode.toString(8));
    if (targetBefore.isFile()) {
      const snapshot = installedDependencyPayloadFileSnapshot(
        path,
        targetBefore,
        relativePath,
        budget,
        limits,
        false,
      );
      updateField(hash, "target-size", targetBefore.size.toString());
      updateField(hash, `target-${snapshot.kind}`, snapshot.value);
    }
    if (
      !sameIdentity(targetBefore, statSync(path, { bigint: true })) ||
      !linkBytes.equals(readlinkSync(path, { encoding: "buffer" }))
    ) {
      throw installedDependencyError(
        `installed dependency payload link target changed while read: ${relativePath}`,
      );
    }
  } else if (!before.isDirectory()) {
    throw installedDependencyError(
      `installed dependency payload has an unsupported type: ${relativePath}`,
    );
  }
  if (!sameIdentity(before, lstatSync(path, { bigint: true }))) {
    throw installedDependencyError(
      `installed dependency payload changed while read: ${relativePath}`,
    );
  }
  return hash.digest("hex");
}

function installedDependencyPayloadPath(value, packagePath, allowBare) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!allowBare && !value.startsWith(".")) return null;
  if (value.includes("*")) return null;
  const candidate = resolve(packagePath, value);
  if (
    candidate === packagePath ||
    !candidate.startsWith(`${packagePath}${sep}`)
  ) {
    return null;
  }
  return candidate;
}

function collectInstalledDependencyPayloadPaths(
  value,
  packagePath,
  paths,
  allowBare,
) {
  if (typeof value === "string") {
    const path = installedDependencyPayloadPath(value, packagePath, allowBare);
    if (path !== null) paths.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInstalledDependencyPayloadPaths(
        entry,
        packagePath,
        paths,
        allowBare,
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value)) {
    collectInstalledDependencyPayloadPaths(
      entry,
      packagePath,
      paths,
      allowBare,
    );
  }
}

function installedDependencyDeclaredPayloadPaths(manifest, packagePath) {
  const paths = new Set();
  for (const field of ["module", "types", "typings"]) {
    collectInstalledDependencyPayloadPaths(
      manifest[field],
      packagePath,
      paths,
      true,
    );
  }
  collectInstalledDependencyPayloadPaths(
    manifest.bin,
    packagePath,
    paths,
    true,
  );
  collectInstalledDependencyPayloadPaths(
    manifest.browser,
    packagePath,
    paths,
    typeof manifest.browser === "string",
  );
  for (const field of ["exports", "imports"]) {
    collectInstalledDependencyPayloadPaths(
      manifest[field],
      packagePath,
      paths,
      false,
    );
  }
  return [...paths].sort(compareUtf8);
}

function installedDependencyExistingPayloadPath(candidates) {
  for (const candidate of candidates) {
    try {
      return {
        metadata: lstatSync(candidate, { bigint: true }),
        path: candidate,
      };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  return null;
}

function resolveInstalledDependencyPayloadPathInternal(
  path,
  packagePath,
  physicalRepoRoot,
  budget,
  limits,
  hash,
  depth = 0,
) {
  if (depth > 4) return null;
  const exact = installedDependencyExistingPayloadPath([path]);
  if (exact !== null && !exact.metadata.isDirectory()) {
    if (!exact.metadata.isSymbolicLink()) return exact.path;
    const linkBytes = readlinkSync(exact.path, { encoding: "buffer" });
    const target = statSync(exact.path, { bigint: true });
    consumeInstalledDependencyBytes(budget, linkBytes.length, limits);
    updateField(
      hash,
      "directory-link",
      normalizeLinkPath(linkBytes, physicalRepoRoot),
    );
    updateField(hash, "directory-link-target-type", entryType(target));
    updateField(hash, "directory-link-target-mode", target.mode.toString(8));
    if (!target.isDirectory()) return exact.path;
  }
  const file = installedDependencyExistingPayloadPath([
    `${path}.js`,
    `${path}.json`,
    `${path}.node`,
  ]);
  if (file !== null && !file.metadata.isDirectory()) {
    updateField(hash, "extension-candidate", relative(packagePath, file.path));
    return file.path;
  }
  if (exact === null) return null;

  const nestedManifestPath = join(path, "package.json");
  const nestedManifest = installedDependencyExistingPayloadPath([
    nestedManifestPath,
  ]);
  if (nestedManifest?.metadata.isFile()) {
    const bytes = readBoundedRegularFile(
      nestedManifestPath,
      nestedManifest.metadata,
      {
        maxFileBytes: limits.maxFileBytes,
        noFollow: true,
        subject: `installed dependency nested package manifest ${nestedManifestPath}`,
      },
    );
    consumeInstalledDependencyBytes(budget, bytes.length, limits);
    updateField(
      hash,
      "nested-package-json-path",
      relative(packagePath, nestedManifestPath),
    );
    updateField(hash, "nested-package-json", bytes);
    const text = exactUtf8Text(bytes);
    if (text !== null) {
      let manifest = null;
      try {
        manifest = JSON.parse(text);
      } catch {
        // Node falls through to index files for an invalid nested manifest.
      }
      if (typeof manifest?.main === "string") {
        const nested = resolveInstalledDependencyPayloadPathInternal(
          resolve(path, manifest.main),
          packagePath,
          physicalRepoRoot,
          budget,
          limits,
          hash,
          depth + 1,
        );
        if (nested !== null) return nested;
      }
    }
  }
  const index = installedDependencyExistingPayloadPath([
    join(path, "index.js"),
    join(path, "index.json"),
    join(path, "index.node"),
  ]);
  if (index !== null) {
    updateField(hash, "index-candidate", relative(packagePath, index.path));
  }
  return index?.path ?? null;
}

function resolveInstalledDependencyPayloadPath(
  path,
  packagePath,
  physicalRepoRoot,
  budget,
  limits,
) {
  const hash = createHash("sha256");
  hash.update("installed-dependency-payload-resolution-v1\0");
  const resolvedPath = resolveInstalledDependencyPayloadPathInternal(
    path,
    packagePath,
    physicalRepoRoot,
    budget,
    limits,
    hash,
  );
  updateField(
    hash,
    "resolved",
    resolvedPath === null ? "missing" : relative(packagePath, resolvedPath),
  );
  return { digest: hash.digest("hex"), path: resolvedPath };
}

function resolveInstalledDependencyPackageDefault(
  packagePath,
  manifest,
  physicalRepoRoot,
  budget,
  limits,
) {
  const hash = createHash("sha256");
  hash.update("installed-dependency-package-default-v1\0");
  if (typeof manifest.main === "string") {
    const mainPath = resolve(packagePath, manifest.main);
    if (
      mainPath !== packagePath &&
      mainPath.startsWith(`${packagePath}${sep}`)
    ) {
      const main = resolveInstalledDependencyPayloadPath(
        mainPath,
        packagePath,
        physicalRepoRoot,
        budget,
        limits,
      );
      updateField(hash, "main-resolution", main.digest);
      if (main.path !== null) {
        updateField(hash, "resolved", relative(packagePath, main.path));
        return { digest: hash.digest("hex"), path: main.path };
      }
    }
  }
  const index = installedDependencyExistingPayloadPath([
    join(packagePath, "index.js"),
    join(packagePath, "index.json"),
    join(packagePath, "index.node"),
  ]);
  updateField(
    hash,
    "resolved",
    index === null ? "missing" : relative(packagePath, index.path),
  );
  return { digest: hash.digest("hex"), path: index?.path ?? null };
}

function installedDependencyShallowPayloadSnapshot(
  packagePath,
  relativePath,
  manifest,
  physicalRepoRoot,
  budget,
  limits,
) {
  const before = lstatSync(packagePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw installedDependencyError(
      `installed dependency payload root is not a real directory: ${relativePath}`,
    );
  }
  const names = boundedInstalledDependencyNames(
    packagePath,
    limits.maxEntries - budget.entries,
  );
  consumeInstalledDependencyEntries(budget, names.length, limits);
  const hash = createHash("sha256");
  hash.update("installed-dependency-shallow-payload-v1\0");
  const resolvedPayloadDigests = new Map();
  for (const name of names) {
    if (name === "node_modules" || name === "package.json") continue;
    updateField(hash, "name", name);
    updateField(
      hash,
      "entry",
      installedDependencyPayloadTopologyEntrySnapshot(
        join(packagePath, name),
        join(relativePath, name),
        physicalRepoRoot,
        budget,
        limits,
      ),
    );
  }
  const defaultResolution = resolveInstalledDependencyPackageDefault(
    packagePath,
    manifest,
    physicalRepoRoot,
    budget,
    limits,
  );
  updateField(hash, "default-resolution", defaultResolution.digest);
  if (defaultResolution.path !== null) {
    const defaultRelativePath = relative(packagePath, defaultResolution.path);
    consumeInstalledDependencyEntries(budget, 1, limits);
    const defaultDigest = installedDependencyResolvedPayloadSnapshot(
      defaultResolution.path,
      join(relativePath, defaultRelativePath),
      physicalRepoRoot,
      budget,
      limits,
    );
    resolvedPayloadDigests.set(defaultResolution.path, defaultDigest);
    updateField(hash, "default-path", defaultRelativePath);
    updateField(hash, "default-entry", defaultDigest);
  }
  for (const declaredPath of installedDependencyDeclaredPayloadPaths(
    manifest,
    packagePath,
  )) {
    const resolution = resolveInstalledDependencyPayloadPath(
      declaredPath,
      packagePath,
      physicalRepoRoot,
      budget,
      limits,
    );
    const path = resolution.path;
    const declaredRelativePath = relative(packagePath, declaredPath);
    updateField(hash, "declared-path", declaredRelativePath);
    updateField(hash, "declared-resolution", resolution.digest);
    if (path === null) {
      updateField(hash, "declared-entry", "missing");
      continue;
    }
    const resolvedRelativePath = relative(packagePath, path);
    updateField(hash, "resolved-path", resolvedRelativePath);
    let digest = resolvedPayloadDigests.get(path);
    if (digest === undefined) {
      consumeInstalledDependencyEntries(budget, 1, limits);
      digest = installedDependencyResolvedPayloadSnapshot(
        path,
        join(relativePath, resolvedRelativePath),
        physicalRepoRoot,
        budget,
        limits,
      );
      resolvedPayloadDigests.set(path, digest);
    }
    updateField(hash, "declared-entry", digest);
  }
  const finalNames = boundedInstalledDependencyNames(packagePath, names.length);
  if (
    names.length !== finalNames.length ||
    names.some((name, index) => name !== finalNames[index]) ||
    !sameIdentity(before, lstatSync(packagePath, { bigint: true }))
  ) {
    throw installedDependencyError(
      `installed dependency payload root changed while read: ${relativePath}`,
    );
  }
  return hash.digest("hex");
}

function installedDependencyPayloadSnapshot(
  packagePath,
  relativePath,
  manifest,
  budget,
  limits,
  payloadDigests,
  physicalRepoRoot,
) {
  const physicalPackagePath = realpathSync(packagePath);
  const repoRelativePath = relative(physicalRepoRoot, physicalPackagePath);
  if (
    repoRelativePath !== "" &&
    !repoRelativePath.startsWith(`..${sep}`) &&
    repoRelativePath !== ".." &&
    !isAbsolute(repoRelativePath) &&
    !repoRelativePath.split(sep).includes("node_modules")
  ) {
    return "workspace-source";
  }
  const cached = payloadDigests.get(physicalPackagePath);
  if (cached !== undefined) return cached;
  const digest = installedDependencyShallowPayloadSnapshot(
    physicalPackagePath,
    relativePath,
    manifest,
    physicalRepoRoot,
    budget,
    limits,
  );
  payloadDigests.set(physicalPackagePath, digest);
  return digest;
}

function installedDependencyLinkSnapshot(
  nodeModulesPath,
  relativePath,
  physicalRepoRoot,
  budget,
  limits,
  payloadDigests,
) {
  const path = join(nodeModulesPath, relativePath);
  const before = lstatSync(path, { bigint: true });
  if (!before.isSymbolicLink()) {
    throw installedDependencyError(
      `installed dependency package entry is not a symlink: ${relativePath}`,
    );
  }
  const linkBytes = readlinkSync(path, { encoding: "buffer" });
  consumeInstalledDependencyBytes(budget, linkBytes.length, limits);
  const targetBefore = statSync(path, { bigint: true });
  if (!targetBefore.isDirectory()) {
    throw installedDependencyError(
      `installed dependency package link does not resolve to a directory: ${relativePath}`,
    );
  }
  const target = normalizeRootPathText(realpathSync(path), physicalRepoRoot);
  const packageJson = installedDependencyPackageJsonSnapshot(
    path,
    relativePath,
    physicalRepoRoot,
    budget,
    limits,
  );
  const payload = installedDependencyPayloadSnapshot(
    path,
    relativePath,
    packageJson.manifest,
    budget,
    limits,
    payloadDigests,
    physicalRepoRoot,
  );
  if (!sameIdentity(targetBefore, statSync(path, { bigint: true }))) {
    throw installedDependencyError(
      `installed dependency package target changed while read: ${relativePath}`,
    );
  }
  if (!linkBytes.equals(readlinkSync(path, { encoding: "buffer" }))) {
    throw installedDependencyError(
      `installed dependency package link changed while read: ${relativePath}`,
    );
  }
  if (!sameIdentity(before, lstatSync(path, { bigint: true }))) {
    throw installedDependencyError(
      `installed dependency package entry changed while read: ${relativePath}`,
    );
  }
  const hash = createHash("sha256");
  hash.update("installed-dependency-link-v1\0");
  updateField(hash, "path", relativePath);
  updateField(hash, "mode", before.mode.toString(8));
  updateField(hash, "link", normalizeLinkPath(linkBytes, physicalRepoRoot));
  updateField(hash, "target", target);
  updateField(hash, "target-mode", targetBefore.mode.toString(8));
  updateField(hash, "package-json", packageJson.digest);
  updateField(hash, "payload-generation", payload);
  return hash.digest("hex");
}

function installedDependencyScopeSnapshot(
  nodeModulesPath,
  name,
  physicalRepoRoot,
  budget,
  limits,
  payloadDigests,
) {
  const path = join(nodeModulesPath, name);
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw installedDependencyError(
      `installed dependency scope is not a real directory: ${name}`,
    );
  }
  const names = boundedInstalledDependencyNames(
    path,
    limits.maxEntries - budget.entries,
  );
  consumeInstalledDependencyEntries(budget, names.length, limits);
  const hash = createHash("sha256");
  hash.update("installed-dependency-scope-v1\0");
  updateField(hash, "name", name);
  updateField(hash, "mode", before.mode.toString(8));
  for (const packageName of names) {
    if (packageName.startsWith(".")) continue;
    updateField(
      hash,
      "package",
      installedDependencyLinkSnapshot(
        nodeModulesPath,
        join(name, packageName),
        physicalRepoRoot,
        budget,
        limits,
        payloadDigests,
      ),
    );
  }
  const finalNames = boundedInstalledDependencyNames(path, names.length);
  if (
    names.length !== finalNames.length ||
    names.some((entry, index) => entry !== finalNames[index]) ||
    !sameIdentity(before, lstatSync(path, { bigint: true }))
  ) {
    throw installedDependencyError(
      `installed dependency scope changed while read: ${name}`,
    );
  }
  return hash.digest("hex");
}

function installedDependencyRootSnapshot(
  physicalRepoRoot,
  relativeRoot,
  budget,
  limits,
  payloadDigests,
) {
  const nodeModulesPath = join(physicalRepoRoot, relativeRoot, "node_modules");
  let before;
  try {
    before = lstatSync(nodeModulesPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw installedDependencyError(
      `installed dependency root is not a real directory: ${relativeRoot || "."}`,
    );
  }
  const names = boundedInstalledDependencyNames(
    nodeModulesPath,
    limits.maxEntries - budget.entries,
  );
  consumeInstalledDependencyEntries(budget, names.length, limits);
  const hash = createHash("sha256");
  hash.update("installed-dependency-root-v1\0");
  updateField(hash, "root", relativeRoot || ".");
  updateField(hash, "mode", before.mode.toString(8));
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const digest = name.startsWith("@")
      ? installedDependencyScopeSnapshot(
          nodeModulesPath,
          name,
          physicalRepoRoot,
          budget,
          limits,
          payloadDigests,
        )
      : installedDependencyLinkSnapshot(
          nodeModulesPath,
          name,
          physicalRepoRoot,
          budget,
          limits,
          payloadDigests,
        );
    updateField(hash, "entry", digest);
  }
  const finalNames = boundedInstalledDependencyNames(
    nodeModulesPath,
    names.length,
  );
  if (
    names.length !== finalNames.length ||
    names.some((entry, index) => entry !== finalNames[index]) ||
    !sameIdentity(before, lstatSync(nodeModulesPath, { bigint: true }))
  ) {
    throw installedDependencyError(
      `installed dependency root changed while read: ${relativeRoot || "."}`,
    );
  }
  return hash.digest("hex");
}

function installedDependencySnapshot(physicalRepoRoot, limits) {
  const budget = { bytes: 0, entries: 0 };
  const payloadDigests = new Map();
  const hash = createHash("sha256");
  hash.update("installed-dependency-state-v1\0");
  const rootNodeModules = join(physicalRepoRoot, "node_modules");
  for (const descriptor of installedDependencyMetadata) {
    updateField(hash, "metadata", descriptor.relativePath);
    updateField(
      hash,
      "metadata-state",
      installedMetadataFileSnapshot(
        rootNodeModules,
        descriptor,
        physicalRepoRoot,
        budget,
        limits,
      ),
    );
  }
  for (const relativeRoot of MATERIAL_PACKAGE_ROOTS) {
    updateField(hash, "root", relativeRoot || ".");
    updateField(
      hash,
      "root-state",
      installedDependencyRootSnapshot(
        physicalRepoRoot,
        relativeRoot,
        budget,
        limits,
        payloadDigests,
      ),
    );
  }
  return hash.digest("hex");
}

function normalizedInstalledDependencyManifestWithLimits(repoRoot, limits) {
  const physicalRepoRoot = realpathSync(repoRoot);
  return installedDependencySnapshot(physicalRepoRoot, limits);
}

function installedDependencyLimits(overrides) {
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(productionInstalledDependencyLimits, name)) {
      throw new TypeError(`unknown installed dependency limit: ${name}`);
    }
  }
  const limits = { ...productionInstalledDependencyLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return Object.freeze(limits);
}

export function normalizedInstalledDependencyManifest(repoRoot) {
  return normalizedInstalledDependencyManifestWithLimits(
    repoRoot,
    productionInstalledDependencyLimits,
  );
}

export function normalizedInstalledDependencyManifestForTest(
  repoRoot,
  overrides,
) {
  return normalizedInstalledDependencyManifestWithLimits(
    repoRoot,
    installedDependencyLimits(overrides),
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

function materialLocalBinPathReplacement(value, paths, workingDirectory) {
  for (const entry of paths) {
    if (pathResolvesTo(value, entry.path, workingDirectory)) {
      return entry.replacement;
    }
  }
  return null;
}

function materialPathValueIsSentinel(name, value) {
  return (
    (name === "COREPACK_ENV_FILE" && value === "0") ||
    (name === "GOENV" && value === "off") ||
    (name === "PLAYWRIGHT_BROWSERS_PATH" && value === "0")
  );
}

function materialSinglePathEnvironmentName(name) {
  return (
    materialSinglePathEnvironmentNames.has(name) ||
    materialSinglePathEnvironmentNamePatterns.some((pattern) =>
      pattern.test(name),
    )
  );
}

function materialPathListComponents(name, value) {
  if (name === "LD_PRELOAD") {
    return value
      .split(/\s+/u)
      .flatMap((component) => component.split(delimiter));
  }
  return value.split(delimiter);
}

function materialPathListHasRelativeComponent(name, value) {
  if (value.length === 0) return false;
  return materialPathListComponents(name, value).some((component) =>
    component.length === 0
      ? materialEmptyComponentCwdPathListEnvironmentNames.has(name)
      : !isAbsolute(component),
  );
}

function materialJsonPathListHasRelativeComponent(value) {
  if (value.length === 0) return false;
  let components;
  try {
    components = JSON.parse(value);
  } catch {
    return true;
  }
  if (!Array.isArray(components)) return true;
  return components.some(
    (component) =>
      typeof component !== "string" ||
      (component.length > 0 && !isAbsolute(component)),
  );
}

function foundrySolcValueIsRelativePath(value) {
  if (value.length === 0 || isAbsolute(value) || value === "auto") return false;
  return !/^(?:solc:)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
    value,
  );
}

function foundryRemappingsHaveRelativePath(value) {
  if (value.length === 0) return false;
  return value.split(/\r?\n/u).some((entry) => {
    if (entry.length === 0) return false;
    const separator = entry.indexOf("=");
    if (separator < 0) return true;
    const target = entry.slice(separator + 1);
    return target.length === 0 || !isAbsolute(target);
  });
}

function foundryLibrariesHaveRelativePath(value) {
  if (value.length === 0) return false;
  return value.split(",").some((entry) => {
    const addressSeparator = entry.lastIndexOf(":");
    const nameSeparator = entry.lastIndexOf(":", addressSeparator - 1);
    if (nameSeparator <= 0 || addressSeparator <= nameSeparator + 1)
      return true;
    const sourcePath = entry.slice(0, nameSeparator);
    return !isAbsolute(sourcePath);
  });
}

function foundryFsPermissionsHaveRelativePath(value) {
  if (value.length === 0) return false;
  try {
    const permissions = JSON.parse(value);
    if (!Array.isArray(permissions)) return true;
    return permissions.some(
      (permission) =>
        permission === null ||
        typeof permission !== "object" ||
        typeof permission.path !== "string" ||
        permission.path.length === 0 ||
        !isAbsolute(permission.path),
    );
  } catch {
    const paths = [...value.matchAll(/\bpath\s*=\s*["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    return paths.length === 0 || paths.some((path) => !isAbsolute(path));
  }
}

function materialStructuredPathHasRelativeComponent(name, value) {
  if (name === "FOUNDRY_REMAPPINGS") {
    return foundryRemappingsHaveRelativePath(value);
  }
  if (name === "FOUNDRY_LIBRARIES") {
    return foundryLibrariesHaveRelativePath(value);
  }
  if (name === "FOUNDRY_FS_PERMISSIONS") {
    return foundryFsPermissionsHaveRelativePath(value);
  }
  return false;
}

function materialCwdBoundEnvironmentName(name) {
  return (
    materialCwdBoundEnvironmentNames.has(name) ||
    /^TF_CLI_ARGS(?:_[A-Za-z0-9_]+)?$/u.test(name)
  );
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
  let bindsPhysicalWorkingDirectory = false;
  const entries = selectedEnvironmentEntries(environment).map(
    ([name, rawValue]) => {
      const value = rawValue ?? "";
      if (name === "PATH") {
        const pathEntries = value.split(delimiter);
        const normalizedPathEntries = pathEntries.map((entry) => {
          const replacement = materialLocalBinPathReplacement(
            entry,
            localBinPaths,
            physicalWorkingDirectory,
          );
          if (replacement !== null) return replacement;
          if (!isAbsolute(entry)) bindsPhysicalWorkingDirectory = true;
          return entry;
        });
        return [name, normalizedPathEntries.join(delimiter)];
      }
      if (name === "INIT_CWD" || name === "PNPM_SCRIPT_SRC_DIR") {
        if (pathResolvesTo(value, physicalRepoRoot, physicalWorkingDirectory)) {
          return [name, worktreeToken];
        }
      }
      if (name === "TMPDIR" || name === "TMP" || name === "TEMP") {
        if (pathResolvesTo(value, gateScratchPath, physicalWorkingDirectory)) {
          return [name, gateScratchEntry];
        }
      }
      if (
        value.length > 0 &&
        materialSinglePathEnvironmentName(name) &&
        !materialPathValueIsSentinel(name, value) &&
        !isAbsolute(value)
      ) {
        bindsPhysicalWorkingDirectory = true;
      }
      if (
        materialPathListEnvironmentNames.has(name) &&
        materialPathListHasRelativeComponent(name, value)
      ) {
        bindsPhysicalWorkingDirectory = true;
      }
      if (
        materialJsonPathListEnvironmentNames.has(name) &&
        materialJsonPathListHasRelativeComponent(value)
      ) {
        bindsPhysicalWorkingDirectory = true;
      }
      if (
        materialFoundrySolcEnvironmentNames.has(name) &&
        foundrySolcValueIsRelativePath(value)
      ) {
        bindsPhysicalWorkingDirectory = true;
      }
      if (
        materialStructuredPathEnvironmentNames.has(name) &&
        materialStructuredPathHasRelativeComponent(name, value)
      ) {
        bindsPhysicalWorkingDirectory = true;
      }
      if (value.length > 0 && materialCwdBoundEnvironmentName(name)) {
        bindsPhysicalWorkingDirectory = true;
      }
      return [name, value];
    },
  );
  if (bindsPhysicalWorkingDirectory) {
    entries.push([
      "__AGENT_QUALITY_GATE_RELATIVE_ENVIRONMENT_CWD__",
      physicalWorkingDirectory,
    ]);
  }
  entries.push([
    "__AGENT_QUALITY_GATE_LOCAL_BIN_MANIFEST__",
    normalizedLocalBinManifest(physicalRepoRoot),
  ]);
  entries.push([
    "__AGENT_QUALITY_GATE_INSTALLED_DEPENDENCY_MANIFEST__",
    normalizedInstalledDependencyManifest(physicalRepoRoot),
  ]);
  entries.push([
    "__AGENT_QUALITY_GATE_ENV_FILE_MANIFEST__",
    materialEnvironmentFileManifest(physicalRepoRoot),
  ]);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash("sha256");
  hash.update("material-environment-v7\0");
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
