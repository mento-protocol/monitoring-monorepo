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
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  INSTALLED_DEPENDENCY_MAX_FILE_BYTES,
  LOCAL_BIN_MAX_FILE_BYTES,
  MATERIAL_CWD_BOUND_ENVIRONMENT_NAMES,
  MATERIAL_EMPTY_COMPONENT_CWD_PATH_LIST_ENVIRONMENT_NAMES,
  MATERIAL_FOUNDRY_SOLC_ENVIRONMENT_NAMES,
  MATERIAL_JSON_PATH_LIST_ENVIRONMENT_NAMES,
  MATERIAL_PACKAGE_ROOTS,
  MATERIAL_PATH_LIST_ENVIRONMENT_NAMES,
  MATERIAL_SINGLE_PATH_ENVIRONMENT_NAMES,
  MATERIAL_STRUCTURED_PATH_ENVIRONMENT_NAMES,
  mappedChildScrubbedEnvironmentName,
  materialEnvironmentDigest as computeMaterialEnvironmentDigest,
  normalizedInstalledDependencyManifest,
  normalizedInstalledDependencyManifestForTest,
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
const repositoryRoot = join(gateDirectory, "..", "..");

test("local executable roots cover every tracked package", () => {
  const tracked = spawnSync(
    "git",
    ["ls-files", "package.json", "*/package.json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  assert.equal(tracked.status, 0, tracked.stderr);
  const packageRoots = tracked.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((path) => (path === "package.json" ? "" : dirname(path)))
    .sort();
  assert.deepEqual([...MATERIAL_PACKAGE_ROOTS].sort(), packageRoots);
});

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

const stableFixtureTime = new Date("2024-01-01T00:00:00.000Z");

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
  const packageRoot = join(
    root,
    "node_modules",
    ".pnpm",
    "fixture-tool",
    "node_modules",
    "fixture-tool",
  );
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    '{"name":"fixture-tool","version":"1.0.0"}\n',
  );
  await utimes(
    join(packageRoot, "package.json"),
    stableFixtureTime,
    stableFixtureTime,
  );
  await symlink(
    join(".pnpm", "fixture-tool", "node_modules", "fixture-tool"),
    join(root, "node_modules", "fixture-tool"),
  );
  await writeFile(wrapper, pnpmShellShim(physicalRoot));
  await chmod(wrapper, 0o755);
  const target = join(root, "node_modules", "fixture-tool", "bin", "tool.mjs");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "#!/usr/bin/env node\n// fixture tool\n");
  await chmod(target, 0o755);
  await utimes(target, stableFixtureTime, stableFixtureTime);
  const fixture = { root, physicalRoot, localBin, wrapper, target };
  await writeInstalledDependencyMetadata(fixture, "stable-install-time");
  return fixture;
}

async function writeInstalledDependencyMetadata(fixture, timestamp) {
  const nodeModules = join(fixture.root, "node_modules");
  await Promise.all([
    writeFile(
      join(nodeModules, ".modules.yaml"),
      JSON.stringify({
        layoutVersion: 5,
        nodeLinker: "isolated",
        packageManager: "pnpm@11.9.0",
        prunedAt: timestamp,
        storeDir: "/shared/pnpm/store/v11",
        virtualStoreDir: ".pnpm",
      }),
    ),
    writeFile(
      join(nodeModules, ".package-map.json"),
      JSON.stringify({
        packages: {
          ".": {
            dependencies: { react: "react@19.2.0" },
            url: "..",
          },
          "react@19.2.0": {
            dependencies: { react: "react@19.2.0" },
            url: "./.pnpm/react@19.2.0/node_modules/react",
          },
        },
      }),
    ),
    writeFile(
      join(nodeModules, ".pnpm-workspace-state-v1.json"),
      JSON.stringify({
        lastValidatedTimestamp: timestamp,
        projects: {
          [fixture.physicalRoot]: {
            name: "fixture-root",
          },
        },
        settings: {
          patchedDependencies: {
            react: join(fixture.physicalRoot, "patches", "react.patch"),
          },
        },
      }),
    ),
    writeFile(
      join(nodeModules, ".pnpm", "lock.yaml"),
      "lockfileVersion: '9.0'\nreact: 19.2.0\n",
    ),
  ]);
}

async function addInstalledReactLink(fixture) {
  const target = join(
    fixture.physicalRoot,
    "node_modules",
    ".pnpm",
    "react@19.2.0",
    "node_modules",
    "react",
  );
  const packageRoot = join(fixture.root, "ui-dashboard", "node_modules");
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"index.js"}\n',
  );
  await writeFile(join(target, "index.js"), "export const fixture = true;\n");
  await Promise.all([
    utimes(join(target, "package.json"), stableFixtureTime, stableFixtureTime),
    utimes(join(target, "index.js"), stableFixtureTime, stableFixtureTime),
  ]);
  await mkdir(packageRoot, { recursive: true });
  await symlink(target, join(packageRoot, "react"));
  return { link: join(packageRoot, "react"), target };
}

async function addWorkspacePackageLink(fixture) {
  const target = join(fixture.physicalRoot, "shared-config");
  const dist = join(target, "dist");
  const scope = join(fixture.root, "ui-dashboard", "node_modules", "@fixture");
  await Promise.all([
    mkdir(dist, { recursive: true }),
    mkdir(scope, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(target, "package.json"),
      `${JSON.stringify({
        name: "@fixture/workspace",
        exports: {
          "./generated": {
            types: "./dist/generated.d.ts",
            default: "./dist/generated.js",
          },
        },
      })}\n`,
    ),
    writeFile(join(dist, "generated.js"), "export const fixture = true;\n"),
    writeFile(
      join(dist, "generated.d.ts"),
      "export declare const fixture: true;\n",
    ),
  ]);
  const link = join(scope, "workspace");
  await symlink(target, link);
  return { dist, link, target };
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

function directMaterialEnvironmentDigest(fixture, extraEnvironment = {}) {
  return computeMaterialEnvironmentDigest({
    repoRoot: fixture.root,
    workingDirectory: fixture.root,
    environment: {
      LANG: "C",
      LC_ALL: "C",
      PATH: [
        fixture.localBin,
        dirname(process.execPath),
        "/usr/bin",
        fixture.localBin,
      ].join(delimiter),
      INIT_CWD: fixture.root,
      PNPM_SCRIPT_SRC_DIR: fixture.root,
      ...extraEnvironment,
    },
  });
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
  assert.equal(
    materialEnvironmentDigest(first, {
      extraEnvironment: { TMPDIR: join(".tmp", "agent-quality-gate") },
    }),
    materialEnvironmentDigest(second, {
      extraEnvironment: { TMPDIR: join(".tmp", "agent-quality-gate") },
    }),
    "the relative gate temp fallback must normalize across worktrees",
  );

  for (const name of MATERIAL_SINGLE_PATH_ENVIRONMENT_NAMES.filter(
    (name) =>
      ![
        "TERRAFORM_CONFIG",
        "TF_CLI_CONFIG_FILE",
        "TF_PLUGIN_CACHE_DIR",
      ].includes(name),
  )) {
    assert.notEqual(
      directMaterialEnvironmentDigest(first, {
        [name]: join("..", "material-input"),
      }),
      directMaterialEnvironmentDigest(second, {
        [name]: join("..", "material-input"),
      }),
      `a relative ${name} must bind the physical worktree`,
    );
    assert.equal(
      directMaterialEnvironmentDigest(first, {
        [name]: "/tmp/shared-material-input",
      }),
      directMaterialEnvironmentDigest(second, {
        [name]: "/tmp/shared-material-input",
      }),
      `an absolute ${name} may coalesce across worktrees`,
    );
  }
  assert.notEqual(
    directMaterialEnvironmentDigest(first, {
      NODE_ICU_DATA: join("..", "shared-icu-data"),
    }),
    directMaterialEnvironmentDigest(second, {
      NODE_ICU_DATA: join("..", "shared-icu-data"),
    }),
    "a relative NODE_ICU_DATA must bind the physical worktree",
  );
  assert.notEqual(
    directMaterialEnvironmentDigest(first, {
      NODE_ICU_DATA: "/tmp/shared-icu-data-a",
    }),
    directMaterialEnvironmentDigest(first, {
      NODE_ICU_DATA: "/tmp/shared-icu-data-b",
    }),
    "different absolute NODE_ICU_DATA values must remain material",
  );
  for (const name of [
    "AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE",
    "AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE",
    "AGENT_QUALITY_GATE_TEST_DRAIN_REFRESH_BARRIER",
    "AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER",
    "CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER",
    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER",
    "TF_STACKS_TEST_GIT_LOG",
    "TF_STACKS_TEST_PLAN_MODE_LOG",
    "TF_STACKS_TEST_TERRAFORM_CWD_LOG",
    "TF_STACKS_TEST_TERRAFORM_ENV_LOG",
    "TF_STACKS_TEST_TERRAFORM_LOG",
  ]) {
    assert.notEqual(
      directMaterialEnvironmentDigest(first, {
        [name]: join("..", "pattern-material-input"),
      }),
      directMaterialEnvironmentDigest(second, {
        [name]: join("..", "pattern-material-input"),
      }),
      `a relative pattern-classified ${name} must bind the physical worktree`,
    );
    assert.equal(
      directMaterialEnvironmentDigest(first, {
        [name]: "/tmp/shared-pattern-material-input",
      }),
      directMaterialEnvironmentDigest(second, {
        [name]: "/tmp/shared-pattern-material-input",
      }),
      `an absolute pattern-classified ${name} may coalesce across worktrees`,
    );
  }
  for (const name of MATERIAL_PATH_LIST_ENVIRONMENT_NAMES.filter(
    (entry) => entry !== "PATH",
  )) {
    const relativeList = [
      "/tmp/shared-material-a",
      join("..", "material-input"),
      "/tmp/shared-material-b",
    ].join(delimiter);
    const absoluteList = [
      "/tmp/shared-material-a",
      "/tmp/shared-material-input",
      "/tmp/shared-material-b",
    ].join(delimiter);
    assert.notEqual(
      directMaterialEnvironmentDigest(first, { [name]: relativeList }),
      directMaterialEnvironmentDigest(second, { [name]: relativeList }),
      `a relative ${name} component must bind the physical worktree`,
    );
    assert.equal(
      directMaterialEnvironmentDigest(first, { [name]: absoluteList }),
      directMaterialEnvironmentDigest(second, { [name]: absoluteList }),
      `absolute ${name} components may coalesce across worktrees`,
    );
  }
  assert.notEqual(
    directMaterialEnvironmentDigest(first, {
      LD_PRELOAD: "/tmp/shared-preload relative-preload.so",
    }),
    directMaterialEnvironmentDigest(second, {
      LD_PRELOAD: "/tmp/shared-preload relative-preload.so",
    }),
    "a whitespace-separated relative LD_PRELOAD component must bind the physical worktree",
  );
  for (const name of MATERIAL_EMPTY_COMPONENT_CWD_PATH_LIST_ENVIRONMENT_NAMES) {
    const listWithEmptyComponent = [
      "/tmp/shared-loader-a",
      "",
      "/tmp/shared-loader-b",
    ].join(delimiter);
    assert.notEqual(
      directMaterialEnvironmentDigest(first, {
        [name]: listWithEmptyComponent,
      }),
      directMaterialEnvironmentDigest(second, {
        [name]: listWithEmptyComponent,
      }),
      `an empty ${name} component must bind the physical worktree`,
    );
  }
  for (const name of ["DYLD_INSERT_LIBRARIES", "LD_AUDIT", "LD_PRELOAD"]) {
    const listWithIgnoredEmptyComponent = [
      "/tmp/shared-loader-a",
      "",
      "/tmp/shared-loader-b",
    ].join(delimiter);
    assert.equal(
      directMaterialEnvironmentDigest(first, {
        [name]: listWithIgnoredEmptyComponent,
      }),
      directMaterialEnvironmentDigest(second, {
        [name]: listWithIgnoredEmptyComponent,
      }),
      `an empty ${name} file-list component must remain ignored`,
    );
  }
  for (const name of MATERIAL_JSON_PATH_LIST_ENVIRONMENT_NAMES) {
    const relativeList = JSON.stringify([
      "/tmp/shared-material-a",
      join("..", "material-input"),
    ]);
    const absoluteList = JSON.stringify([
      "/tmp/shared-material-a",
      "/tmp/shared-material-b",
    ]);
    assert.notEqual(
      directMaterialEnvironmentDigest(first, { [name]: relativeList }),
      directMaterialEnvironmentDigest(second, { [name]: relativeList }),
      `a relative ${name} member must bind the physical worktree`,
    );
    assert.equal(
      directMaterialEnvironmentDigest(first, { [name]: absoluteList }),
      directMaterialEnvironmentDigest(second, { [name]: absoluteList }),
      `absolute ${name} members may coalesce across worktrees`,
    );
  }
  const structuredPathCases = {
    FOUNDRY_FS_PERMISSIONS: {
      absolute: JSON.stringify([
        { access: "read", path: "/tmp/shared-foundry-data" },
      ]),
      relative: JSON.stringify([{ access: "read", path: "../foundry-data" }]),
    },
    FOUNDRY_LIBRARIES: {
      absolute:
        "/tmp/Shared.sol:Shared:0x0000000000000000000000000000000000000001",
      relative:
        "../Shared.sol:Shared:0x0000000000000000000000000000000000000001",
    },
    FOUNDRY_REMAPPINGS: {
      absolute: "shared/=/tmp/shared-foundry-lib/",
      relative: "shared/=../shared-foundry-lib/",
    },
  };
  assert.deepEqual(
    Object.keys(structuredPathCases).sort(),
    [...MATERIAL_STRUCTURED_PATH_ENVIRONMENT_NAMES].sort(),
  );
  for (const [name, values] of Object.entries(structuredPathCases)) {
    assert.notEqual(
      directMaterialEnvironmentDigest(first, { [name]: values.relative }),
      directMaterialEnvironmentDigest(second, { [name]: values.relative }),
      `a relative ${name} member must bind the physical worktree`,
    );
    assert.equal(
      directMaterialEnvironmentDigest(first, { [name]: values.absolute }),
      directMaterialEnvironmentDigest(second, { [name]: values.absolute }),
      `absolute ${name} members may coalesce across worktrees`,
    );
  }
  assert.notEqual(
    directMaterialEnvironmentDigest(first, {
      FOUNDRY_FS_PERMISSIONS: '[{ access = "read", path = "../foundry-data" }]',
    }),
    directMaterialEnvironmentDigest(second, {
      FOUNDRY_FS_PERMISSIONS: '[{ access = "read", path = "../foundry-data" }]',
    }),
    "a TOML-style relative FOUNDRY_FS_PERMISSIONS path must bind the physical worktree",
  );
  for (const name of MATERIAL_CWD_BOUND_ENVIRONMENT_NAMES) {
    assert.notEqual(
      directMaterialEnvironmentDigest(first, {
        [name]: "--fixture ../material-input",
      }),
      directMaterialEnvironmentDigest(second, {
        [name]: "--fixture ../material-input",
      }),
      `a nonempty ${name} must conservatively bind the physical worktree`,
    );
    assert.equal(
      directMaterialEnvironmentDigest(first, { [name]: "" }),
      directMaterialEnvironmentDigest(second, { [name]: "" }),
      `an empty ${name} must not bind the physical worktree`,
    );
  }
  assert.notEqual(
    directMaterialEnvironmentDigest(first, { VITEST_DEBUG_DUMP: "true" }),
    directMaterialEnvironmentDigest(second, { VITEST_DEBUG_DUMP: "true" }),
    "VITEST_DEBUG_DUMP=true must conservatively bind the physical worktree",
  );
  for (const name of [
    "FOUNDRY_IGNORED_ERROR_CODES_FROM",
    "FOUNDRY_IGNORED_WARNINGS_FROM",
  ]) {
    assert.notEqual(
      directMaterialEnvironmentDigest(first, { [name]: "[]" }),
      directMaterialEnvironmentDigest(second, { [name]: "[]" }),
      `a nonempty ${name} must conservatively bind the physical worktree`,
    );
  }
  for (const name of ["TF_CLI_ARGS", "TF_CLI_ARGS_plan"]) {
    assert.notEqual(
      directMaterialEnvironmentDigest(first, { [name]: "-chdir=../terraform" }),
      directMaterialEnvironmentDigest(second, {
        [name]: "-chdir=../terraform",
      }),
      `a nonempty ${name} must conservatively bind the physical worktree`,
    );
  }
  for (const name of MATERIAL_FOUNDRY_SOLC_ENVIRONMENT_NAMES) {
    for (const value of [join("..", "bin", "solc"), "local-solc"]) {
      assert.notEqual(
        directMaterialEnvironmentDigest(first, { [name]: value }),
        directMaterialEnvironmentDigest(second, { [name]: value }),
        `relative ${name}=${value} must bind the physical worktree`,
      );
    }
    assert.equal(
      directMaterialEnvironmentDigest(first, { [name]: "/tmp/shared-solc" }),
      directMaterialEnvironmentDigest(second, { [name]: "/tmp/shared-solc" }),
      `an absolute ${name} may coalesce across worktrees`,
    );
    for (const value of [
      "auto",
      "0.8.24",
      "solc:0.8.24",
      "0.8.24+commit.e11b9ed9",
    ]) {
      assert.equal(
        directMaterialEnvironmentDigest(first, { [name]: value }),
        directMaterialEnvironmentDigest(second, { [name]: value }),
        `${name}=${value} must remain a compiler selector`,
      );
    }
  }
  for (const [name, value] of [
    ["COREPACK_ENV_FILE", "0"],
    ["GOENV", "off"],
    ["PLAYWRIGHT_BROWSERS_PATH", "0"],
  ]) {
    assert.equal(
      directMaterialEnvironmentDigest(first, { [name]: value }),
      directMaterialEnvironmentDigest(second, { [name]: value }),
      `${name}=${value} must remain a non-path sentinel`,
    );
  }
  assert.equal(
    directMaterialEnvironmentDigest(first, {
      NEXT_PUBLIC_ASSET_PATH: join("..", "asset"),
    }),
    directMaterialEnvironmentDigest(second, {
      NEXT_PUBLIC_ASSET_PATH: join("..", "asset"),
    }),
    "an arbitrary prefix-selected scalar must remain raw",
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
  for (const relativeEntry of ["", ".", join(".tmp", "bin")]) {
    assert.notEqual(
      materialEnvironmentDigest(first, {
        pathEntries: [relativeEntry, dirname(process.execPath), "/usr/bin"],
      }),
      materialEnvironmentDigest(second, {
        pathEntries: [relativeEntry, dirname(process.execPath), "/usr/bin"],
      }),
      `${relativeEntry || "empty"} PATH entries must bind the physical worktree`,
    );
  }
  assert.equal(
    materialEnvironmentDigest(first, { pnpmScriptSource: "." }),
    materialEnvironmentDigest(second, { pnpmScriptSource: "." }),
    "a relative root PNPM_SCRIPT_SRC_DIR must normalize across worktrees",
  );
  assert.notEqual(
    materialEnvironmentDigest(second, {
      pnpmScriptSource: join(second.root, "nested-package"),
    }),
    firstDigest,
    "a non-root PNPM_SCRIPT_SRC_DIR must remain raw",
  );
  assert.equal(
    materialEnvironmentDigest(first, { initCwd: "." }),
    materialEnvironmentDigest(second, { initCwd: "." }),
    "a relative root INIT_CWD must normalize across worktrees",
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
    "APPDATA",
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
    "TERRAFORM_CONFIG",
    "TF_CLI_CONFIG_FILE",
    "TF_PLUGIN_CACHE_DIR",
    "TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE",
    "TF_REATTACH_PROVIDERS",
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

test("material environment binds package-local executables", async (t) => {
  const first = await materialEnvironmentFixture("package-bin-first");
  const second = await materialEnvironmentFixture("package-bin-second");
  t.after(async () => {
    await Promise.all([
      rm(first.root, { recursive: true, force: true }),
      rm(second.root, { recursive: true, force: true }),
    ]);
  });

  const packageWrappers = await Promise.all(
    [first, second].map(async (fixture) => {
      const localBin = join(
        fixture.root,
        "ui-dashboard",
        "node_modules",
        ".bin",
      );
      const wrapper = join(localBin, "package-tool");
      await mkdir(localBin, { recursive: true });
      await writeFile(wrapper, pnpmShellShim(fixture.physicalRoot));
      await chmod(wrapper, 0o755);
      return wrapper;
    }),
  );
  assert.equal(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "equivalent package-local executables must normalize across worktrees",
  );
  assert.equal(
    materialEnvironmentDigest(first, {
      pathEntries: [
        dirname(packageWrappers[0]),
        first.localBin,
        dirname(process.execPath),
      ],
    }),
    materialEnvironmentDigest(second, {
      pathEntries: [
        dirname(packageWrappers[1]),
        second.localBin,
        dirname(process.execPath),
      ],
    }),
    "package-local PATH entries must normalize across worktrees",
  );
  const relativePackageBin = join("ui-dashboard", "node_modules", ".bin");
  assert.equal(
    materialEnvironmentDigest(first, {
      pathEntries: [relativePackageBin, dirname(process.execPath)],
    }),
    materialEnvironmentDigest(second, {
      pathEntries: [relativePackageBin, dirname(process.execPath)],
    }),
    "relative package-local PATH entries must normalize across worktrees",
  );

  const rogueWrapper = join(dirname(packageWrappers[1]), "rogue-shadow");
  await writeFile(rogueWrapper, "#!/bin/sh\nexit 9\n");
  await chmod(rogueWrapper, 0o755);
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "an unexpected package-local executable must remain material",
  );
  await rm(rogueWrapper);

  await writeFile(packageWrappers[1], "#!/bin/sh\nexit 9\n");
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "package-local executable bytes must remain material",
  );
  await rm(dirname(packageWrappers[1]), { recursive: true });
  assert.notEqual(
    materialEnvironmentDigest(first),
    materialEnvironmentDigest(second),
    "a missing package-local executable root must remain material without setup",
  );
});

test("material environment binds installed dependency state and package links", async (t) => {
  const first = await materialEnvironmentFixture("dependency-first");
  const second = await materialEnvironmentFixture("dependency-second");
  t.after(async () => {
    await Promise.all([
      rm(first.root, { recursive: true, force: true }),
      rm(second.root, { recursive: true, force: true }),
    ]);
  });
  await Promise.all([
    writeInstalledDependencyMetadata(first, "first-install-time"),
    writeInstalledDependencyMetadata(second, "second-install-time"),
  ]);
  const [firstReact, secondReact] = await Promise.all([
    addInstalledReactLink(first),
    addInstalledReactLink(second),
  ]);
  const [firstWorkspace, secondWorkspace] = await Promise.all([
    addWorkspacePackageLink(first),
    addWorkspacePackageLink(second),
  ]);

  assert.equal(
    normalizedInstalledDependencyManifest(second.root),
    normalizedInstalledDependencyManifest(first.root),
    "equivalent installed dependency manifests must normalize across worktrees",
  );
  const baseline = materialEnvironmentDigest(first);
  assert.equal(
    materialEnvironmentDigest(second),
    baseline,
    "equivalent metadata and absolute package links must normalize across worktrees",
  );

  await writeFile(
    join(secondWorkspace.dist, "generated.js"),
    "export const fixture = null;\n",
  );
  assert.equal(
    materialEnvironmentDigest(second),
    baseline,
    "workspace setup output must stay outside the pre-setup shared key",
  );
  await writeFile(
    join(secondWorkspace.dist, "generated.js"),
    "export const fixture = true;\n",
  );
  assert.equal(materialEnvironmentDigest(second), baseline);

  await rm(join(secondWorkspace.dist, "generated.d.ts"));
  assert.equal(
    materialEnvironmentDigest(second),
    baseline,
    "a missing workspace setup output must stay outside the pre-setup shared key",
  );
  await writeFile(
    join(secondWorkspace.dist, "generated.d.ts"),
    "export declare const fixture: true;\n",
  );
  assert.equal(materialEnvironmentDigest(second), baseline);

  await rm(secondReact.link);
  assert.notEqual(
    materialEnvironmentDigest(second),
    baseline,
    "a missing package-local dependency link must change the shared key",
  );
  await symlink(secondReact.target, secondReact.link);
  assert.equal(materialEnvironmentDigest(second), baseline);

  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.1","main":"index.js"}\n',
  );
  await utimes(
    join(secondReact.target, "package.json"),
    stableFixtureTime,
    stableFixtureTime,
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    baseline,
    "changed installed package metadata must change the shared key",
  );
  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"index.js"}\n',
  );
  await utimes(
    join(secondReact.target, "package.json"),
    stableFixtureTime,
    stableFixtureTime,
  );
  assert.equal(materialEnvironmentDigest(second), baseline);

  await writeFile(
    join(secondReact.target, "index.js"),
    "export const fixture = null;\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    baseline,
    "a same-size installed payload mutation must change its generation",
  );
  await writeFile(
    join(secondReact.target, "index.js"),
    "export const fixture = true;\n",
  );
  await utimes(
    join(secondReact.target, "index.js"),
    stableFixtureTime,
    stableFixtureTime,
  );
  assert.equal(materialEnvironmentDigest(second), baseline);

  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0"}\n',
  );
  const defaultEntrypointBaseline = materialEnvironmentDigest(second);
  await writeFile(
    join(secondReact.target, "index.js"),
    "export const fixture = null;\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    defaultEntrypointBaseline,
    "a package without main must bind its implicit index file",
  );
  await writeFile(
    join(secondReact.target, "index.js"),
    "export const fixture = true;\n",
  );
  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"missing"}\n',
  );
  const missingMainBaseline = materialEnvironmentDigest(second);
  await writeFile(
    join(secondReact.target, "index.js"),
    "export const fixture = null;\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    missingMainBaseline,
    "an unresolved main must bind the implicit index fallback",
  );
  await writeFile(
    join(secondReact.target, "index.js"),
    "export const fixture = true;\n",
  );

  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","browser":"browser.js"}\n',
  );
  await writeFile(
    join(secondReact.target, "browser.js"),
    "export const fixture = true;\n",
  );
  const bareBrowserEntrypointBaseline = materialEnvironmentDigest(second);
  await writeFile(
    join(secondReact.target, "browser.js"),
    "export const fixture = null;\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    bareBrowserEntrypointBaseline,
    "a bare browser entrypoint must bind its payload bytes",
  );
  await rm(join(secondReact.target, "browser.js"));

  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"lib"}\n',
  );
  await mkdir(join(secondReact.target, "lib"));
  await writeFile(
    join(secondReact.target, "lib", "index.js"),
    "export const fixture = true;\n",
  );
  const directoryEntrypointBaseline = materialEnvironmentDigest(second);
  await writeFile(
    join(secondReact.target, "lib", "index.js"),
    "export const fixture = null;\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    directoryEntrypointBaseline,
    "a directory main must bind the index file Node resolves",
  );
  await rm(join(secondReact.target, "lib"), { recursive: true });

  await mkdir(join(secondReact.target, "entry-directory"));
  await writeFile(
    join(secondReact.target, "entry-directory", "package.json"),
    '{"type":"module"}\n',
  );
  await writeFile(
    join(secondReact.target, "entry-directory", "index.js"),
    "export const fixture = true;\n",
  );
  await symlink("entry-directory", join(secondReact.target, "entry-link"));
  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"entry-link"}\n',
  );
  const directorySymlinkBaseline = materialEnvironmentDigest(second);
  await writeFile(
    join(secondReact.target, "entry-directory", "index.js"),
    "export const fixture = null;\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    directorySymlinkBaseline,
    "a directory symlink entrypoint must bind its resolved index file",
  );
  await writeFile(
    join(secondReact.target, "entry-directory", "index.js"),
    "export const fixture = true;\n",
  );
  await writeFile(
    join(secondReact.target, "entry-directory", "package.json"),
    '{"type":"commonjs"}\n',
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    directorySymlinkBaseline,
    "directory resolution must bind the nested package manifest",
  );
  await Promise.all([
    rm(join(secondReact.target, "entry-link")),
    rm(join(secondReact.target, "entry-directory"), { recursive: true }),
  ]);

  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"dist/entry"}\n',
  );
  await mkdir(join(secondReact.target, "dist"));
  const extensionPayload = "export const fixture = true;\n";
  await writeFile(
    join(secondReact.target, "dist", "entry.js"),
    extensionPayload,
  );
  const extensionBaseline = materialEnvironmentDigest(second);
  await rm(join(secondReact.target, "dist", "entry.js"));
  await writeFile(
    join(secondReact.target, "dist", "entry.json"),
    extensionPayload,
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    extensionBaseline,
    "the resolved entrypoint extension must remain material",
  );
  await rm(join(secondReact.target, "dist"), { recursive: true });

  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"entry-link.js"}\n',
  );
  await writeFile(
    join(secondReact.target, "entry-target.js"),
    "export const fixture = true;\n",
  );
  await symlink("entry-target.js", join(secondReact.target, "entry-link.js"));
  const symlinkEntrypointBaseline = materialEnvironmentDigest(second);
  await writeFile(
    join(secondReact.target, "entry-target.js"),
    "export const fixture = null;\n",
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    symlinkEntrypointBaseline,
    "a symlink entrypoint must bind its target content",
  );
  await Promise.all([
    rm(join(secondReact.target, "entry-link.js")),
    rm(join(secondReact.target, "entry-target.js")),
  ]);
  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"index.js"}\n',
  );
  assert.equal(materialEnvironmentDigest(second), baseline);

  await rm(join(secondReact.target, "index.js"));
  assert.notEqual(
    materialEnvironmentDigest(second),
    baseline,
    "a missing installed package payload must change the shared key",
  );
  await writeFile(
    join(secondReact.target, "index.js"),
    "export const fixture = true;\n",
  );
  await utimes(
    join(secondReact.target, "index.js"),
    stableFixtureTime,
    stableFixtureTime,
  );
  assert.equal(materialEnvironmentDigest(second), baseline);

  await rm(join(secondReact.target, "package.json"));
  assert.throws(
    () => materialEnvironmentDigest(second),
    /installed dependency package manifest is missing/u,
    "a package link without package.json must fail closed",
  );
  await writeFile(
    join(secondReact.target, "package.json"),
    '{"name":"react","version":"19.2.0","main":"index.js"}\n',
  );
  await utimes(
    join(secondReact.target, "package.json"),
    stableFixtureTime,
    stableFixtureTime,
  );
  assert.equal(materialEnvironmentDigest(second), baseline);

  await rm(join(second.root, "node_modules", ".modules.yaml"));
  assert.throws(
    () => materialEnvironmentDigest(second),
    /installed dependency metadata is missing/u,
    "missing pnpm installation metadata must fail closed",
  );
  await writeInstalledDependencyMetadata(second, "second-install-time");
  assert.equal(materialEnvironmentDigest(second), baseline);

  await writeFile(
    join(second.root, "node_modules", ".package-map.json"),
    JSON.stringify({ packages: { ".": { dependencies: {} } } }),
  );
  assert.notEqual(
    materialEnvironmentDigest(second),
    baseline,
    "changed pnpm installation metadata must change the shared key",
  );
  assert.equal(
    await realpath(firstReact.link),
    firstReact.target,
    "the first dependency link must remain usable after hashing",
  );
  assert.equal(
    await realpath(firstWorkspace.link),
    firstWorkspace.target,
    "the first workspace dependency link must remain usable after hashing",
  );
});

test("installed dependency manifests enforce entry and file bounds", async (t) => {
  const fixture = await materialEnvironmentFixture("dependency-bounds");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  assert.doesNotThrow(() =>
    normalizedInstalledDependencyManifestForTest(fixture.root, {
      maxEntries: 12,
    }),
  );
  assert.throws(
    () =>
      normalizedInstalledDependencyManifestForTest(fixture.root, {
        maxEntries: 11,
      }),
    /entry limit/u,
  );
  assert.throws(
    () =>
      normalizedInstalledDependencyManifestForTest(fixture.root, {
        maxTotalBytes: 1,
      }),
    /manifest exceeds its byte limit/u,
  );
  await writeFile(
    join(fixture.root, "node_modules", ".package-map.json"),
    "x".repeat(INSTALLED_DEPENDENCY_MAX_FILE_BYTES + 1),
  );
  assert.throws(
    () => normalizedInstalledDependencyManifestForTest(fixture.root, {}),
    /per-file size limit/u,
  );
});

test("local executable manifests reject unsafe roots and oversized files", async (t) => {
  const symlinkedRoot = await materialEnvironmentFixture("symlinked-root");
  const symlinkedPackage =
    await materialEnvironmentFixture("symlinked-package");
  const oversized = await materialEnvironmentFixture("oversized");
  t.after(async () => {
    await Promise.all([
      rm(symlinkedRoot.root, { recursive: true, force: true }),
      rm(symlinkedPackage.root, { recursive: true, force: true }),
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

  const packageNodeModules = join(
    symlinkedPackage.root,
    "ui-dashboard",
    "node_modules",
  );
  const packageRealBin = join(packageNodeModules, "real-bin");
  await mkdir(packageRealBin, { recursive: true });
  await symlink("real-bin", join(packageNodeModules, ".bin"));
  assert.throws(
    () => normalizedLocalBinManifest(symlinkedPackage.root),
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
  const packageBin = join(
    entryBound.root,
    "ui-dashboard",
    "node_modules",
    ".bin",
  );
  await mkdir(packageBin, { recursive: true });
  await writeFile(join(packageBin, "package-tool"), "package tool\n");
  assert.doesNotThrow(() =>
    normalizedLocalBinManifestForTest(entryBound.root, { maxEntries: 3 }),
  );
  assert.throws(
    () => normalizedLocalBinManifestForTest(entryBound.root, { maxEntries: 2 }),
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
