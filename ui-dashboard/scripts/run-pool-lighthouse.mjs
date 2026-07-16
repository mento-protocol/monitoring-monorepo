#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(scriptDir, "..");
const repoRoot = resolve(dashboardRoot, "..");
const fixtureScript = resolve(
  dashboardRoot,
  "tests/browser/fixtures/hasura-fixture-server.mjs",
);
const diagnosticsScript = resolve(
  dashboardRoot,
  "scripts/lighthouse-pool-diagnostics.mjs",
);
const lighthouseConfig = resolve(repoRoot, ".lighthouserc.cjs");
const nextEnvPath = resolve(dashboardRoot, "next-env.d.ts");
const nextDevPath = resolve(dashboardRoot, ".next/dev");
const defaultOutputDir = resolve(dashboardRoot, "reports/lighthouse-pool");

const CANONICAL_POOL_PATH =
  "/pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
const TARGET_QUERY = "lhci=fixture";
const FIXTURE_SCENARIO = "lighthouse-pool";
const CLIENT_BREAKER_DELAY_MS = 2200;
const EXPECTED_BREAKER_TEXT = "ref 1.171560 / actual 1.175000";
const EXPECTED_VOLUME_TEXT = "$125.00";
const EXPECTED_BREAKER_QUERY = "query PoolBreakerConfig";
const EXPECTED_RUNS = 3;
const EXPECTED_DELAYED_BREAKER_REQUESTS = EXPECTED_RUNS + 1;
const children = new Set();
let shutdownStarted = false;
function usage() {
  return `Usage: node ui-dashboard/scripts/run-pool-lighthouse.mjs [options]

Options:
  --output-dir <path>  Artifact root (default: ui-dashboard/reports/lighthouse-pool)
  --skip-build         Reuse a build compiled for $NEXT_PUBLIC_HASURA_URL
  --help               Show this help
`;
}

function cliOptions() {
  const { values } = parseArgs({
    options: {
      "output-dir": { type: "string" },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    help: values.help,
    outputDir: resolve(values["output-dir"] ?? defaultOutputDir),
    skipBuild: values["skip-build"],
  };
}

function log(message) {
  process.stdout.write(`[pool-lighthouse] ${message}\n`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function visibleHtmlText(html) {
  return normalizeText(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " "),
  );
}

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function findFreePort(excluded = []) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await allocatePort();
    if (port > 0 && !excluded.includes(port)) return port;
  }
  throw new Error(`Could not allocate a port avoiding ${excluded.join(", ")}`);
}

function spawnChild(command, args, { cwd, env, stdio = "inherit" } = {}) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd,
    env,
    stdio,
    detached,
    shell: false,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveExit({ code: code ?? 1, signal });
    });
  });
}

async function runCommand(
  command,
  args,
  { cwd, env, allowFailure = false } = {},
) {
  const child = spawnChild(command, args, { cwd, env });
  const result = await childExit(child);
  if (!allowFailure && result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.code}${
        result.signal ? ` (${result.signal})` : ""
      }`,
    );
  }
  return result.code;
}

function signalChild(child, signal) {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
    return;
  }
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopChild(child) {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
    return;
  }
  const exited = childExit(child).catch(() => ({ code: 1, signal: null }));
  signalChild(child, "SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 4000)),
  ]);
  if (!graceful) {
    signalChild(child, "SIGKILL");
    await exited;
  }
}

async function stopAllChildren() {
  await Promise.allSettled([...children].map((child) => stopChild(child)));
}

function installSignalHandlers() {
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      process.exitCode = exitCode;
      void stopAllChildren().finally(() => process.exit(exitCode));
    });
  }
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForUrl(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${url} server exited before becoming ready`);
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      if (response.status < 500) return;
    } catch {
      // Keep polling until the child starts or the deadline expires.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function deferred(label, timeoutMs = 15_000) {
  let resolveValue;
  let settled = false;
  let timer;
  const promise = new Promise((resolvePromise, reject) => {
    resolveValue = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
  });
  void promise.catch(() => {});
  return {
    promise,
    resolve: resolveValue,
    get settled() {
      return settled;
    },
  };
}

function requestIsFixtureGraphql(request, fixtureUrl) {
  return (
    request.url() === `${fixtureUrl}/graphql` && request.method() === "POST"
  );
}

function requestIsPoolBreaker(request, fixtureUrl) {
  return (
    requestIsFixtureGraphql(request, fixtureUrl) &&
    (request.postData() ?? "").includes(EXPECTED_BREAKER_QUERY)
  );
}

function requestIsBenignNextPrefetchAbort(request, targetUrl) {
  if (
    request.method() !== "GET" ||
    request.resourceType() !== "fetch" ||
    request.failure()?.errorText !== "net::ERR_ABORTED"
  ) {
    return false;
  }
  try {
    const requestUrl = new URL(request.url());
    return (
      requestUrl.origin === new URL(targetUrl).origin &&
      requestUrl.searchParams.has("_rsc")
    );
  } catch {
    return false;
  }
}

async function assertFixtureHealthy(
  fixtureUrl,
  phase,
  expectedDelayedBreakerRequests,
) {
  const response = await fetch(`${fixtureUrl}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, `Fixture health returned HTTP ${response.status}`);
  const health = await response.json();
  assert(
    health?.ok === true && health?.errorCount === 0,
    `Fixture recorded ${health?.errorCount ?? "unknown"} GraphQL error(s) ${phase}`,
  );
  assert(
    health?.delayedPoolBreakerCount === expectedDelayedBreakerRequests,
    `Fixture completed ${health?.delayedPoolBreakerCount ?? "unknown"} delayed PoolBreakerConfig request(s) ${phase}; expected ${expectedDelayedBreakerRequests}`,
  );
}

async function assertRawServerHtml(targetUrl) {
  const response = await fetch(targetUrl, {
    headers: { "user-agent": "mento-pool-lighthouse-fixture" },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Server HTML returned HTTP ${response.status}`);
  const text = visibleHtmlText(await response.text());
  assert(
    text.includes(EXPECTED_BREAKER_TEXT),
    `Server HTML did not contain "${EXPECTED_BREAKER_TEXT}"`,
  );
  assert(
    text.includes("MedianDelta"),
    "Server HTML did not contain the healthy MedianDelta breaker",
  );
  assert(
    text.includes(`Volume ${EXPECTED_VOLUME_TEXT}`),
    `Server HTML did not contain the exact all-time Volume headline "${EXPECTED_VOLUME_TEXT}"`,
  );
  log(
    `SSR HTML contains "${EXPECTED_BREAKER_TEXT}" and Volume ${EXPECTED_VOLUME_TEXT}`,
  );
}

function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const playwrightChrome = chromium.executablePath();
  assert(
    existsSync(playwrightChrome),
    "Playwright Chromium is missing; run `pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium`",
  );
  return playwrightChrome;
}

async function assertBrowserRevalidation({
  targetUrl,
  fixtureUrl,
  executablePath,
}) {
  const launchArgs =
    process.env.PLAYWRIGHT_FORCE_SINGLE_PROCESS === "true"
      ? ["--single-process"]
      : [];
  const browser = await chromium.launch({ executablePath, args: launchArgs });
  const errors = [];
  const fixtureResponseChecks = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const breakerRequest = deferred("browser PoolBreakerConfig request");
    const breakerResponse = deferred("browser PoolBreakerConfig response");

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(`console: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      errors.push(`page: ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      if (requestIsBenignNextPrefetchAbort(request, targetUrl)) return;
      errors.push(
        `request: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "failed"})`,
      );
    });
    page.on("request", (request) => {
      if (requestIsPoolBreaker(request, fixtureUrl)) {
        breakerRequest.resolve({ request, startedAt: Date.now() });
      }
    });
    page.on("response", (response) => {
      const request = response.request();
      if (requestIsFixtureGraphql(request, fixtureUrl)) {
        fixtureResponseChecks.push(
          (async () => {
            if (!response.ok()) {
              errors.push(
                `graphql: ${request.postData() ?? "unknown operation"} returned HTTP ${response.status()}`,
              );
              return;
            }
            try {
              const body = await response.json();
              if (Array.isArray(body?.errors) && body.errors.length > 0) {
                const messages = body.errors
                  .map((error) => error?.message ?? String(error))
                  .join("; ");
                errors.push(`graphql: ${messages}`);
              }
            } catch (error) {
              errors.push(
                `graphql: invalid JSON response (${error instanceof Error ? error.message : String(error)})`,
              );
            }
          })(),
        );
      }
      if (requestIsPoolBreaker(request, fixtureUrl)) {
        breakerResponse.resolve({ response, finishedAt: Date.now() });
      }
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const value = page
      .locator("span.font-mono")
      .filter({ hasText: EXPECTED_BREAKER_TEXT })
      .first();
    const volumeValue = page
      .locator("section")
      .filter({
        has: page.locator("p.text-sm", { hasText: /^Volume$/ }),
      })
      .first()
      .locator("p.mt-1")
      .first();
    await value.waitFor({ state: "visible", timeout: 10_000 });
    await volumeValue.waitFor({ state: "visible", timeout: 10_000 });
    const initialText = normalizeText((await value.textContent()) ?? "");
    const initialVolumeText = normalizeText(
      (await volumeValue.textContent()) ?? "",
    );
    assert(
      initialText === EXPECTED_BREAKER_TEXT,
      `Unexpected pre-revalidation breaker text: "${initialText}"`,
    );
    assert(
      initialVolumeText === EXPECTED_VOLUME_TEXT,
      `Unexpected server-painted Volume headline: "${initialVolumeText}"`,
    );

    const requestEvent = await breakerRequest.promise;
    assert(
      !breakerResponse.settled,
      "PoolBreakerConfig revalidation completed before the SSR-first-paint assertion",
    );
    const pendingText = normalizeText((await value.textContent()) ?? "");
    const pendingVolumeText = normalizeText(
      (await volumeValue.textContent()) ?? "",
    );
    assert(
      pendingText === EXPECTED_BREAKER_TEXT,
      `Breaker text changed while revalidation was pending: "${pendingText}"`,
    );
    assert(
      pendingVolumeText === EXPECTED_VOLUME_TEXT,
      `Volume headline changed while revalidation was pending: "${pendingVolumeText}"`,
    );

    const responseEvent = await breakerResponse.promise;
    const delayMs = responseEvent.finishedAt - requestEvent.startedAt;
    assert(
      responseEvent.response.ok(),
      `PoolBreakerConfig revalidation returned HTTP ${responseEvent.response.status()}`,
    );
    assert(
      delayMs > 1700,
      `Browser PoolBreakerConfig delay was ${delayMs}ms, expected >1700ms`,
    );
    const responseError = await responseEvent.response.finished();
    assert(
      responseError === null,
      `PoolBreakerConfig response body failed: ${responseError?.message ?? "unknown error"}`,
    );
    await page.waitForLoadState("networkidle", { timeout: 5000 });
    await Promise.all(fixtureResponseChecks);
    const refreshedText = normalizeText((await value.textContent()) ?? "");
    const refreshedVolumeText = normalizeText(
      (await volumeValue.textContent()) ?? "",
    );
    assert(
      refreshedText === EXPECTED_BREAKER_TEXT,
      `Breaker text changed after revalidation: "${refreshedText}"`,
    );
    assert(
      refreshedVolumeText === EXPECTED_VOLUME_TEXT,
      `Volume headline changed after revalidation: "${refreshedVolumeText}"`,
    );
    assert(errors.length === 0, `Browser errors:\n${errors.join("\n")}`);
    log(
      `Browser kept "${EXPECTED_BREAKER_TEXT}" across ${delayMs}ms revalidation`,
    );
    await context.close();
  } finally {
    await browser.close();
  }
}

function lhciExecutable() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@lhci/cli/package.json");
  const packageJson = require(packagePath);
  return resolve(dirname(packagePath), packageJson.bin.lhci);
}

async function prepareOutput(outputDir) {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    rm(join(outputDir, "lhr"), { recursive: true, force: true }),
    rm(join(outputDir, "reports"), { recursive: true, force: true }),
    rm(join(outputDir, "fixture-diagnostics.json"), { force: true }),
    rm(join(outputDir, "fixture-diagnostics.md"), { force: true }),
    rm(join(outputDir, "runner-error.txt"), { force: true }),
  ]);
}

async function copyLhciArtifacts(lhciDir, reportsDir, outputDir) {
  if (existsSync(lhciDir)) {
    await cp(lhciDir, join(outputDir, "lhr"), {
      recursive: true,
      force: true,
    });
  }
  if (existsSync(reportsDir)) {
    await cp(reportsDir, join(outputDir, "reports"), {
      recursive: true,
      force: true,
    });
  }
}

async function assertFixtureLcpContract(lhciDir, targetUrl) {
  const assertionsPath = join(lhciDir, "assertion-results.json");
  assert(
    existsSync(assertionsPath),
    "LHCI did not produce assertion-results.json for the fixture audit",
  );
  let assertions;
  try {
    assertions = JSON.parse(await readFile(assertionsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse fixture assertion results: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    Array.isArray(assertions),
    "Fixture assertion-results.json must contain an array",
  );
  const targetHref = new URL(targetUrl).href;
  const lcpAssertions = assertions.filter(
    (result) =>
      result?.auditId === "largest-contentful-paint" &&
      result?.url === targetHref,
  );
  assert(
    lcpAssertions.length === 1,
    `Expected exactly one fixture LCP assertion for ${targetHref}, found ${lcpAssertions.length}`,
  );
  const [lcp] = lcpAssertions;
  assert(lcp.level === "error", "Fixture LCP assertion must be blocking");
  assert(
    lcp.name === "maxNumericValue" &&
      lcp.operator === "<=" &&
      lcp.expected === 1700,
    `Fixture LCP assertion must enforce <= 1700 ms, got ${lcp.operator ?? "unknown"} ${lcp.expected ?? "unknown"}`,
  );
  assert(
    Array.isArray(lcp.values) &&
      lcp.values.length === EXPECTED_RUNS &&
      lcp.values.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ),
    `Fixture LCP assertion must aggregate ${EXPECTED_RUNS} numeric runs`,
  );
  assert(
    lcp.passed === true,
    `Fixture median LCP ${lcp.actual ?? "unknown"} ms exceeded the 1700 ms ceiling`,
  );
  log(
    `Blocking fixture LCP assertion ran across ${lcp.values.length} values; median ${lcp.actual}ms`,
  );
}

async function runLighthouse({
  targetUrl,
  outputDir,
  executablePath,
  tempRoot,
}) {
  const reportsDir = join(tempRoot, "reports");
  const lhciDir = join(tempRoot, ".lighthouseci");
  await mkdir(reportsDir, { recursive: true });
  let lhciCode = 1;
  let assertCode = 1;
  let assertionError = null;
  try {
    lhciCode = await runCommand(
      process.execPath,
      [
        lhciExecutable(),
        "autorun",
        `--config=${lighthouseConfig}`,
        `--collect.url=${targetUrl}`,
        `--collect.numberOfRuns=${EXPECTED_RUNS}`,
        "--upload.target=filesystem",
        `--upload.outputDir=${reportsDir}`,
      ],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          CHROME_PATH: executablePath,
          CI: "true",
        },
        allowFailure: true,
      },
    );
    assertCode = await runCommand(
      process.execPath,
      [
        lhciExecutable(),
        "assert",
        `--config=${lighthouseConfig}`,
        "--includePassedAssertions=true",
      ],
      {
        cwd: tempRoot,
        env: { ...process.env, CI: "true" },
        allowFailure: true,
      },
    );
    try {
      await assertFixtureLcpContract(lhciDir, targetUrl);
    } catch (error) {
      assertionError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await copyLhciArtifacts(lhciDir, reportsDir, outputDir);
  }

  assert(
    existsSync(join(outputDir, "lhr")),
    "LHCI did not produce a .lighthouseci report directory",
  );
  const diagnosticsCode = await runCommand(
    process.execPath,
    [
      diagnosticsScript,
      "--dir",
      join(outputDir, "lhr"),
      "--path",
      `${CANONICAL_POOL_PATH}?${TARGET_QUERY}`,
      "--expected-runs",
      String(EXPECTED_RUNS),
      "--output-json",
      join(outputDir, "fixture-diagnostics.json"),
      "--output-markdown",
      join(outputDir, "fixture-diagnostics.md"),
    ],
    { cwd: repoRoot, env: process.env, allowFailure: true },
  );
  const failures = [];
  if (lhciCode !== 0) failures.push(`LHCI autorun exited ${lhciCode}`);
  if (assertCode !== 0)
    failures.push(`LHCI fixture assert exited ${assertCode}`);
  if (assertionError !== null) failures.push(assertionError);
  if (diagnosticsCode !== 0) {
    failures.push(`fixture diagnostics exited ${diagnosticsCode}`);
  }
  assert(failures.length === 0, failures.join("; "));
}

async function restoreNextFiles(originalNextEnv, nextEnvExisted) {
  if (nextEnvExisted) await writeFile(nextEnvPath, originalNextEnv);
  else await rm(nextEnvPath, { force: true });
  await rm(nextDevPath, { recursive: true, force: true });
}

async function main() {
  const options = cliOptions();
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  installSignalHandlers();
  await prepareOutput(options.outputDir);
  const nextEnvExisted = existsSync(nextEnvPath);
  const originalNextEnv = nextEnvExisted
    ? await readFile(nextEnvPath, "utf8")
    : "";
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
      EXPECTED_DELAYED_BREAKER_REQUESTS,
    );
    log(`Artifacts written to ${options.outputDir}`);
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : error;
    await writeFile(
      join(options.outputDir, "runner-error.txt"),
      `${String(message)}\n`,
    );
    throw error;
  } finally {
    await stopAllChildren();
    try {
      await restoreNextFiles(originalNextEnv, nextEnvExisted);
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
