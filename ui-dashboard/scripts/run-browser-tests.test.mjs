import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { identityHealthUrl } from "./fixture-constants.mjs";
import {
  currentFixtureBuildHash,
  currentFixtureServerIdentity,
  fixtureBuildDecision,
  writeFixtureBuildIdentity,
} from "./fixture-identity.mjs";
import { runBrowserTests } from "./run-browser-tests.mjs";

const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(dashboardDir, "..");
const turboPath = resolve(repoDir, "node_modules/.bin/turbo");
const fixturePort = 3211;
const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function temporaryDirectory(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function playwrightHandoff(calls) {
  return (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
}

async function startFixedPortHealthServer(context, responseForPath) {
  const server = createServer((request, response) => {
    const result = responseForPath(request.url ?? "/");
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  server.listen(fixturePort, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      context.skip(
        `fixed fixture port ${fixturePort} is occupied; refusing to disturb an unowned process`,
      );
      return null;
    }
    throw error;
  }
  cleanup.push(
    () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) =>
          error === undefined ? resolvePromise() : reject(error),
        );
      }),
  );
  return server;
}

async function subprocessHarness() {
  const root = await temporaryDirectory("fixture-runner-subprocess-");
  const binDir = join(root, "bin");
  const logPath = join(root, "playwright-handoff.json");
  const playwrightPath = join(binDir, "playwright");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    playwrightPath,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PLAYWRIGHT_STUB_LOG, JSON.stringify({
  args: process.argv.slice(2),
  fixtureServerIdentity: process.env.PLAYWRIGHT_FIXTURE_SERVER_IDENTITY,
  reuseFixtureServer: process.env.PLAYWRIGHT_REUSE_FIXTURE_SERVER,
  nextCommand: process.env.PLAYWRIGHT_NEXT_COMMAND,
}));
`,
  );
  await chmod(playwrightPath, 0o755);
  const env = {
    ...process.env,
    CI: "true",
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    PLAYWRIGHT_NEXT_COMMAND:
      "pnpm dev --webpack --hostname 127.0.0.1 --port {port}",
    PLAYWRIGHT_NEXT_PORT: "3210",
    PLAYWRIGHT_STUB_LOG: logPath,
  };
  delete env.HASURA_FIXTURE_CLIENT_DELAY_MS;
  delete env.HASURA_FIXTURE_SCENARIO;
  delete env.PLAYWRIGHT_REUSE_FIXTURE_SERVER;
  return { env, logPath };
}

function runRunnerSubprocess(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-browser-tests.mjs", "--grep", "orchestration"],
      {
        cwd: dashboardDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function expectNoPlaywrightHandoff(logPath) {
  await expect(access(logPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function writeTurboWorkspace() {
  const workspaceDir = await temporaryDirectory("fixture-turbo-workspace-");
  await mkdir(join(workspaceDir, "app/src"), { recursive: true });
  await writeFile(
    join(workspaceDir, "package.json"),
    '{"name":"fixture-workspace","private":true,"packageManager":"pnpm@11.9.0"}\n',
  );
  await writeFile(
    join(workspaceDir, "pnpm-workspace.yaml"),
    "packages:\n  - app\n",
  );
  await writeFile(
    join(workspaceDir, "turbo.json"),
    JSON.stringify({
      tasks: {
        "fixture-build": {
          inputs: ["src/**", "package.json"],
          outputs: [".next-fixture/**"],
        },
      },
    }),
  );
  await writeFile(
    join(workspaceDir, "app/package.json"),
    '{"name":"fixture-app","private":true,"scripts":{"fixture-build":"node -e \\\"process.exit(0)\\\""}}\n',
  );
  const inputPath = join(workspaceDir, "app/src/input.txt");
  await writeFile(inputPath, "first\n");
  return { inputPath, workspaceDir };
}

describe("direct browser runner build freshness", () => {
  it("reuses the first direct build and rebuilds the second after a real Turbo input hash change", async () => {
    const { inputPath, workspaceDir } = await writeTurboWorkspace();
    const distDir = await temporaryDirectory("fixture-runner-dist-");
    await writeFile(join(distDir, "BUILD_ID"), "complete\n");
    const hashOptions = {
      workspaceDir,
      turboPath,
      taskId: "fixture-app#fixture-build",
      filter: "fixture-app",
      env: { ...process.env, CI: "true" },
    };
    const firstHash = await currentFixtureBuildHash(hashOptions);
    expect(firstHash).toMatch(/^[a-f0-9]{16}$/);
    await writeFixtureBuildIdentity(firstHash, distDir);
    const builds = [];
    const handoffs = [];
    const common = {
      argv: [],
      env: {
        CI: "true",
        PLAYWRIGHT_NEXT_PORT: "3210",
      },
      buildDecision: ({ expectedHash }) =>
        fixtureBuildDecision({ distDir, expectedHash }),
      buildFixture: async ({ fixtureBuildHash }) => {
        builds.push(fixtureBuildHash);
        await writeFixtureBuildIdentity(fixtureBuildHash, distDir);
        return 0;
      },
      fixtureServerIdentity: async () => "fixture-server",
      probeServer: async () => ({ action: "start", reason: "not-running" }),
      spawnProcess: playwrightHandoff(handoffs),
    };

    expect(
      await runBrowserTests({
        ...common,
        buildHash: () => currentFixtureBuildHash(hashOptions),
      }),
    ).toBe(0);
    expect(builds).toEqual([]);

    await writeFile(inputPath, "second\n");
    const secondHash = await currentFixtureBuildHash(hashOptions);
    expect(secondHash).toMatch(/^[a-f0-9]{16}$/);
    expect(secondHash).not.toBe(firstHash);
    expect(
      await runBrowserTests({
        ...common,
        buildHash: () => currentFixtureBuildHash(hashOptions),
      }),
    ).toBe(0);

    expect(builds).toEqual([secondHash]);
    expect(handoffs).toHaveLength(2);
  });

  it("skips fixture build work for the documented custom Next command", async () => {
    const handoffs = [];
    const nextCommand = "pnpm dev --webpack --hostname 127.0.0.1 --port {port}";
    const env = {
      CI: "true",
      PLAYWRIGHT_NEXT_COMMAND: nextCommand,
      PLAYWRIGHT_NEXT_PORT: "3210",
    };

    expect(
      await runBrowserTests({
        argv: ["--grep", "custom command"],
        env,
        buildHash: () => {
          throw new Error("custom command must not compute a fixture hash");
        },
        buildDecision: () => {
          throw new Error("custom command must not inspect a fixture build");
        },
        buildFixture: () => {
          throw new Error("custom command must not build a fixture app");
        },
        fixtureServerIdentity: async () => "fixture-server",
        probeServer: async () => ({
          action: "reuse",
          reason: "identity-match",
        }),
        spawnProcess: playwrightHandoff(handoffs),
      }),
    ).toBe(0);

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      command: "playwright",
      args: [
        "test",
        "--config=playwright.config.ts",
        "--grep",
        "custom command",
      ],
      env: {
        PLAYWRIGHT_NEXT_COMMAND: nextCommand,
        PLAYWRIGHT_REUSE_FIXTURE_SERVER: "true",
      },
    });
  });
});

describe("fixed-port fixture server orchestration", () => {
  it("hands a matching server and documented custom Next command to Playwright", async (context) => {
    const expectedIdentity = await currentFixtureServerIdentity();
    const server = await startFixedPortHealthServer(context, (path) => ({
      status:
        path ===
        new URL(identityHealthUrl("http://fixture", expectedIdentity)).pathname
          ? 200
          : 409,
      body: { ok: true, fixtureServerIdentity: expectedIdentity },
    }));
    if (server === null) return;
    const { env, logPath } = await subprocessHarness();

    const result = await runRunnerSubprocess(env);
    expect(result).toMatchObject({ code: 0 });
    expect(JSON.parse(await readFile(logPath, "utf8"))).toEqual({
      args: [
        "test",
        "--config=playwright.config.ts",
        "--grep",
        "orchestration",
      ],
      fixtureServerIdentity: expectedIdentity,
      reuseFixtureServer: "true",
      nextCommand: "pnpm dev --webpack --hostname 127.0.0.1 --port {port}",
    });
  });

  it("refuses a live mismatched server without killing it or handing off", async (context) => {
    const server = await startFixedPortHealthServer(context, () => ({
      status: 409,
      body: { ok: true, fixtureServerIdentity: "stale" },
    }));
    if (server === null) return;
    const { env, logPath } = await subprocessHarness();

    const result = await runRunnerSubprocess(env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "refusing fixture server on 3211: identity-mismatch",
    );
    expect(server.listening).toBe(true);
    await expectNoPlaywrightHandoff(logPath);
  });

  it("refuses a live legacy server without killing it or handing off", async (context) => {
    const server = await startFixedPortHealthServer(context, (path) =>
      path === "/health"
        ? { status: 200, body: { ok: true } }
        : { status: 404, body: { error: "not found" } },
    );
    if (server === null) return;
    const { env, logPath } = await subprocessHarness();

    const result = await runRunnerSubprocess(env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "refusing fixture server on 3211: health-http-404",
    );
    expect(server.listening).toBe(true);
    await expectNoPlaywrightHandoff(logPath);
  });

  it("honors explicit reuse opt-out before Playwright handoff", async (context) => {
    const expectedIdentity = await currentFixtureServerIdentity();
    const server = await startFixedPortHealthServer(context, () => ({
      status: 200,
      body: { ok: true, fixtureServerIdentity: expectedIdentity },
    }));
    if (server === null) return;
    const { env, logPath } = await subprocessHarness();
    env.PLAYWRIGHT_REUSE_FIXTURE_SERVER = "false";

    const result = await runRunnerSubprocess(env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "PLAYWRIGHT_REUSE_FIXTURE_SERVER=false; stop it before running",
    );
    expect(server.listening).toBe(true);
    await expectNoPlaywrightHandoff(logPath);
  });
});
