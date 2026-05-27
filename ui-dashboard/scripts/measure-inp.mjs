#!/usr/bin/env node
// Measure Interaction-to-Next-Paint (INP) for the dashboard's interactive
// surface and fail closed on a regression beyond INP_BUDGET_MS.
//
// Why not Lighthouse user-flow:
//   Lighthouse's timespan mode estimates INP from main-thread timing in a
//   lab profile; web-vitals uses the same PerformanceEventTiming + Event
//   Timing API the browser surfaces to real users via RUM. The numbers
//   are directly comparable to the INP a real user would see, which is
//   what the CWV gate cares about. The Playwright+web-vitals path also
//   reuses the @playwright/test chromium the dashboard already installs
//   for browser tests — no new puppeteer / chrome-launcher / lighthouse
//   deps in the workspace.
//
// Required env:
//   PREVIEW_URL          — Vercel preview URL (no trailing slash)
//   BYPASS_HEADERS_JSON  — JSON object with both bypass headers
//                          (`x-vercel-protection-bypass` + `x-vercel-set-bypass-cookie`).
//                          Built by the workflow shell from BYPASS_SECRET so the raw
//                          secret never reaches PR-controlled Node code — matches the
//                          lhci step's `unset BYPASS_SECRET` pattern.
//   INP_BUDGET_MS        — optional, default 200 (web-vitals "good" threshold).
//
// Exit codes:
//   0 — INP ≤ budget.
//   1 — INP > budget, no measurement captured, chromium / network failure,
//       or any other failure. Fail-closed: a silently absent metric means
//       the gate isn't validating anything, so the workflow should fail
//       loudly rather than green-light an unverifiable run.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PREVIEW_URL = process.env.PREVIEW_URL;
const BYPASS_HEADERS_JSON = process.env.BYPASS_HEADERS_JSON;
const INP_BUDGET_MS = Number(process.env.INP_BUDGET_MS ?? 200);

if (!PREVIEW_URL || !BYPASS_HEADERS_JSON) {
  console.error(
    "::error::PREVIEW_URL and BYPASS_HEADERS_JSON env vars required",
  );
  process.exit(1);
}

let bypassHeaders;
try {
  bypassHeaders = JSON.parse(BYPASS_HEADERS_JSON);
} catch (err) {
  console.error(
    `::error::BYPASS_HEADERS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

if (!Number.isFinite(INP_BUDGET_MS) || INP_BUDGET_MS <= 0) {
  console.error(
    `::error::INP_BUDGET_MS must be a positive number; got ${process.env.INP_BUDGET_MS}`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const webVitalsIife = resolve(
  here,
  "..",
  "node_modules",
  "web-vitals",
  "dist",
  "web-vitals.iife.js",
);

const browser = await chromium.launch({ headless: true });
let exitCode = 0;
try {
  // `bypassCSP: true` is required because the dashboard ships a nonce-based
  // CSP (`script-src 'self' 'nonce-…'`, no `'unsafe-inline'`, see
  // `ui-dashboard/src/lib/csp.ts`). `page.addScriptTag({ path })` injects
  // an un-nonced inline `<script>` element that Chromium would otherwise
  // block, leaving `window.webVitals` undefined and the INP read NaN.
  // The bypass only affects the test context; the served dashboard's CSP
  // is unchanged.
  const context = await browser.newContext({
    bypassCSP: true,
    extraHTTPHeaders: bypassHeaders,
  });
  const page = await context.newPage();

  await page.goto(`${PREVIEW_URL}/pools`, {
    waitUntil: "load",
    timeout: 30_000,
  });

  // Sanity-check we landed on the dashboard, not the Vercel SSO interstitial.
  // Mirrors the audited-page guard in .github/workflows/lighthouse.yml so a
  // bypass regression fails this step too, not just the lhci accessibility
  // assertion.
  const landedUrl = page.url();
  if (landedUrl.includes("vercel.com/login")) {
    console.error(
      `::error::Landed on Vercel SSO interstitial (${landedUrl}) — deployment-protection bypass likely regressed.`,
    );
    exitCode = 1;
    throw new Error("SSO interstitial");
  }

  // Inject web-vitals' IIFE bundle so the page exposes window.webVitals.onINP.
  await page.addScriptTag({ path: webVitalsIife });

  await page.evaluate(() => {
    window.__inp = null;
    // onINP fires either when the page is hidden OR when web-vitals' internal
    // settling logic decides the interaction's reported duration is final.
    window.webVitals.onINP((metric) => {
      window.__inp = metric.value;
    });
  });

  // Wait for the dashboard's filter input to render — it's part of the
  // /pools client-rendered shell and proves the page hydrated past the SSR
  // skeleton.
  const filterInput =
    'input[aria-label="Filter swaps by pool ID or pool address"]';
  await page.waitForSelector(filterInput, { timeout: 20_000 });

  // Scripted interaction sequence: focus the input, type a filter value
  // via real keydown/keyup events, click Apply. `pressSequentially()` sends
  // real key events (each one is a qualifying Event-Timing-API interaction);
  // `page.fill()` would only fire a single synthetic `input` event, which
  // wouldn't surface typing latency to web-vitals.
  await page.click(filterInput);
  await page
    .locator(filterInput)
    .pressSequentially("0x0000000000000000000000000000000000000000", {
      delay: 20,
    });
  await page.click('button:has-text("Apply")');

  // Force web-vitals to flush by hiding the page (its `onINP` reports on
  // visibility change). Wait briefly for the visibility handler.
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await page
    .waitForFunction(() => window.__inp !== null, { timeout: 5_000 })
    .catch(() => {});

  const inp = await page.evaluate(() => window.__inp);

  if (inp === null) {
    console.error(
      "::error::No INP measurement captured — web-vitals didn't observe a qualifying interaction inside the read window. Failing closed: a silently absent metric means the gate isn't validating anything (web-vitals API change, broken flush, or unqualifying interaction). Investigate before re-running.",
    );
    exitCode = 1;
  } else if (inp > INP_BUDGET_MS) {
    console.error(
      `::error::INP regression: ${inp.toFixed(1)}ms > ${INP_BUDGET_MS}ms budget`,
    );
    exitCode = 1;
  } else {
    console.log(
      `INP measurement: ${inp.toFixed(1)}ms (budget: ${INP_BUDGET_MS}ms) — passed`,
    );
  }
} catch (err) {
  if (exitCode === 0) {
    console.error(
      `::error::INP measurement failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    exitCode = 1;
  }
} finally {
  await browser.close();
}

process.exit(exitCode);
