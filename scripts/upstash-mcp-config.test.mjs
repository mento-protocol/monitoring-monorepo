import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parse as parseToml } from "smol-toml";
import {
  createTerminationForwarder,
  UPSTASH_MCP_ENTRYPOINT_SHA256,
  verifyUpstashMcpEntrypoint,
} from "./upstash-mcp-launcher.mjs";
import {
  renderLocalUpstashMcpConfig,
  renderUpstashMcpConfig,
} from "./render-upstash-mcp-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@upstash/mcp-server";
const PACKAGE_VERSION = "0.2.4";
const PINNED_PACKAGE = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
const PACKAGE_INTEGRITY =
  "sha512-LN5yao74QQZTjGmolGqAh9YkQa/206ni94wwTtu6I/mVkyMeAbRME7rjK64KrWmCTw2OHUb8TMFsw6r4rMmUSQ==";
const LAUNCHER_NAME = "scripts/upstash-mcp-launcher.mjs";
const EXPECTED_ENV_VARS = ["UPSTASH_EMAIL", "UPSTASH_API_KEY"];
const EXPECTED_TOOLS = [
  "redis_database_list_databases",
  "redis_database_run_redis_commands",
];

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
  assert.equal(args.length, 1);
  assert.ok(isAbsolute(args[0]), "Upstash launcher must use an absolute path");
  assert.ok(args[0].endsWith(LAUNCHER_NAME));
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

test("renderer anchors both executables independently of the launch directory", () => {
  const source = renderLocalUpstashMcpConfig();
  assertPersonalExample(source);
  assert.equal(
    tomlString(source, "command"),
    resolve(tomlString(source, "command")),
  );
  assert.equal(tomlArray(source, "args")[0], resolve(ROOT, LAUNCHER_NAME));
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
  assert.equal(importer.specifier, PACKAGE_VERSION);
  assert.equal(importer.version, PACKAGE_VERSION);
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

test("contract rejects mutable launchers and credential-bearing arguments", () => {
  const safe = renderUpstashMcpConfig({
    launcherPath: "/reviewed/repo/scripts/upstash-mcp-launcher.mjs",
    nodePath: "/reviewed/node",
  });

  assert.throws(() =>
    assertPersonalExample(
      safe.replace('command = "/reviewed/node"', 'command = "npx"'),
    ),
  );
  assert.throws(() =>
    assertPersonalExample(
      safe.replace(
        'args = ["/reviewed/repo/scripts/upstash-mcp-launcher.mjs"]',
        'args = ["--email", "operator@example.com", "--api-key", "secret"]',
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
