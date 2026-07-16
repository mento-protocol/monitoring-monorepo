import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  assert,
  EXPECTED_BREAKER_QUERY,
  EXPECTED_BREAKER_TEXT,
  EXPECTED_VOLUME_TEXT,
  FIXTURE_GRAPHQL_DELAY_FLOOR_MS,
  log,
  normalizeText,
} from "./contract.mjs";

function visibleHtmlText(html) {
  return normalizeText(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " "),
  );
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

export async function assertFixtureHealthy(
  fixtureUrl,
  phase,
  expectedDelayedBreakerRequests,
  { allowAdditionalDelayedRequests = false } = {},
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
  const delayedPoolBreakerCount = health?.delayedPoolBreakerCount;
  assert(
    Number.isInteger(delayedPoolBreakerCount) && delayedPoolBreakerCount >= 0,
    `Fixture health returned invalid delayedPoolBreakerCount: ${delayedPoolBreakerCount ?? "missing"}`,
  );
  if (allowAdditionalDelayedRequests) {
    assert(
      delayedPoolBreakerCount >= expectedDelayedBreakerRequests,
      `Fixture completed ${delayedPoolBreakerCount ?? "unknown"} delayed PoolBreakerConfig request(s) ${phase}; expected at least ${expectedDelayedBreakerRequests} (additional valid client retries or prefetches are allowed)`,
    );
    log(
      `Fixture completed ${delayedPoolBreakerCount} delayed PoolBreakerConfig request(s) ${phase}; required minimum ${expectedDelayedBreakerRequests}`,
    );
    return;
  }
  assert(
    delayedPoolBreakerCount === expectedDelayedBreakerRequests,
    `Fixture completed ${delayedPoolBreakerCount ?? "unknown"} delayed PoolBreakerConfig request(s) ${phase}; expected exactly ${expectedDelayedBreakerRequests}`,
  );
  log(
    `Fixture completed exactly ${delayedPoolBreakerCount} delayed PoolBreakerConfig request(s) ${phase}`,
  );
}

export async function assertRawServerHtml(targetUrl) {
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

export function chromePath() {
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

export async function assertBrowserRevalidation({
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
      delayMs > FIXTURE_GRAPHQL_DELAY_FLOOR_MS,
      `Browser PoolBreakerConfig delay was ${delayMs}ms, expected >${FIXTURE_GRAPHQL_DELAY_FLOOR_MS}ms`,
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
