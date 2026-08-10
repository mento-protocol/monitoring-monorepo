import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@upstash/mcp-server";
const PACKAGE_VERSION = "0.2.4";
const PINNED_PACKAGE = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
const PACKAGE_INTEGRITY =
  "sha512-LN5yao74QQZTjGmolGqAh9YkQa/206ni94wwTtu6I/mVkyMeAbRME7rjK64KrWmCTw2OHUb8TMFsw6r4rMmUSQ==";
const PACKAGE_ENTRYPOINT = "node_modules/@upstash/mcp-server/dist/index.js";
const EXPECTED_ARGS = [PACKAGE_ENTRYPOINT, "--disable-telemetry"];
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

function assertPersonalExample(source) {
  assert.match(source, /^\[mcp_servers\.upstash\]$/m);
  assert.match(source, /^command\s*=\s*"node"$/m);
  assert.match(source, /^enabled\s*=\s*false$/m);
  assert.match(source, /^default_tools_approval_mode\s*=\s*"prompt"$/m);
  assert.match(
    source,
    /^\[mcp_servers\.upstash\.tools\.redis_database_run_redis_commands\]$/m,
  );
  assert.match(source, /^approval_mode\s*=\s*"prompt"$/m);
  assert.deepEqual(tomlArray(source, "args"), EXPECTED_ARGS);
  assert.deepEqual(tomlArray(source, "env_vars"), EXPECTED_ENV_VARS);
  assert.deepEqual(tomlArray(source, "enabled_tools"), EXPECTED_TOOLS);

  assert.doesNotMatch(source, /@upstash\/mcp-server@latest/);
  assert.doesNotMatch(source, /\bnpx\b/);
  assert.doesNotMatch(source, /\bpnpm\s+(?:dlx|exec)\b/);
  assert.doesNotMatch(source, /(?:--email|--api-key|--box-api-key)/);
  assert.doesNotMatch(source, /^env\s*=/m);
  assert.doesNotMatch(source, /^\[mcp_servers\.upstash\.env\]$/m);
  assert.doesNotMatch(source, /UPSTASH_(?:EMAIL|API_KEY)\s*=/);
}

function assertCloudSafeProjectConfig(source) {
  assert.doesNotMatch(
    source,
    /^\[mcp_servers\.upstash(?:\.|\])/m,
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
  const safe = `
[mcp_servers.upstash]
args = ["${PACKAGE_ENTRYPOINT}", "--disable-telemetry"]
command = "node"
default_tools_approval_mode = "prompt"
enabled = false
enabled_tools = ["${EXPECTED_TOOLS.join('", "')}"]
env_vars = ["${EXPECTED_ENV_VARS.join('", "')}"]

[mcp_servers.upstash.tools.redis_database_run_redis_commands]
approval_mode = "prompt"
`;

  assert.throws(() =>
    assertPersonalExample(safe.replace('command = "node"', 'command = "npx"')),
  );
  assert.throws(() =>
    assertPersonalExample(
      safe.replace(
        '"--disable-telemetry"',
        '"--email", "operator@example.com", "--api-key", "secret"',
      ),
    ),
  );
});

test("contract rejects a shared enabled-only Upstash toggle", () => {
  assert.throws(() =>
    assertCloudSafeProjectConfig("[mcp_servers.upstash]\nenabled = true\n"),
  );
});
