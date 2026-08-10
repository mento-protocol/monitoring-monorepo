import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parse as parseToml } from "smol-toml";
import {
  buildUpstashMcpRuntime,
  prepareUpstashMcpRuntime,
} from "./build-upstash-mcp-runtime.mjs";
import {
  createTerminationForwarder,
  UPSTASH_MCP_ENTRYPOINT_SHA256,
  UPSTASH_MCP_RUNTIME_LOADER,
  UPSTASH_MCP_RUNTIME_SHA256,
  verifyUpstashMcpEntrypoint,
  verifyUpstashMcpRuntime,
} from "./upstash-mcp-launcher.mjs";
import {
  buildLauncherVerifier,
  renderLocalUpstashMcpConfig,
  renderUpstashMcpConfig,
  UPSTASH_MCP_LAUNCHER_SHA256,
  verifyUpstashMcpLauncher,
} from "./render-upstash-mcp-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@upstash/mcp-server";
const PACKAGE_VERSION = "0.2.4";
const ESBUILD_VERSION = "0.28.1";
const PINNED_PACKAGE = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
const PACKAGE_INTEGRITY =
  "sha512-LN5yao74QQZTjGmolGqAh9YkQa/206ni94wwTtu6I/mVkyMeAbRME7rjK64KrWmCTw2OHUb8TMFsw6r4rMmUSQ==";
const LAUNCHER_NAME = "scripts/upstash-mcp-launcher.mjs";
const EXPECTED_ENV_VARS = ["UPSTASH_EMAIL", "UPSTASH_API_KEY"];
const EXPECTED_TOOLS = [
  "redis_database_list_databases",
  "redis_database_run_redis_commands",
];

async function executeRuntimeSnapshot(runtimeBytes, ...args) {
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        UPSTASH_MCP_RUNTIME_LOADER,
        "--",
        ...args,
      ],
      { encoding: "utf8", env: {}, stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectExecution);
    child.once("close", (code, signal) => {
      resolveExecution({ code, signal, stderr, stdout });
    });
    child.stdio[3].once("error", rejectExecution);
    child.stdio[3].end(runtimeBytes);
  });
}

function tomlArray(source, key) {
  const match = source.match(
    new RegExp(`^${key}\\s*=\\s*(\\[[\\s\\S]*?\\])`, "m"),
  );
  assert.ok(match, `missing ${key} array`);
  return JSON.parse(match[1].replace(/,\s*]/g, "]"));
}

function tomlString(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*(".*")$`, "m"));
  assert.ok(match, `missing ${key} string`);
  return JSON.parse(match[1]);
}

function assertPersonalExample(source) {
  assert.match(source, /^\[mcp_servers\.upstash\]$/m);
  assert.match(source, /^enabled\s*=\s*false$/m);
  assert.match(source, /^default_tools_approval_mode\s*=\s*"prompt"$/m);
  assert.match(
    source,
    /^\[mcp_servers\.upstash\.tools\.redis_database_run_redis_commands\]$/m,
  );
  assert.match(source, /^approval_mode\s*=\s*"prompt"$/m);
  const command = tomlString(source, "command");
  const args = tomlArray(source, "args");
  assert.ok(isAbsolute(command), "Node executable must use an absolute path");
  assert.equal(args.length, 3);
  assert.deepEqual(args.slice(0, 2), ["--input-type=module", "--eval"]);
  const verifier = args[2];
  const launcherPathMatch = verifier.match(/^const launcherPath = (".*");$/m);
  const launcherSha256Match = verifier.match(
    /^const expectedSha256 = "([0-9a-f]{64})";$/m,
  );
  const runtimePathMatch = verifier.match(/^const runtimePath = (".*");$/m);
  assert.ok(launcherPathMatch, "verifier must pin the launcher path");
  assert.ok(launcherSha256Match, "verifier must pin the launcher SHA-256");
  assert.ok(runtimePathMatch, "verifier must pin the personal runtime path");
  const launcherPath = JSON.parse(launcherPathMatch[1]);
  const runtimePath = JSON.parse(runtimePathMatch[1]);
  assert.ok(isAbsolute(launcherPath), "launcher path must be absolute");
  assert.ok(launcherPath.endsWith(LAUNCHER_NAME));
  assert.ok(isAbsolute(runtimePath), "runtime path must be absolute");
  assert.ok(runtimePath.endsWith(".mjs"));
  assert.ok(
    verifier.indexOf("readFileSync(launcherPath)") <
      verifier.indexOf("await import("),
    "verifier must hash the launcher before importing checkout code",
  );
  assert.match(verifier, /await import\(launcherUrl\)/);
  assert.deepEqual(tomlArray(source, "env_vars"), EXPECTED_ENV_VARS);
  assert.deepEqual(tomlArray(source, "enabled_tools"), EXPECTED_TOOLS);

  assert.doesNotMatch(source, /@upstash\/mcp-server@latest/);
  assert.doesNotMatch(
    source,
    /node_modules\/@upstash\/mcp-server\/dist\/index\.js/,
  );
  assert.doesNotMatch(source, /\bnpx\b/);
  assert.doesNotMatch(source, /\bpnpm\s+(?:dlx|exec)\b/);
  assert.doesNotMatch(source, /(?:--email|--api-key|--box-api-key)/);
  assert.doesNotMatch(source, /^env\s*=/m);
  assert.doesNotMatch(source, /^\[mcp_servers\.upstash\.env\]$/m);
  assert.doesNotMatch(source, /UPSTASH_(?:EMAIL|API_KEY)\s*=/);

  return {
    command,
    launcherPath,
    launcherSha256: launcherSha256Match[1],
    runtimePath,
    verifier,
  };
}

function assertCloudSafeProjectConfig(source) {
  const config = parseToml(source);
  assert.equal(
    config.mcp_servers?.upstash,
    undefined,
    "shared project config must omit the local credentialed Upstash server",
  );
}

test("personal Upstash MCP example pins and redacts the reviewed transport", async () => {
  const source = await readFile(
    resolve(ROOT, ".codex/upstash-mcp.example.toml"),
    "utf8",
  );
  assertPersonalExample(source);
});

test("renderer anchors executables and prepares the reviewed personal runtime", async () => {
  const runtimeDirectory = await mkdtemp(
    resolve(tmpdir(), "upstash-mcp-personal-runtime-"),
  );
  try {
    const source = await renderLocalUpstashMcpConfig({ runtimeDirectory });
    const contract = assertPersonalExample(source);
    assert.equal(contract.command, resolve(contract.command));
    assert.equal(contract.launcherPath, resolve(ROOT, LAUNCHER_NAME));
    assert.equal(contract.launcherSha256, UPSTASH_MCP_LAUNCHER_SHA256);
    assert.ok(
      contract.runtimePath.startsWith(await realpath(runtimeDirectory)),
    );
    assert.equal(
      verifyUpstashMcpRuntime({ runtimePath: contract.runtimePath }).sha256,
      UPSTASH_MCP_RUNTIME_SHA256,
    );
    const metadata = await stat(contract.runtimePath);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o077, 0);
  } finally {
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("renderer pins the reviewed launcher bytes", () => {
  const launcherPath = resolve(ROOT, LAUNCHER_NAME);
  assert.equal(
    verifyUpstashMcpLauncher({ launcherPath }),
    UPSTASH_MCP_LAUNCHER_SHA256,
  );
});

test("external verifier refuses launcher tampering before importing it", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "upstash-mcp-verifier-"));
  const launcherPath = resolve(fixtureRoot, "upstash-mcp-launcher.mjs");
  const runtimePath = resolve(fixtureRoot, "reviewed-runtime.mjs");
  const sentinel = "must-not-leak";
  try {
    await writeFile(
      launcherPath,
      'export async function launchUpstashMcp() { process.stdout.write("launched"); }\n',
    );
    const launcherSha256 = createHash("sha256")
      .update(await readFile(launcherPath))
      .digest("hex");
    const verifier = buildLauncherVerifier({
      launcherPath,
      launcherSha256,
      runtimePath,
    });
    const reviewedRun = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", verifier],
      { encoding: "utf8", env: { UPSTASH_API_KEY: sentinel } },
    );
    assert.equal(reviewedRun.status, 0, reviewedRun.stderr);
    assert.equal(reviewedRun.stdout, "launched");

    await writeFile(
      launcherPath,
      "process.stdout.write(process.env.UPSTASH_API_KEY); export async function launchUpstashMcp() {}\n",
    );
    const tamperedRun = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", verifier],
      { encoding: "utf8", env: { UPSTASH_API_KEY: sentinel } },
    );
    assert.notEqual(tamperedRun.status, 0);
    assert.equal(tamperedRun.stdout, "");
    assert.doesNotMatch(tamperedRun.stderr, new RegExp(sentinel));
    assert.match(
      tamperedRun.stderr,
      /launcher does not match the reviewed artifact/,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("runtime build closes over every non-builtin server dependency", async () => {
  const runtime = await buildUpstashMcpRuntime();
  assert.equal(runtime.sha256, UPSTASH_MCP_RUNTIME_SHA256);
  for (const dependency of [
    "@modelcontextprotocol+sdk@",
    "commander@14.0.3",
    "dotenv@16.6.1",
    "zod@3.25.76",
  ]) {
    assert.ok(
      runtime.inputs.some((input) => input.includes(dependency)),
      `runtime must include ${dependency}`,
    );
  }
  assert.ok(runtime.externalImports.length > 0);
});

test("launcher refuses a changed dependency-closed runtime", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "upstash-mcp-runtime-"));
  const runtimePath = resolve(fixtureRoot, "runtime.mjs");
  try {
    const runtime = await buildUpstashMcpRuntime();
    await writeFile(runtimePath, runtime.bytes, { mode: 0o400 });
    assert.equal(
      verifyUpstashMcpRuntime({ runtimePath }).sha256,
      UPSTASH_MCP_RUNTIME_SHA256,
    );

    await chmod(runtimePath, 0o600);
    await writeFile(
      runtimePath,
      'process.stdout.write(process.env.UPSTASH_API_KEY ?? "missing");\n',
      { mode: 0o600 },
    );
    assert.throws(
      () => verifyUpstashMcpRuntime({ runtimePath }),
      /does not match the reviewed bundle/,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("launcher loader executes the prepared snapshot without workspace dependencies", async () => {
  const runtimeDirectory = await mkdtemp(
    resolve(tmpdir(), "upstash-mcp-runtime-help-"),
  );
  try {
    const runtimePath = await prepareUpstashMcpRuntime({ runtimeDirectory });
    const runtimeBytes = await readFile(runtimePath);
    const result = await executeRuntimeSnapshot(runtimeBytes, "--help");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /--disable-telemetry/);
  } finally {
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("launcher verifies the reviewed installed entrypoint", () => {
  const result = verifyUpstashMcpEntrypoint();
  assert.equal(result.version, PACKAGE_VERSION);
  assert.equal(result.sha256, UPSTASH_MCP_ENTRYPOINT_SHA256);
  assert.ok(result.entrypoint.endsWith("/dist/index.js"));
});

test("launcher rejects a changed entrypoint before spawning it", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "upstash-mcp-launcher-"));
  const packageRoot = resolve(fixtureRoot, "node_modules/@upstash/mcp-server");
  try {
    await mkdir(resolve(packageRoot, "dist"), { recursive: true });
    await writeFile(
      resolve(packageRoot, "package.json"),
      JSON.stringify({
        bin: { "mcp-server": "dist/index.js" },
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
      }),
    );
    await writeFile(resolve(packageRoot, "dist/index.js"), "tampered\n");

    assert.throws(
      () => verifyUpstashMcpEntrypoint({ repoRoot: fixtureRoot }),
      /does not match the reviewed artifact/,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("launcher forwards, escalates, and cleans up termination signals", () => {
  const parent = new EventEmitter();
  const childSignals = [];
  const child = {
    kill(signal) {
      childSignals.push(signal);
    },
  };
  const forwarding = createTerminationForwarder(parent);
  forwarding.attachChild(child);

  parent.emit("SIGTERM");
  assert.equal(parent.listenerCount("SIGTERM"), 1);
  parent.emit("SIGTERM");
  parent.emit("SIGINT");
  assert.deepEqual(childSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(forwarding.getForwardedSignal(), "SIGTERM");

  forwarding.cleanup();
  parent.emit("SIGHUP");
  assert.deepEqual(childSignals, ["SIGTERM", "SIGKILL"]);
});

test("launcher queues termination signals before the child attaches", () => {
  const parent = new EventEmitter();
  const childSignals = [];
  const forwarding = createTerminationForwarder(parent);

  parent.emit("SIGTERM");
  forwarding.attachChild({
    kill(signal) {
      childSignals.push(signal);
    },
  });

  assert.deepEqual(childSignals, ["SIGTERM"]);
  forwarding.cleanup();
});

test("shared project config stays valid without a partial Upstash entry", async () => {
  const source = await readFile(resolve(ROOT, ".codex/config.toml"), "utf8");
  assertCloudSafeProjectConfig(source);
});

test("workspace dependency and lockfile pin the reviewed artifact", async () => {
  const [packageSource, lockSource] = await Promise.all([
    readFile(resolve(ROOT, "package.json"), "utf8"),
    readFile(resolve(ROOT, "pnpm-lock.yaml"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  const lockfile = yaml.load(lockSource);
  const importer = lockfile.importers["."].devDependencies[PACKAGE_NAME];
  const artifact = lockfile.packages[PINNED_PACKAGE];

  assert.equal(packageJson.devDependencies[PACKAGE_NAME], PACKAGE_VERSION);
  assert.equal(packageJson.devDependencies.esbuild, ESBUILD_VERSION);
  assert.equal(importer.specifier, PACKAGE_VERSION);
  assert.equal(importer.version, PACKAGE_VERSION);
  assert.equal(
    lockfile.importers["."].devDependencies.esbuild.specifier,
    ESBUILD_VERSION,
  );
  assert.equal(artifact.resolution.integrity, PACKAGE_INTEGRITY);
  assert.equal(artifact.hasBin, true);
});

test("operator and upload guidance carry the pin, ownership, and Cloud boundary", async () => {
  const [operator, upload] = await Promise.all([
    readFile(resolve(ROOT, "docs/notes/upstash-mcp-operator.md"), "utf8"),
    readFile(
      resolve(ROOT, ".agents/skills/forensic-report/references/upload.md"),
      "utf8",
    ),
  ]);

  assert.ok(operator.includes(PINNED_PACKAGE));
  assert.match(operator, /sha512-LN5yao74QQZTjGmo/);
  assert.match(operator, /explicit human approval/i);
  assert.match(operator, /Codex Cloud/);
  assert.match(operator, /scripts\/upstash-mcp-config\.test\.mjs/);
  assert.match(upload, /upstash-mcp-operator\.md/);
  for (const tool of EXPECTED_TOOLS) assert.match(upload, new RegExp(tool));
});

test("contract rejects direct launchers and credential-bearing arguments", () => {
  const safe = renderUpstashMcpConfig({
    launcherPath: "/reviewed/repo/scripts/upstash-mcp-launcher.mjs",
    nodePath: "/reviewed/node",
    runtimePath: "/reviewed/personal/upstash-runtime.mjs",
  });

  assert.throws(() =>
    assertPersonalExample(
      safe.replace('command = "/reviewed/node"', 'command = "npx"'),
    ),
  );
  assert.throws(() =>
    assertPersonalExample(
      safe.replace(
        '"--input-type=module","--eval"',
        '"--email","operator@example.com","--api-key","secret"',
      ),
    ),
  );
});

test("contract rejects a shared enabled-only Upstash toggle", () => {
  assert.throws(() =>
    assertCloudSafeProjectConfig("[mcp_servers.upstash]\nenabled = true\n"),
  );
});

test("contract rejects a shared dotted-key Upstash toggle", () => {
  assert.throws(() =>
    assertCloudSafeProjectConfig("mcp_servers.upstash.enabled = true\n"),
  );
});

test("contract rejects quoted and inline-table shared Upstash entries", () => {
  assert.throws(() =>
    assertCloudSafeProjectConfig('[mcp_servers."upstash"]\nenabled = true\n'),
  );
  assert.throws(() =>
    assertCloudSafeProjectConfig(
      "mcp_servers = { upstash = { enabled = true } }\n",
    ),
  );
});
