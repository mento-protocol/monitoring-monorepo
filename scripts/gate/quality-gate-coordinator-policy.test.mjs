import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOCAL_BIN_MAX_FILE_BYTES,
  mappedChildScrubbedEnvironmentName,
  materialEnvironmentDigest as computeMaterialEnvironmentDigest,
  normalizedLocalBinManifest,
  normalizedLocalBinManifestForTest,
} from "./quality-gate-coordinator-environment.mjs";
import {
  coordinatorSourceSnapshot,
  coordinatorSourceSignature,
  effectiveCoordinatorPolicyHash,
} from "./quality-gate-coordinator-policy.mjs";
import {
  connectCoordinator,
  coordinatorRpc,
} from "./quality-gate-coordinator-client.mjs";

const gateDirectory = dirname(fileURLToPath(import.meta.url));
const coordinatorEntry = join(gateDirectory, "quality-gate-coordinator.mjs");
const coordinatorSupport = join(
  gateDirectory,
  "quality-gate-coordinator-support.sh",
);
const productionModulePattern =
  /^quality-gate-coordinator(?!.*\.test\.mjs$).*\.mjs$/u;

async function copyCoordinatorRuntime(targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  const names = readdirSync(gateDirectory).filter(
    (name) =>
      productionModulePattern.test(name) ||
      [
        "quality-gate-coordinator.sh",
        "quality-gate-coordinator-support.sh",
      ].includes(name),
  );
  await Promise.all(
    names.map((name) =>
      copyFile(join(gateDirectory, name), join(targetDirectory, name)),
    ),
  );
}

function firstJsonLine(child) {
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => {
      rejectLine(new Error(`coordinator readiness timed out: ${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveLine(JSON.parse(stdout.slice(0, newline)));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectLine(
        new Error(
          `coordinator exited before readiness (${code ?? signal}): ${stderr}`,
        ),
      );
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectLine(error);
    });
  });
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

function pnpmShellShim(
  physicalRoot,
  {
    extraLines = [],
    lineEnding = "\n",
    target = `${physicalRoot}/node_modules/fixture-tool/bin/tool.mjs`,
  } = {},
) {
  const nodePath = [
    `${physicalRoot}/node_modules/.pnpm/fixture-tool/node_modules`,
    `${physicalRoot}/node_modules/.pnpm/node_modules`,
  ].join(":");
  return [
    "#!/bin/sh",
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'if [ -z "$NODE_PATH" ]; then',
    `  export NODE_PATH="${nodePath}"`,
    "else",
    `  export NODE_PATH="${nodePath}:$NODE_PATH"`,
    "fi",
    ...extraLines,
    'exec node "$basedir/../fixture-tool/bin/tool.mjs" "$@"',
    `# cmd-shim-target=${target}`,
    "",
  ].join(lineEnding);
}

async function materialEnvironmentFixture(label) {
  const root = await mkdtemp(join(tmpdir(), `quality-gate-env-${label}-`));
  const physicalRoot = await realpath(root);
  const localBin = join(root, "node_modules", ".bin");
  const wrapper = join(localBin, "fixture-tool");
  await mkdir(localBin, { recursive: true });
  await writeFile(wrapper, pnpmShellShim(physicalRoot));
  await chmod(wrapper, 0o755);
  const target = join(root, "node_modules", "fixture-tool", "bin", "tool.mjs");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "#!/usr/bin/env node\n// fixture tool\n");
  await chmod(target, 0o755);
  return { root, physicalRoot, localBin, wrapper, target };
}

function materialEnvironmentDigest(
  fixture,
  {
    pathEntries = [
      fixture.localBin,
      dirname(process.execPath),
      "/usr/bin",
      fixture.localBin,
    ],
    initCwd = fixture.root,
    pnpmScriptSource = fixture.root,
    extraEnvironment = {},
  } = {},
) {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      'source "$1"; repo_root="$2"; script_source_dir="$3"; gate_coordinator_material_env_digest "$2"',
      "quality-gate-environment-test",
      coordinatorSupport,
      fixture.root,
      dirname(gateDirectory),
    ],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: pathEntries.join(delimiter),
        INIT_CWD: initCwd,
        PNPM_SCRIPT_SRC_DIR: pnpmScriptSource,
        ...extraEnvironment,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[a-f0-9]{64}$/u);
  return result.stdout;
}

function syntheticSnapshot() {
  return [
    {
      name: "quality-gate-coordinator.mjs",
      relativePath: "gate/quality-gate-coordinator.mjs",
      digest: "1".repeat(64),
    },
    {
      name: "quality-gate-coordinator.sh",
      relativePath: "gate/quality-gate-coordinator.sh",
      digest: "2".repeat(64),
    },
    {
      name: "quality-gate-coordinator-support.sh",
      relativePath: "gate/quality-gate-coordinator-support.sh",
      digest: "3".repeat(64),
    },
  ];
}

test("effective policy identity is stable and binds capacity and Node options", () => {
  const snapshot = syntheticSnapshot();
  const options = {
    snapshot,
    executable: "/test/node",
    version: "v24.0.0",
    platform: "test-platform",
    architecture: "test-architecture",
    nodeOptions: "--no-warnings",
  };
  const first = effectiveCoordinatorPolicyHash(3, options);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(effectiveCoordinatorPolicyHash(3, options), first);
  assert.notEqual(effectiveCoordinatorPolicyHash(2, options), first);
  assert.notEqual(
    effectiveCoordinatorPolicyHash(3, {
      ...options,
      nodeOptions: "--trace-warnings",
    }),
    first,
  );
  assert.equal(
    effectiveCoordinatorPolicyHash(3, {
      ...options,
      loadedAdapterHashes: {
        main: "2".repeat(64),
        support: "3".repeat(64),
      },
    }),
    first,
  );
  assert.throws(
    () =>
      effectiveCoordinatorPolicyHash(3, {
        ...options,
        loadedAdapterHashes: {
          main: "4".repeat(64),
          support: "3".repeat(64),
        },
      }),
    (error) => error?.code === "POLICY_IDENTITY_CHANGED",
  );
  assert.match(coordinatorSourceSignature({ snapshot }), /^[a-f0-9]{64}$/u);
});

test("source identity fails closed for first, middle, and final read errors", async (t) => {
  const sourceCount =
    readdirSync(gateDirectory).filter((name) =>
      productionModulePattern.test(name),
    ).length + 2;
  for (const failAt of [1, sourceCount, sourceCount * 2]) {
    await t.test(`read ${failAt}`, () => {
      let calls = 0;
      assert.throws(
        () =>
          coordinatorSourceSnapshot({
            directory: gateDirectory,
            readSource(path) {
              calls += 1;
              if (calls === failAt) throw new Error(`synthetic read ${failAt}`);
              return readFileSync(path);
            },
          }),
        new RegExp(`synthetic read ${failAt}`),
      );
    });
  }
});

test("source identity rejects equal-length bytes that change between snapshots", () => {
  const sourceCount =
    readdirSync(gateDirectory).filter((name) =>
      productionModulePattern.test(name),
    ).length + 2;
  let calls = 0;
  assert.throws(
    () =>
      coordinatorSourceSnapshot({
        directory: gateDirectory,
        readSource(path) {
          calls += 1;
          const bytes = Buffer.from(readFileSync(path));
          if (calls === sourceCount + 1) bytes[0] ^= 1;
          return bytes;
        },
      }),
    (error) => error?.code === "POLICY_IDENTITY_CHANGED",
  );
});

test("detached serve rejects policy drift before it creates state", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "quality-gate-policy-attest-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "coordinator-root");
  const preparedEnvironment = { ...process.env, NODE_OPTIONS: "--no-warnings" };
  delete preparedEnvironment.AGENT_QUALITY_GATE_REQUEST_CAPABILITY;
  const prepared = spawnSync(
    process.execPath,
    [coordinatorEntry, "policy-hash", "--capacity", "3"],
    { encoding: "utf8", env: preparedEnvironment },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /^[a-f0-9]{64}$/u);

  const servingEnvironment = {
    ...preparedEnvironment,
    NODE_OPTIONS: "--trace-warnings",
  };
  const attempted = spawnSync(
    process.execPath,
    [
      coordinatorEntry,
      "serve",
      "--root",
      root,
      "--capacity",
      "3",
      "--policy-hash",
      prepared.stdout,
    ],
    { encoding: "utf8", env: servingEnvironment },
  );
  assert.equal(attempted.status, 2);
  const failure = JSON.parse(attempted.stderr);
  assert.equal(failure.error.code, "POLICY_IDENTITY_CHANGED");
  assert.equal(existsSync(root), false);
  assert.doesNotMatch(attempted.stderr, /--no-warnings|--trace-warnings/u);
  assert.equal(attempted.stdout, "");
});

test("a mid-run source change rejects the next RPC without state mutation", async (t) => {
  const parent = await mkdtemp("/tmp/qgr-");
  const runtimeDirectory = join(parent, "gate");
  const root = join(parent, "coordinator-root");
  await copyCoordinatorRuntime(runtimeDirectory);
  const copiedEntry = await realpath(
    join(runtimeDirectory, "quality-gate-coordinator.mjs"),
  );
  const environment = { ...process.env };
  delete environment.AGENT_QUALITY_GATE_REQUEST_CAPABILITY;
  const prepared = spawnSync(
    process.execPath,
    [copiedEntry, "policy-hash", "--capacity", "1"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  const policyHash = prepared.stdout;
  assert.match(policyHash, /^[a-f0-9]{64}$/u);

  const coordinator = spawn(
    process.execPath,
    [
      copiedEntry,
      "serve",
      "--root",
      root,
      "--capacity",
      "1",
      "--policy-hash",
      policyHash,
      "--idle-ms",
      "30000",
      "--owner-sweep-ms",
      "0",
    ],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (coordinator.exitCode === null && coordinator.signalCode === null) {
      coordinator.kill("SIGTERM");
    }
    await childExit(coordinator);
    await rm(parent, { recursive: true, force: true });
  });
  const metadata = await firstJsonLine(coordinator);
  const owner = { pid: process.pid, startUtc: "runtime-drift-test-owner" };
  const capability = "7".repeat(64);
  const requestId = "runtime-drift-request";
  await coordinatorRpc({ root, policyHash }, "register", {
    requestId,
    capability,
    fingerprint: "runtime-drift-fingerprint",
    worktreeKey: parent,
    drainIdentity: `runtime-drift-${process.pid}-${Math.floor(Date.now() / 1000)}`,
    owner,
    successMaxAgeMs: 0,
    metadata: {},
  });
  const journalPath = join(metadata.stateRoot, "journal.json");
  const journalBefore = readFileSync(journalPath, "utf8");

  await writeFile(
    join(runtimeDirectory, "quality-gate-coordinator-policy.mjs"),
    "\n// mid-run source change\n",
    { flag: "a" },
  );
  await assert.rejects(
    coordinatorRpc({ root, policyHash }, "request-lease", {
      requestId,
      leaseId: "runtime-drift-lease",
      capability,
      owner,
      weight: 1,
      resources: [],
      metadata: {},
    }),
    (error) => error?.code === "POLICY_IDENTITY_CHANGED",
  );
  assert.equal(readFileSync(journalPath, "utf8"), journalBefore);
  await childExit(coordinator);
  assert.equal(coordinator.exitCode, 0);
  assert.equal(existsSync(metadata.socketPath), false);
});

test("a held wait reattests source before its timeout response", async (t) => {
  const parent = await mkdtemp("/tmp/qgr-wait-");
  const runtimeDirectory = join(parent, "gate");
  const root = join(parent, "coordinator-root");
  await copyCoordinatorRuntime(runtimeDirectory);
  const copiedEntry = await realpath(
    join(runtimeDirectory, "quality-gate-coordinator.mjs"),
  );
  const environment = { ...process.env };
  delete environment.AGENT_QUALITY_GATE_REQUEST_CAPABILITY;
  const prepared = spawnSync(
    process.execPath,
    [copiedEntry, "policy-hash", "--capacity", "1"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  const policyHash = prepared.stdout;
  const coordinator = spawn(
    process.execPath,
    [
      copiedEntry,
      "serve",
      "--root",
      root,
      "--capacity",
      "1",
      "--policy-hash",
      policyHash,
      "--idle-ms",
      "30000",
      "--owner-sweep-ms",
      "0",
    ],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (coordinator.exitCode === null && coordinator.signalCode === null) {
      coordinator.kill("SIGTERM");
    }
    await childExit(coordinator);
    await rm(parent, { recursive: true, force: true });
  });
  const metadata = await firstJsonLine(coordinator);
  const holderOwner = {
    pid: process.pid,
    startUtc: "runtime-wait-holder-owner",
  };
  const waiterOwner = {
    pid: process.pid,
    startUtc: "runtime-wait-queued-owner",
  };
  const holderCapability = "8".repeat(64);
  const waiterCapability = "9".repeat(64);
  const worktreeKey = join(parent, "shared-worktree");
  await coordinatorRpc({ root, policyHash }, "register", {
    requestId: "runtime-wait-holder",
    capability: holderCapability,
    fingerprint: "runtime-wait-holder-fingerprint",
    worktreeKey,
    drainIdentity: `runtime-wait-holder-${process.pid}-${Math.floor(Date.now() / 1000)}`,
    owner: holderOwner,
    successMaxAgeMs: 0,
    metadata: {},
  });
  const queued = await coordinatorRpc({ root, policyHash }, "register", {
    requestId: "runtime-wait-queued",
    capability: waiterCapability,
    fingerprint: "runtime-wait-queued-fingerprint",
    worktreeKey,
    drainIdentity: `runtime-wait-queued-${process.pid}-${Math.floor(Date.now() / 1000)}`,
    owner: waiterOwner,
    successMaxAgeMs: 0,
    metadata: {},
  });
  assert.equal(queued.admission, "queued");

  const client = await connectCoordinator({ root, policyHash });
  const waitResponse = client.request("wait-admission", {
    requestId: "runtime-wait-queued",
    capability: waiterCapability,
    owner: waiterOwner,
    timeoutMs: 10_000,
  });
  // The server processes messages from one socket in order. This response
  // proves that it registered and evaluated the held waiter first.
  const established = await client.request("inspect");
  assert.equal(
    established.requests.find(
      (request) => request.requestId === "runtime-wait-queued",
    )?.admission,
    "queued",
  );
  await writeFile(
    join(runtimeDirectory, "quality-gate-coordinator-policy.mjs"),
    "\n// held-wait source change\n",
    { flag: "a" },
  );
  await assert.rejects(
    waitResponse,
    (error) => error?.code === "POLICY_IDENTITY_CHANGED",
  );
  await client.closed;
  await childExit(coordinator);
  assert.equal(coordinator.exitCode, 0);
  assert.equal(existsSync(metadata.socketPath), false);
});

test("material environment normalizes only worktree lifecycle roots", async (t) => {
  const first = await materialEnvironmentFixture("first");
  const second = await materialEnvironmentFixture("second");
  const firstGateScratch = join(first.root, ".tmp", "agent-quality-gate");
  const secondGateScratch = join(second.root, ".tmp", "agent-quality-gate");
  await Promise.all([
    mkdir(firstGateScratch, { recursive: true }),
    mkdir(secondGateScratch, { recursive: true }),
  ]);
  t.after(async () => {
    await Promise.all([
      rm(first.root, { recursive: true, force: true }),
      rm(second.root, { recursive: true, force: true }),
    ]);
  });

  const firstDigest = materialEnvironmentDigest(first);
  assert.equal(materialEnvironmentDigest(second), firstDigest);

  assert.equal(
    materialEnvironmentDigest(first, {
      extraEnvironment: {
        TMPDIR: firstGateScratch,
        TMP: firstGateScratch,
        TEMP: firstGateScratch,
      },
    }),
    materialEnvironmentDigest(second, {
      extraEnvironment: {
        TMPDIR: secondGateScratch,
        TMP: secondGateScratch,
        TEMP: secondGateScratch,
      },
    }),
    "the gate-owned temp fallback must normalize across worktrees",
  );
  assert.notEqual(
    materialEnvironmentDigest(first, {
      extraEnvironment: { TMPDIR: "/tmp/quality-gate-env-a" },
    }),
    materialEnvironmentDigest(first, {
      extraEnvironment: { TMPDIR: "/tmp/quality-gate-env-b" },
    }),
    "different effective TMPDIR values must remain material",
  );
  assert.notEqual(
    materialEnvironmentDigest(first, {
      extraEnvironment: {
        TMPDIR: "/tmp/quality-gate-env",
        TMP: "/tmp/quality-gate-tmp-a",
      },
    }),
    materialEnvironmentDigest(first, {
      extraEnvironment: {
        TMPDIR: "/tmp/quality-gate-env",
        TMP: "/tmp/quality-gate-tmp-b",
      },
    }),
    "visible TMP values must remain material",
  );
  assert.notEqual(
    materialEnvironmentDigest(first, {
      extraEnvironment: {
        TMPDIR: "/tmp/quality-gate-env",
        TEMP: "/tmp/quality-gate-temp-a",
      },
    }),
    materialEnvironmentDigest(first, {
      extraEnvironment: {
        TMPDIR: "/tmp/quality-gate-env",
        TEMP: "/tmp/quality-gate-temp-b",
      },
    }),
    "visible TEMP values must remain material",
  );

  assert.notEqual(
    materialEnvironmentDigest(first, {
      pathEntries: [
        first.localBin,
        first.localBin,
        dirname(process.execPath),
        "/usr/bin",
      ],
    }),
    firstDigest,
    "PATH order and duplicate positions must remain material",
  );
  assert.notEqual(
    materialEnvironmentDigest(second, {
      pathEntries: [
        second.localBin,
        dirname(process.execPath),
        join(second.root, "other-bin"),
        second.localBin,
      ],
    }),
    firstDigest,
    "a non-lifecycle worktree path must remain raw",
  );
  assert.notEqual(
    materialEnvironmentDigest(second, {
      pnpmScriptSource: join(second.root, "nested-package"),
    }),
    firstDigest,
    "a non-root PNPM_SCRIPT_SRC_DIR must remain raw",
  );
  assert.notEqual(
    materialEnvironmentDigest(first, {
      initCwd: join(first.root, "nested-package"),
    }),
    materialEnvironmentDigest(second, {
      initCwd: join(second.root, "nested-package"),
    }),
    "a non-root INIT_CWD must remain raw",
  );
});

test("material environment binds mapped-command controls", async (t) => {
  const fixture = await materialEnvironmentFixture("mapped-controls");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const digest = (extraEnvironment = {}) =>
    computeMaterialEnvironmentDigest({
      repoRoot: fixture.root,
      workingDirectory: fixture.root,
      environment: {
        LANG: "C",
        LC_ALL: "C",
        PATH: [fixture.localBin, dirname(process.execPath), "/usr/bin"].join(
          delimiter,
        ),
        INIT_CWD: fixture.root,
        PNPM_SCRIPT_SRC_DIR: fixture.root,
        ...extraEnvironment,
      },
    });
  const baseline = digest();
  const materialNames = [
    "AGENT_AUTOREVIEW_GH_DEADLINE_SECONDS",
    "AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE",
    "AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER",
    "ALL_PROXY",
    "AUTOREVIEW_HEARTBEAT_SECONDS",
    "BROWSERSLIST",
    "BROWSERSLIST_CONFIG",
    "BROWSERSLIST_ENV",
    "COREPACK_HOME",
    "CURL_CA_BUNDLE",
    "DOCS_NAVIGATION_EVAL_REPO",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "ESBUILD_BINARY_PATH",
    "ESLINT_USE_FLAT_CONFIG",
    "GLIBC_TUNABLES",
    "GITHUB_ACTIONS",
    "GITHUB_BASE_REF",
    "GITHUB_EVENT_BEFORE",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "HASURA_FIXTURE_SCENARIO",
    "HASURA_URL",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "INDEXER_PERF",
    "INDEXER_PERF_LOG_INTERVAL_EVENTS",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "METADATA_SERVER_DETECTION",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NO_PROXY",
    "OPENSSL_CONF",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "PEG_POLICY_AUTH_MODE",
    "PEG_POLICY_BASE_REF",
    "PEG_POLICY_URL",
    "POLL_INTERVAL_MS",
    "PORT",
    "REBALANCE_PROBE_TIMEOUT_MS",
    "REQUESTS_CA_BUNDLE",
    "RESERVE_YIELD_EVENT_TESTS",
    "SOURCE_DATE_EPOCH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "STRYKER_MUTATOR",
    "TRUNK_CACHE",
    "TRUNK_CLI_VERSION",
    "VERCEL",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "all_proxy",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  for (const name of materialNames) {
    assert.notEqual(
      digest({ [name]: `fixture-${name}` }),
      baseline,
      `${name} must change the material environment digest`,
    );
  }
  const scrubbedNames = [
    "AGENT_CONTEXT_CLAUDE_SETTINGS_FILE",
    "AGENT_CONTEXT_CODEX_HOOKS_FILE",
    "ALERT_RULES_LINT_RULES_DIR",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "AUTOREVIEW_FAKE_MUTATE_REPO",
    "AUTOREVIEW_TEST_FOCUS",
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
    "GATE_TEST_FOCUS",
    "GIT_CONFIG_GLOBAL",
    "GITHUB_ACTION_PINS_ROOT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "LOCKFILE_LINT_ROOT",
    "SENTRY_SUITE_GATE_ROOT",
    "SKEW_CHECK_ROOT",
    "SKILLS_MIRROR_ROOT_A",
    "TRUNK_LAUNCHER_DEBUG",
    "TRUNK_LAUNCHER_PATH",
    "TRUNK_LAUNCHER_QUIET",
    "TRUNK_LAUNCHER_VERSION",
    "TRUNK_QUIET",
    "WGET_FLAGS",
  ];
  for (const name of scrubbedNames) {
    assert.equal(
      mappedChildScrubbedEnvironmentName(name),
      true,
      `${name} must stay in the mapped-child scrub policy`,
    );
    assert.equal(
      digest({ [name]: `fixture-${name}` }),
      baseline,
      `${name} must stay outside the key because mapped commands scrub it`,
    );
  }
  const parentMaterialScrubbedNames = [
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
  ];
  for (const name of parentMaterialScrubbedNames) {
    assert.equal(
      mappedChildScrubbedEnvironmentName(name),
      true,
      `${name} must stay in the mapped-child scrub policy`,
    );
    assert.notEqual(
      digest({ [name]: `fixture-${name}` }),
      baseline,
      `${name} must remain material to the parent coordinator key`,
    );
  }
  assert.equal(
    mappedChildScrubbedEnvironmentName("AGENT_QUALITY_GATE_LOCK_HELD"),
    false,
    "the nested gate lock marker must reach mapped self-tests",
  );
  assert.equal(
    mappedChildScrubbedEnvironmentName(
      "AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE",
    ),
    true,
  );
  assert.equal(
    mappedChildScrubbedEnvironmentName(
      "AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER",
    ),
    true,
  );
  assert.equal(mappedChildScrubbedEnvironmentName("GITHUB_BASE_REF"), false);
  assert.equal(
    digest({ UNRELATED_GATE_TEST_VALUE: "ignored" }),
    baseline,
    "unrelated environment values must stay outside the shared key",
  );
});

test("material environment binds ignored env files", async (t) => {
  const first = await materialEnvironmentFixture("env-file-first");
  const second = await materialEnvironmentFixture("env-file-second");
  t.after(async () => {
    await Promise.all([
      rm(first.root, { recursive: true, force: true }),
      rm(second.root, { recursive: true, force: true }),
    ]);
  });
  for (const fixture of [first, second]) {
    await Promise.all([
      mkdir(join(fixture.root, "indexer-envio"), { recursive: true }),
      mkdir(join(fixture.root, "ui-dashboard"), { recursive: true }),
    ]);
  }

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(join(fixture.root, "indexer-envio", ".env"), "RPC=value\n"),
    ),
  );
  assert.equal(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "equivalent ignored env files must normalize across worktrees",
  );
  await writeFile(
    join(second.root, "indexer-envio", ".env"),
    "RPC=different\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "different Envio dotenv content must change the shared key",
  );

  await writeFile(join(second.root, "indexer-envio", ".env"), "RPC=value\n");
  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        join(fixture.root, "ui-dashboard", ".env.local"),
        "NEXT_PUBLIC_HASURA_URL=http://fixture\n",
      ),
    ),
  );
  assert.equal(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
  );
  await writeFile(
    join(second.root, "ui-dashboard", ".env.local"),
    "NEXT_PUBLIC_HASURA_URL=http://different\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "different Next dotenv content must change the shared key",
  );

  await writeFile(
    join(second.root, "ui-dashboard", ".env.local"),
    "NEXT_PUBLIC_HASURA_URL=http://fixture\n",
  );
  await Promise.all([
    writeFile(
      join(first.root, "ui-dashboard", ".env.production.local.example"),
      "EXAMPLE=first\n",
    ),
    writeFile(
      join(second.root, "ui-dashboard", ".env.production.local.example"),
      "EXAMPLE=second\n",
    ),
  ]);
  assert.equal(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "tracked env examples must stay outside the ignored env manifest",
  );
});

test("material environment binds local wrappers and other selected values", async (t) => {
  const first = await materialEnvironmentFixture("wrapper-first");
  const second = await materialEnvironmentFixture("wrapper-second");
  const externalLinkRoot = await mkdtemp(
    join(tmpdir(), "quality-gate-external-link-"),
  );
  t.after(async () => {
    await Promise.all([
      rm(first.root, { recursive: true, force: true }),
      rm(second.root, { recursive: true, force: true }),
      rm(externalLinkRoot, { recursive: true, force: true }),
    ]);
  });

  const firstDigest = materialEnvironmentDigest(first);
  assert.equal(materialEnvironmentDigest(second), firstDigest);

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        fixture.wrapper,
        pnpmShellShim(fixture.physicalRoot, { lineEnding: "\r\n" }),
      ),
    ),
  );
  const firstCrlfDigest = materialEnvironmentDigest(first);
  assert.equal(
    materialEnvironmentDigest(second),
    firstCrlfDigest,
    "equivalent CRLF pnpm shims must normalize equally",
  );
  assert.notEqual(
    firstCrlfDigest,
    firstDigest,
    "wrapper line endings must remain material",
  );

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        fixture.wrapper,
        [
          "#!/bin/sh",
          `# unknown-equals=${fixture.physicalRoot}/external/tool.mjs`,
          `# unknown-colon:${fixture.physicalRoot}/external/tool.mjs`,
          "exit 0",
          "",
        ].join("\n"),
      ),
    ),
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "unknown wrapper text containing root-like tokens must remain raw",
  );

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        fixture.wrapper,
        pnpmShellShim(fixture.physicalRoot, {
          extraLines: [
            `# cmd-shim-target=${fixture.physicalRoot}/duplicate/tool.mjs`,
          ],
        }),
      ),
    ),
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "wrappers with duplicate target sentinels must remain raw",
  );

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        fixture.wrapper,
        pnpmShellShim(fixture.physicalRoot, {
          extraLines: [
            `# unknown-equals=${fixture.physicalRoot}`,
            `# unknown-colon:${fixture.physicalRoot}`,
          ],
        }),
      ),
    ),
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "recognized shims must keep exact-root unknown fields raw",
  );

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        fixture.wrapper,
        pnpmShellShim(fixture.physicalRoot, {
          target: `${fixture.physicalRoot}/node_modules/../external/tool.mjs`,
        }),
      ),
    ),
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "noncanonical target sentinels must remain raw",
  );

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        fixture.wrapper,
        pnpmShellShim(fixture.physicalRoot, {
          extraLines: [
            `  export NODE_PATH="${fixture.physicalRoot}/node_modules/../external"`,
          ],
        }),
      ),
    ),
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "noncanonical NODE_PATH segments must remain raw",
  );

  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(
        fixture.wrapper,
        pnpmShellShim(fixture.physicalRoot, {
          extraLines: [
            `# root-prefixed-external=${fixture.physicalRoot}-extra/tool.mjs`,
            `# embedded-external=/outside${fixture.physicalRoot}/tool.mjs`,
            `  export NODE_PATH="${fixture.physicalRoot}/node_modules:${fixture.physicalRoot}-extra/node_modules"`,
          ],
        }),
      ),
    ),
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "root-prefixed and embedded external paths must remain material",
  );
  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(fixture.wrapper, pnpmShellShim(fixture.physicalRoot)),
    ),
  );
  assert.equal(materialEnvironmentDigest(second), firstDigest);
  const withoutLocalBin = {
    pathEntries: [dirname(process.execPath), "/usr/bin"],
  };
  const firstWithoutLocalBin = materialEnvironmentDigest(
    first,
    withoutLocalBin,
  );
  assert.equal(
    materialEnvironmentDigest(second, withoutLocalBin),
    firstWithoutLocalBin,
    "the normalized manifest must be stable without a local-bin PATH entry",
  );

  await writeFile(
    second.wrapper,
    pnpmShellShim(second.physicalRoot, {
      target: `${second.physicalRoot}/node_modules/fixture-tool/bin/other.mjs`,
    }),
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    firstDigest,
    "normalized wrapper bytes must remain material",
  );
  assert.notEqual(
    materialEnvironmentDigest(second, withoutLocalBin),
    firstWithoutLocalBin,
    "wrapper bytes must remain material when PATH does not name local bin",
  );

  await writeFile(second.wrapper, pnpmShellShim(second.physicalRoot));
  await chmod(second.wrapper, 0o744);
  assert.notEqual(
    materialEnvironmentDigest(second),
    firstDigest,
    "wrapper mode must remain material",
  );

  await rm(second.wrapper);
  await symlink("../fixture-tool/bin/tool.mjs", second.wrapper);
  assert.notEqual(
    materialEnvironmentDigest(second),
    firstDigest,
    "wrapper type and symlink bytes must remain material",
  );

  await rm(first.wrapper);
  await symlink("../fixture-tool/bin/tool.mjs", first.wrapper);
  const firstSymlinkDigest = materialEnvironmentDigest(first);
  assert.equal(
    materialEnvironmentDigest(second),
    firstSymlinkDigest,
    "equivalent symlinks and dereferenced tool bytes must normalize equally",
  );
  await Promise.all(
    [first, second].map((fixture) =>
      writeFile(fixture.target, pnpmShellShim(fixture.physicalRoot)),
    ),
  );
  const firstDereferencedShimDigest = materialEnvironmentDigest(first);
  assert.equal(
    materialEnvironmentDigest(second),
    firstDereferencedShimDigest,
    "equivalent pnpm shim bytes behind symlinks must normalize equally",
  );
  await Promise.all(
    [first, second].map(async (fixture) => {
      await rm(fixture.wrapper);
      await symlink(
        join(
          fixture.physicalRoot,
          "node_modules",
          "fixture-tool",
          "bin",
          "tool.mjs",
        ),
        fixture.wrapper,
      );
    }),
  );
  const firstAbsoluteLinkDigest = materialEnvironmentDigest(first);
  assert.equal(
    materialEnvironmentDigest(second),
    firstAbsoluteLinkDigest,
    "canonical absolute link paths must normalize equally",
  );
  await Promise.all(
    [first, second].map(async (fixture) => {
      const traversalTarget = join(fixture.root, "traversal-tool.mjs");
      await writeFile(
        traversalTarget,
        "#!/usr/bin/env node\n// traversal tool\n",
      );
      await chmod(traversalTarget, 0o755);
      await rm(fixture.wrapper);
      await symlink(
        `${fixture.physicalRoot}/node_modules/../traversal-tool.mjs`,
        fixture.wrapper,
      );
    }),
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "noncanonical raw link paths must remain raw",
  );
  const externalLinks = await Promise.all(
    [first, second].map(async (fixture) => {
      const target = join(
        externalLinkRoot,
        `external=${fixture.physicalRoot}`,
        "tool.mjs",
      );
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "#!/usr/bin/env node\n// external tool\n");
      await chmod(target, 0o755);
      const link = relative(fixture.localBin, target);
      await rm(fixture.wrapper);
      await symlink(link, fixture.wrapper);
      return link;
    }),
  );
  assert.ok(
    externalLinks.every((link, index) =>
      link.includes(`=${[first, second][index].physicalRoot}/`),
    ),
    "the fixture must place the physical root after an equals sign",
  );
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "external relative link paths that contain worktree text must remain raw",
  );
  await Promise.all(
    [first, second].map(async (fixture) => {
      await rm(fixture.wrapper);
      await symlink("../fixture-tool/bin/tool.mjs", fixture.wrapper);
    }),
  );
  await writeFile(
    second.target,
    `#!/usr/bin/env node\n// other-tool-root=${second.physicalRoot}/node_modules/other-tool\n`,
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    materialEnvironmentDigest(first),
    "dereferenced executable bytes must remain material",
  );

  assert.notEqual(
    materialEnvironmentDigest(first, {
      extraEnvironment: { NODE_ENV: "production" },
    }),
    materialEnvironmentDigest(first, {
      extraEnvironment: { NODE_ENV: "test" },
    }),
    "selected non-path environment values must remain raw",
  );
});

test("local executable manifests reject unsafe roots and oversized files", async (t) => {
  const symlinkedRoot = await materialEnvironmentFixture("symlinked-root");
  const oversized = await materialEnvironmentFixture("oversized");
  t.after(async () => {
    await Promise.all([
      rm(symlinkedRoot.root, { recursive: true, force: true }),
      rm(oversized.root, { recursive: true, force: true }),
    ]);
  });

  const movedBin = join(symlinkedRoot.root, "node_modules", "real-bin");
  await rm(symlinkedRoot.localBin, { recursive: true });
  await mkdir(movedBin);
  await symlink("real-bin", symlinkedRoot.localBin);
  assert.throws(
    () => normalizedLocalBinManifest(symlinkedRoot.root),
    /must be a real directory/u,
  );

  await truncate(oversized.wrapper, LOCAL_BIN_MAX_FILE_BYTES + 1);
  assert.throws(
    () => normalizedLocalBinManifest(oversized.root),
    /per-file size limit/u,
  );
});

test("local executable manifests enforce entry and aggregate work bounds", async (t) => {
  const entryBound = await materialEnvironmentFixture("entry-bound");
  const aggregateBound = await materialEnvironmentFixture("aggregate-bound");
  t.after(async () => {
    await Promise.all([
      rm(entryBound.root, { recursive: true, force: true }),
      rm(aggregateBound.root, { recursive: true, force: true }),
    ]);
  });

  const secondEntry = join(entryBound.localBin, "second-tool");
  await writeFile(secondEntry, "second tool\n");
  assert.doesNotThrow(() =>
    normalizedLocalBinManifestForTest(entryBound.root, { maxEntries: 2 }),
  );
  assert.throws(
    () => normalizedLocalBinManifestForTest(entryBound.root, { maxEntries: 1 }),
    /entry limit/u,
  );

  const finalEntryName = "zz-budget-tool";
  const finalEntry = join(aggregateBound.localBin, finalEntryName);
  await writeFile(finalEntry, "budget tool\n");
  const totalBytes =
    Buffer.byteLength("fixture-tool") +
    readFileSync(aggregateBound.wrapper).length +
    Buffer.byteLength(finalEntryName) +
    readFileSync(finalEntry).length;
  assert.doesNotThrow(() =>
    normalizedLocalBinManifestForTest(aggregateBound.root, {
      maxEntries: 2,
      maxTotalBytes: totalBytes,
    }),
  );
  assert.throws(
    () =>
      normalizedLocalBinManifestForTest(aggregateBound.root, {
        maxEntries: 2,
        maxTotalBytes: totalBytes - 1,
      }),
    /byte limit/u,
  );
});
