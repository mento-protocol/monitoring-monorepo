#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assert,
  CANONICAL_POOL_PATH,
  CLIENT_BREAKER_DELAY_MS,
  dashboardRoot,
  FIXTURE_SCENARIO,
  fixtureScript,
  log,
  MINIMUM_DELAYED_BREAKER_REQUESTS,
  TARGET_QUERY,
} from "./pool-lighthouse/contract.mjs";
import {
  assertBrowserRevalidation,
  assertFixtureHealthy,
  assertRawServerHtml,
  chromePath,
} from "./pool-lighthouse/fixture-browser.mjs";
import { runLighthouse } from "./pool-lighthouse/lhci-orchestration.mjs";
import {
  captureNextFiles,
  cliOptions,
  prepareOutput,
  restoreNextFiles,
  usage,
  writeRunnerError,
} from "./pool-lighthouse/runner-lifecycle.mjs";
import {
  findFreePort,
  installSignalHandlers,
  runCommand,
  spawnChild,
  stopAllChildren,
  waitForUrl,
} from "./pool-lighthouse/subprocess.mjs";

async function main() {
  const options = cliOptions();
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  installSignalHandlers();
  await prepareOutput(options.outputDir);
  const nextFiles = await captureNextFiles();
  let tempRoot;
  try {
    tempRoot = await mkdtemp(join(tmpdir(), "mento-pool-lhci-"));
    const configuredHasura = options.skipBuild
      ? process.env.NEXT_PUBLIC_HASURA_URL
      : undefined;
    assert(
      !options.skipBuild || configuredHasura,
      "--skip-build requires NEXT_PUBLIC_HASURA_URL from the existing build",
    );
    const configuredFixture = configuredHasura
      ? new URL(configuredHasura)
      : null;
    const fixturePort = configuredFixture
      ? Number(configuredFixture.port)
      : await findFreePort();
    assert(
      !configuredFixture ||
        (configuredFixture.hostname === "127.0.0.1" &&
          configuredFixture.pathname === "/graphql" &&
          fixturePort > 0),
      "--skip-build NEXT_PUBLIC_HASURA_URL must be http://127.0.0.1:<port>/graphql",
    );
    const nextPort = await findFreePort([fixturePort]);
    const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
    const nextUrl = `http://127.0.0.1:${nextPort}`;
    const targetUrl = `${nextUrl}${CANONICAL_POOL_PATH}?${TARGET_QUERY}`;
    const appEnv = {
      ...process.env,
      NEXT_PUBLIC_HASURA_URL: `${fixtureUrl}/graphql`,
      NEXT_PUBLIC_BROWSER_TEST_FIXTURES: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const executablePath = chromePath();
    const fixture = spawnChild(
      process.execPath,
      [fixtureScript, "--port", String(fixturePort)],
      {
        cwd: dashboardRoot,
        env: {
          ...process.env,
          HASURA_FIXTURE_SCENARIO: FIXTURE_SCENARIO,
          HASURA_FIXTURE_CLIENT_DELAY_MS: String(CLIENT_BREAKER_DELAY_MS),
        },
      },
    );
    await waitForUrl(`${fixtureUrl}/health`, fixture, 15_000);

    if (!options.skipBuild) {
      log("Building ui-dashboard production bundle against fixture Hasura");
      await runCommand("pnpm", ["build"], {
        cwd: dashboardRoot,
        env: appEnv,
      });
    } else {
      assert(
        existsSync(resolve(dashboardRoot, ".next/BUILD_ID")),
        "--skip-build requires an existing production .next build",
      );
      log("Reusing existing ui-dashboard production build");
    }

    const next = spawnChild(
      "pnpm",
      ["start", "--hostname", "127.0.0.1", "--port", String(nextPort)],
      { cwd: dashboardRoot, env: appEnv },
    );
    await waitForUrl(nextUrl, next, 120_000);
    await assertRawServerHtml(targetUrl);
    await assertBrowserRevalidation({
      targetUrl,
      fixtureUrl,
      executablePath,
    });
    await assertFixtureHealthy(fixtureUrl, "during the browser smoke", 1);
    await runLighthouse({
      targetUrl,
      outputDir: options.outputDir,
      executablePath,
      tempRoot,
    });
    await assertFixtureHealthy(
      fixtureUrl,
      "during Lighthouse collection",
      MINIMUM_DELAYED_BREAKER_REQUESTS,
      { allowAdditionalDelayedRequests: true },
    );
    log(`Artifacts written to ${options.outputDir}`);
  } catch (error) {
    await writeRunnerError(options.outputDir, error);
    throw error;
  } finally {
    await stopAllChildren();
    try {
      await restoreNextFiles(nextFiles);
    } finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode ||= 1;
}
