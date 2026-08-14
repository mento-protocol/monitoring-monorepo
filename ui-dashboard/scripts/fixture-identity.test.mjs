import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFixtureApp } from "./fixture-build.mjs";
import { identityHealthUrl } from "./fixture-constants.mjs";
import {
  currentFixtureBuildHash,
  currentFixtureServerIdentity,
  fixtureBuildDecision,
  fixtureServerRuntimeOptions,
  invalidateFixtureBuildIdentity,
  probeFixtureServer,
} from "./fixture-identity.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function temporaryBuild({ buildId = true, identity } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fixture-identity-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  if (buildId) await writeFile(join(dir, "BUILD_ID"), "build-id\n");
  if (identity !== undefined) {
    await writeFile(join(dir, "fixture-identity.json"), identity);
  }
  return dir;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("invalid json");
      return body;
    },
  };
}

describe("fixture build identity", () => {
  it("uses Turbo's exact fixture-build input hash", async () => {
    await expect(currentFixtureBuildHash()).resolves.toMatch(/^[a-f0-9]{16}$/);
  });

  it("reuses a complete build only when Turbo's current task hash matches", async () => {
    const distDir = await temporaryBuild({
      identity: JSON.stringify({ fixtureBuildHash: "current" }),
    });

    await expect(
      fixtureBuildDecision({ distDir, expectedHash: "current" }),
    ).resolves.toEqual({ action: "reuse", reason: "identity-match" });
  });

  it.each([
    ["changed source", JSON.stringify({ fixtureBuildHash: "stale" })],
    ["missing identity", undefined],
    ["unverifiable identity", "not json"],
  ])("rebuilds for %s", async (_, identity) => {
    const distDir = await temporaryBuild({ identity });

    await expect(
      fixtureBuildDecision({ distDir, expectedHash: "current" }),
    ).resolves.toMatchObject({ action: "rebuild" });
  });

  it("rebuilds an incomplete fixture dist dir", async () => {
    const distDir = await temporaryBuild({ buildId: false });

    await expect(
      fixtureBuildDecision({ distDir, expectedHash: "current" }),
    ).resolves.toEqual({ action: "rebuild", reason: "missing-build" });
  });

  it("invalidates old authority before a rebuild starts", async () => {
    const distDir = await temporaryBuild({
      identity: JSON.stringify({ fixtureBuildHash: "current" }),
    });

    await invalidateFixtureBuildIdentity(distDir);

    await expect(
      access(join(distDir, "fixture-identity.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fixtureBuildDecision({ distDir, expectedHash: "current" }),
    ).resolves.toEqual({
      action: "rebuild",
      reason: "identity-unverifiable",
    });
  });

  it("keeps a failed rebuild unauthoritative", async () => {
    const distDir = await temporaryBuild({
      identity: JSON.stringify({ fixtureBuildHash: "stale" }),
    });
    let identityWasInvalidatedBeforeBuild = false;

    const exitCode = await buildFixtureApp({
      fixtureBuildHash: "current",
      distDir,
      runBuild: async () => {
        identityWasInvalidatedBeforeBuild = await access(
          join(distDir, "fixture-identity.json"),
        ).then(
          () => false,
          (error) => error.code === "ENOENT",
        );
        return 1;
      },
    });

    expect(exitCode).toBe(1);
    expect(identityWasInvalidatedBeforeBuild).toBe(true);
    await expect(
      access(join(distDir, "fixture-identity.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authorizes a successful rebuild with the hash used for its output", async () => {
    const distDir = await temporaryBuild({
      identity: JSON.stringify({ fixtureBuildHash: "stale" }),
    });

    const exitCode = await buildFixtureApp({
      fixtureBuildHash: "current",
      distDir,
      runBuild: async (env) => {
        expect(env.NEXT_DIST_DIR).toBe(distDir);
        await expect(
          access(join(distDir, "fixture-identity.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    await expect(
      readFile(join(distDir, "fixture-identity.json"), "utf8"),
    ).resolves.toBe('{"fixtureBuildHash":"current"}\n');
  });
});

describe("fixture server identity", () => {
  it("uses an identity-qualified path that legacy servers cannot mistake for health", () => {
    expect(identityHealthUrl("http://127.0.0.1:3211", "current")).toBe(
      "http://127.0.0.1:3211/health/current",
    );
  });

  it("reuses a healthy server only when its source identity matches", async () => {
    await expect(
      probeFixtureServer({
        healthUrl: "http://127.0.0.1:3211/health",
        expectedIdentity: "current",
        fetchImpl: async () =>
          response({ ok: true, fixtureServerIdentity: "current" }),
      }),
    ).resolves.toEqual({ action: "reuse", reason: "identity-match" });
  });

  it("binds reuse identity to runtime scenario and delay", async () => {
    const baseline = await currentFixtureServerIdentity();

    await expect(
      currentFixtureServerIdentity({ scenario: "lighthouse-pool" }),
    ).resolves.not.toBe(baseline);
    await expect(
      currentFixtureServerIdentity({ clientDelayMs: 2_200 }),
    ).resolves.not.toBe(baseline);
  });

  it("normalizes the runner and server runtime identity from non-default env values", async () => {
    const runtimeOptions = fixtureServerRuntimeOptions({
      scenario: "lighthouse-pool",
      clientDelayMs: "2200",
    });

    expect(runtimeOptions).toEqual({
      scenario: "lighthouse-pool",
      clientDelayMs: 2200,
    });
    await expect(currentFixtureServerIdentity(runtimeOptions)).resolves.toBe(
      await currentFixtureServerIdentity({
        scenario: "lighthouse-pool",
        clientDelayMs: 2200,
      }),
    );
  });

  it.each([
    [{ scenario: "typo" }, "Unknown Hasura fixture scenario: typo"],
    [
      { clientDelayMs: "1.5" },
      "HASURA_FIXTURE_CLIENT_DELAY_MS must be a non-negative integer, got 1.5",
    ],
  ])("rejects invalid fixture server runtime options", (options, message) => {
    expect(() => fixtureServerRuntimeOptions(options)).toThrow(message);
  });

  it.each([
    ["mismatched", { ok: true, fixtureServerIdentity: "stale" }],
    ["missing", { ok: true }],
    ["unverifiable", "not json"],
  ])("refuses a %s live server", async (_, body) => {
    await expect(
      probeFixtureServer({
        healthUrl: "http://127.0.0.1:3211/health",
        expectedIdentity: "current",
        fetchImpl: async () => response(body),
      }),
    ).resolves.toMatchObject({ action: "refuse" });
  });

  it("starts a server when the fixed port is not in use", async () => {
    await expect(
      probeFixtureServer({
        healthUrl: "http://127.0.0.1:1/health",
        expectedIdentity: "current",
        fetchImpl: async () =>
          Promise.reject(
            new TypeError("fetch failed", {
              cause: { code: "ECONNREFUSED" },
            }),
          ),
      }),
    ).resolves.toEqual({ action: "start", reason: "not-running" });
  });
});
