import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_DEFAULT_CLIENT_DELAY_MS,
  FIXTURE_DEFAULT_SCENARIO,
  FIXTURE_DIST_DIR,
  FIXTURE_LIGHTHOUSE_SCENARIO,
} from "./fixture-constants.mjs";

export const FIXTURE_BUILD_IDENTITY_FILE = "fixture-identity.json";
const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(dashboardDir, "..");
const fixtureServerSources = [
  resolve(dashboardDir, "tests/browser/fixtures/hasura-fixture-server.mjs"),
  fileURLToPath(import.meta.url),
  resolve(dashboardDir, "scripts/fixture-constants.mjs"),
];

function turboBinary() {
  return process.platform === "win32"
    ? join(repoDir, "node_modules/.bin/turbo.cmd")
    : join(repoDir, "node_modules/.bin/turbo");
}

function capture(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${code ?? 1}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

/** Turbo's fixture-build hash is the source of truth for build freshness. */
export async function currentFixtureBuildHash() {
  const output = await capture(
    turboBinary(),
    [
      "run",
      "fixture-build",
      "--filter=@mento-protocol/ui-dashboard",
      "--dry=json",
    ],
    { cwd: repoDir, env: process.env },
  );
  const summary = JSON.parse(output);
  const task = summary.tasks?.find(
    ({ taskId }) => taskId === "@mento-protocol/ui-dashboard#fixture-build",
  );
  if (typeof task?.hash !== "string" || task.hash.length === 0) {
    throw new Error("Turbo did not report the dashboard fixture-build hash");
  }
  return task.hash;
}

export async function fixtureBuildDecision({
  distDir = resolve(dashboardDir, FIXTURE_DIST_DIR),
  expectedHash,
}) {
  if (!existsSync(join(distDir, "BUILD_ID"))) {
    return { action: "rebuild", reason: "missing-build" };
  }
  try {
    const identity = JSON.parse(
      await readFile(join(distDir, FIXTURE_BUILD_IDENTITY_FILE), "utf8"),
    );
    return identity.fixtureBuildHash === expectedHash
      ? { action: "reuse", reason: "identity-match" }
      : { action: "rebuild", reason: "identity-mismatch" };
  } catch {
    return { action: "rebuild", reason: "identity-unverifiable" };
  }
}

export async function writeFixtureBuildIdentity(
  fixtureBuildHash,
  distDir = resolve(dashboardDir, FIXTURE_DIST_DIR),
) {
  if (typeof fixtureBuildHash !== "string" || fixtureBuildHash.length === 0) {
    throw new Error("fixture build identity is missing");
  }
  await writeFile(
    join(distDir, FIXTURE_BUILD_IDENTITY_FILE),
    `${JSON.stringify({ fixtureBuildHash })}\n`,
  );
}

export async function invalidateFixtureBuildIdentity(
  distDir = resolve(dashboardDir, FIXTURE_DIST_DIR),
) {
  await rm(join(distDir, FIXTURE_BUILD_IDENTITY_FILE), { force: true });
}

export function fixtureServerRuntimeOptions({
  scenario = process.env.HASURA_FIXTURE_SCENARIO,
  clientDelayMs = process.env.HASURA_FIXTURE_CLIENT_DELAY_MS,
} = {}) {
  const normalizedScenario = scenario || FIXTURE_DEFAULT_SCENARIO;
  if (
    normalizedScenario !== FIXTURE_DEFAULT_SCENARIO &&
    normalizedScenario !== FIXTURE_LIGHTHOUSE_SCENARIO
  ) {
    throw new Error(`Unknown Hasura fixture scenario: ${normalizedScenario}`);
  }

  const normalizedClientDelayMs = Number(
    clientDelayMs ?? FIXTURE_DEFAULT_CLIENT_DELAY_MS,
  );
  if (
    !Number.isSafeInteger(normalizedClientDelayMs) ||
    normalizedClientDelayMs < 0
  ) {
    throw new Error(
      `HASURA_FIXTURE_CLIENT_DELAY_MS must be a non-negative integer, got ${clientDelayMs}`,
    );
  }

  return {
    scenario: normalizedScenario,
    clientDelayMs: normalizedClientDelayMs,
  };
}

export async function currentFixtureServerIdentity(runtimeOptions = {}) {
  const { scenario, clientDelayMs } =
    fixtureServerRuntimeOptions(runtimeOptions);
  const hash = createHash("sha256");
  for (const source of fixtureServerSources) {
    const relativePath = source.slice(dashboardDir.length + 1);
    const content = await readFile(source);
    hash.update(`${relativePath}\0${content.byteLength}\0`);
    hash.update(content);
  }
  hash.update(`\0runtime\0${JSON.stringify({ scenario, clientDelayMs })}`);
  return hash.digest("hex");
}

export async function probeFixtureServer({
  healthUrl,
  expectedIdentity,
  fetchImpl = fetch,
}) {
  try {
    const response = await fetchImpl(healthUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1_500),
    });
    let health;
    try {
      health = await response.json();
    } catch {
      return {
        action: "refuse",
        reason: response.ok
          ? "identity-unverifiable"
          : `health-http-${response.status}`,
      };
    }
    if (
      response.ok &&
      health?.ok === true &&
      health.fixtureServerIdentity === expectedIdentity
    ) {
      return { action: "reuse", reason: "identity-match" };
    }
    return {
      action: "refuse",
      reason:
        typeof health?.fixtureServerIdentity === "string" &&
        health.fixtureServerIdentity !== expectedIdentity
          ? "identity-mismatch"
          : response.ok
            ? "identity-unverifiable"
            : `health-http-${response.status}`,
    };
  } catch (error) {
    if (error instanceof TypeError && error.cause?.code === "ECONNREFUSED") {
      return { action: "start", reason: "not-running" };
    }
    return { action: "refuse", reason: "health-unverifiable" };
  }
}
